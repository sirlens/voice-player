using System.Diagnostics;
using System.Net;
using System.Speech.Synthesis;
using System.Text;
using System.Text.Json;

string? Arg(string name) => Array.IndexOf(args, name) is var i and >= 0 && i + 1 < args.Length ? args[i + 1] : null;

var port = int.Parse(Arg("--port") ?? "0");
var token = Arg("--token") ?? "";
var parentPid = int.Parse(Arg("--parent-pid") ?? "0");

// Se apaga con el proceso padre, sin sondeo: espera su salida.
_ = Task.Run(async () =>
{
    try { await Process.GetProcessById(parentPid).WaitForExitAsync(); } catch { }
    Environment.Exit(0);
});

var player = new Player();
var listener = new HttpListener();
listener.Prefixes.Add($"http://localhost:{port}/");
try { listener.Start(); }
catch (HttpListenerException) { Environment.Exit(3); }

Console.Out.WriteLine("READY");
Console.Out.Flush();

while (true)
{
    var ctx = await listener.GetContextAsync();
    _ = Task.Run(() => Handle(ctx));
}

void Handle(HttpListenerContext ctx)
{
    string reply;
    int code = 200;
    try
    {
        if (ctx.Request.Headers["X-Voice-Token"] != token) { code = 401; reply = "{\"error\":\"unauthorized\"}"; }
        else
        {
            string body = "";
            if (ctx.Request.HasEntityBody)
                using (var r = new StreamReader(ctx.Request.InputStream, Encoding.UTF8)) body = r.ReadToEnd();
            using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(body) ? "{}" : body);
            reply = player.Dispatch(ctx.Request.Url!.AbsolutePath, doc.RootElement);
        }
    }
    catch (Exception ex) { code = 500; reply = JsonSerializer.Serialize(new { error = ex.Message }); }

    var bytes = Encoding.UTF8.GetBytes(reply);
    ctx.Response.StatusCode = code;
    ctx.Response.ContentType = "application/json";
    ctx.Response.OutputStream.Write(bytes);
    ctx.Response.Close();
}

class Player
{
    readonly object gate = new();
    readonly SpeechSynthesizer synth = new();
    List<string> sentences = new();
    Prompt? current; // la frase vigente: una finalización de otro Prompt es obsoleta
    int index = -1;
    bool paused;
    int rate = 1;
    long startedAt;

    public Player()
    {
        var voice = synth.GetInstalledVoices()
            .FirstOrDefault(v => v.Enabled && (v.VoiceInfo?.Culture?.Name ?? "").StartsWith("es", StringComparison.OrdinalIgnoreCase));
        // Algunas voces llegan sin VoiceInfo: si no hay una española válida se usa la predeterminada.
        if (voice?.VoiceInfo?.Name is { } name) synth.SelectVoice(name);
        synth.SpeakCompleted += (_, e) =>
        {
            lock (gate)
            {
                if (e.Cancelled || e.Prompt != current) return;
                if (index + 1 < sentences.Count) Begin(index + 1); else Finish();
            }
        };
    }

    string Json() => JsonSerializer.Serialize(new
    {
        state = index < 0 ? "idle" : paused ? "paused" : "speaking",
        sentence = index < 0 ? 0 : index + 1,
        total = sentences.Count,
        rate,
    });

    // Imprime el estado para que el cliente lo reciba sin sondear.
    string Publish()
    {
        var json = Json();
        Console.Out.WriteLine("STATE " + json);
        Console.Out.Flush();
        return json;
    }

    void Begin(int i)
    {
        index = i;
        paused = false;
        synth.Rate = rate;
        startedAt = Stopwatch.GetTimestamp();
        current = synth.SpeakAsync(sentences[i]);
        Publish();
    }

    void Finish()
    {
        index = -1;
        paused = false;
        current = null;
        Publish();
    }

    // Un sintetizador en pausa no cancela bien: se reanuda antes de cortar.
    void Cut()
    {
        var wasSpeaking = current != null;
        current = null;
        if (!wasSpeaking) return; // cancelar sin nada en cola dejaba cancelada la frase siguiente
        if (synth.State == SynthesizerState.Paused) synth.Resume();
        synth.SpeakAsyncCancelAll();
    }

    public string Dispatch(string path, JsonElement body)
    {
        lock (gate)
        {
            if (body.TryGetProperty("rate", out var r) && r.TryGetInt32(out var rv)) rate = Math.Clamp(rv, -10, 10);
            switch (path)
            {
                case "/status": return Json();
                case "/speak":
                    Cut();
                    sentences = body.GetProperty("sentences").EnumerateArray().Select(s => s.GetString() ?? "").Where(s => s.Length > 0).ToList();
                    var start = body.TryGetProperty("start", out var st) && st.TryGetInt32(out var sv) ? sv : 0;
                    if (sentences.Count == 0) { Finish(); return Json(); }
                    Begin(Math.Clamp(start, 0, sentences.Count - 1));
                    return Json();
                case "/pause":
                    if (index >= 0 && !paused) { synth.Pause(); paused = true; }
                    return Publish();
                case "/resume":
                    if (index >= 0 && paused) { synth.Resume(); paused = false; }
                    return Publish();
                case "/stop":
                    Cut();
                    Finish();
                    return Json();
                case "/next":
                    if (index >= 0) { Cut(); if (index + 1 < sentences.Count) Begin(index + 1); else Finish(); }
                    return Json();
                case "/prev":
                    // Pasado ~1,5 s de la frase se reinicia; antes, vuelve a la anterior.
                    if (index >= 0)
                    {
                        var elapsed = Stopwatch.GetElapsedTime(startedAt).TotalSeconds;
                        Cut();
                        Begin(elapsed > 1.5 ? index : Math.Max(0, index - 1));
                    }
                    return Json();
                case "/rate": return Publish();
                default: throw new InvalidOperationException("ruta desconocida: " + path);
            }
        }
    }
}
