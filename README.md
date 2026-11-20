# voice-player

**Hear Claude's answers. Fully offline, on your own machine.**

A Claude Code mod that reads every answer aloud with the voices already built into Windows, plus a small player above the prompt: pause, skip sentences, repeat, change speed. No API keys, no cloud speech, no accounts. Windows only.

![The player band above the prompt, reading sentence 2 of 3](assets/player.png)

## Requirements

- Windows 10/11
- [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0)

## Install

```
/plugin install voice-player --marketplace sirlens/voice-player
```

## Use

Buttons: click, or `ctrl+x tab` then the key.

| Key | Action |
|---|---|
| `h` / `l` | Previous / next sentence |
| `p` | Pause / resume |
| `s` | Stop |
| `r` | Repeat last answer |
| `j` / `k` | Slower / faster |
| `o` | On / off |

Command: `/voice-player pause | resume | stop | next | prev | again [n] | rate <-10..10> | on | off | log`

## What it runs

- **First run only:** `dotnet build` compiles the bundled speech server (`server/`), which downloads the `System.Speech` package from NuGet once. After that, nothing goes online.
- **Each session:** starts `voice-player-server.exe`, listening only on `localhost` with a random port and a random token. It exits when Claude Code exits.
- **Each answer:** sends the answer's text (code blocks and links removed) to that local server, which speaks it with Windows' speech engine (SAPI). Text never leaves your machine.
- **Log:** last 200 lines in the plugin's data folder (`/voice-player log`).

## License

MIT
