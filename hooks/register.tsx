import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { Phase, Status } from '../types'

const KEY_ENABLED = 'enabled'
const KEY_RATE = 'rate'
const MAX_CHARS = 20000
const MAX_LOG_LINES = 200
const MIN_SENTENCE = 20
const MAX_START_ATTEMPTS = 5
const REQUEST_TIMEOUT_MS = 4000

const IDLE: Status = { state: 'idle', sentence: 0, total: 0, rate: 1 }

const status = atom({ plugin: 'voice-player', key: 'status' } as const, IDLE)
const phase = atom({ plugin: 'voice-player', key: 'phase' } as const, 'off' as Phase)
const enabled = atom({ plugin: 'voice-player', key: 'enabled' } as const, true)
const rate = atom({ plugin: 'voice-player', key: 'rate' } as const, 1)
const error = atom({ plugin: 'voice-player', key: 'error' } as const, null as string | null)

// ---------- Texto hablable ----------

// Una ruta se oye como su último tramo: "~/.claude/settings.json" -> "settings.json".
const PATH_TOKEN = /(?:[A-Za-z]:|~|\.{1,2})?(?:[\\/][^\s\\/`'"()]+)+[\\/]?/g
const isPath = (token: string) =>
  /^(?:[A-Za-z]:|~|\.)/.test(token) || (token.match(/[\\/]/g) ?? []).length >= 2
const speakPath = (token: string) =>
  isPath(token) ? (token.split(/[\\/]/).filter(Boolean).pop() ?? '') : token

// Quita lo que no tiene sentido oír: código, enlaces, rutas, marcas de Markdown.
export const toSpeech = (markdown: string): string => {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, ' (bloque de código omitido) ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'enlace')
    .replace(PATH_TOKEN, speakPath)
    .replace(/^[ \t]*\|?[-:| ]+\|?[ \t]*$/gm, '')
    .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_, row: string) => `${row.split('|').map(cell => cell.trim()).join(', ')}.`)
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[*_~>]+/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\s+/g, ' ')
    .replace(/([.!?:;,])(\s*\.)+/g, '$1')
    .trim()
  return plain.length > MAX_CHARS ? `${plain.slice(0, MAX_CHARS)}. Respuesta recortada.` : plain
}

// Corta en . ! ? … seguidos de espacio. Un punto seguido de minúscula ("p. ej. usar", "etc. y")
// no cierra frase; los decimales ("3.5") no llevan espacio, así que nunca cortan.
export function splitSentences(text: string): string[] {
  const pieces: string[] = []
  const end = /[.!?…]+["')\]»”]*(?=\s)/g
  let start = 0
  for (let m = end.exec(text); m; m = end.exec(text)) {
    const stop = m.index + m[0].length
    const next = text.slice(stop).trimStart()[0] ?? ''
    if (m[0].startsWith('.') && /\p{Ll}/u.test(next)) continue
    pieces.push(text.slice(start, stop).trim())
    start = stop
  }
  const rest = text.slice(start).trim()
  if (rest) pieces.push(rest)

  // Los fragmentos cortos se pegan a la frase vecina para que no suenen entrecortados.
  const out: string[] = []
  for (const piece of pieces) {
    const previous = out.at(-1)
    if (previous !== undefined && (piece.length < MIN_SENTENCE || previous.length < MIN_SENTENCE)) out[out.length - 1] = `${previous} ${piece}`
    else out.push(piece)
  }
  return out
}

// ---------- Respuestas pasadas ----------

type Block = { type: string; text?: string }
export type ApiMessage = { role: string; content: string | readonly Block[] }

const isToolResultOnly = (message: ApiMessage) =>
  Array.isArray(message.content) &&
  message.content.length > 0 &&
  message.content.every(block => block.type === 'tool_result')

const textOf = (message: ApiMessage) =>
  typeof message.content === 'string'
    ? message.content
    : message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')

// Respuestas finales del chat, de la más reciente a la más antigua:
// por cada turno, el texto del último mensaje del asistente antes del siguiente mensaje del usuario.
export function answersFrom(messages: readonly ApiMessage[]): string[] {
  const answers: string[] = []
  let lastAssistant: ApiMessage | undefined
  const close = () => {
    const text = lastAssistant ? textOf(lastAssistant).trim() : ''
    if (text) answers.push(text)
    lastAssistant = undefined
  }
  for (const message of messages) {
    if (message.role === 'assistant') lastAssistant = message
    else if (!isToolResultOnly(message)) close()
  }
  close()
  return answers.reverse()
}

async function pastAnswers($: Engine): Promise<string[]> {
  return answersFrom((await $.session.messages({ as: 'api' })) as unknown as ApiMessage[])
}

// ---------- Texto de estado ----------

export function stateText(current: { phase: Phase; enabled: boolean; status: Status; error: string | null }): string {
  const { status: s } = current
  if (current.error) return `⚠ ${current.error}`
  if (current.phase === 'building') return 'Compilando…'
  if (current.phase === 'starting') return 'Iniciando…'
  if (!current.enabled) return '🔇 Apagado'
  if (s.state === 'speaking') return `🔊 Frase ${s.sentence}/${s.total}`
  if (s.state === 'paused') return `⏸ En pausa ${s.sentence}/${s.total}`
  return 'En espera'
}

// ---------- Servidor ----------

type Child = ReturnType<Engine['process']['spawn']>

let child: Child | undefined
let conn: { port: number; token: string } | undefined
let ready = false
let booting: Promise<boolean> | undefined
let lastText = ''
const logLines: string[] = []
let logPath: string | undefined

// Bitácora corta en la carpeta de datos del plugin: explica por qué una respuesta no habló.
async function trace($: Engine, line: string): Promise<void> {
  try {
    logPath ??= `${(await $.process.hookEnv()).CLAUDE_PLUGIN_DATA}/voice.log`
    logLines.push(`${new Date().toISOString()} ${line}`)
    if (logLines.length > MAX_LOG_LINES) logLines.splice(0, logLines.length - MAX_LOG_LINES)
    await $.fs.write(logPath, logLines.join('\n') + '\n')
  } catch {
    // la bitácora nunca rompe la lectura
  }
}

async function fail($: Engine, message: string): Promise<false> {
  await update($, error, () => message.slice(0, 80))
  await update($, phase, () => 'down' as Phase)
  await trace($, `error: ${message}`)
  $.ui.toast(`voice-player: ${message.slice(0, 120)}`)
  return false
}

function parseStatus(text: string): Status | undefined {
  try {
    const value = JSON.parse(text) as Status
    return typeof value.state === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

// Lee la salida del servidor: READY lo da por arriba, STATE actualiza la banda sin sondear.
async function pump($: Engine, stream: Child, onOutcome: (outcome: 'ready' | number | null) => void): Promise<void> {
  let buffer = ''
  let code: number | null = null
  try {
    for (;;) {
      const step = await stream.next()
      if (step.done) {
        code = step.value.code
        break
      }
      if (step.value.stream !== 'stdout') continue
      buffer += step.value.text
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const raw of lines) {
        const line = raw.trim()
        if (line === 'READY') {
          ready = true
          onOutcome('ready')
        } else if (line.startsWith('STATE ')) {
          const next = parseStatus(line.slice(6))
          if (next) await update($, status, () => next)
        }
      }
    }
  } catch (cause) {
    await trace($, `pump: ${String(cause)}`)
  }
  onOutcome(code)
  if (child === stream) {
    ready = false
    child = undefined
    await update($, status, () => IDLE)
    await update($, phase, () => 'down' as Phase)
    await trace($, `server exit: ${code}`)
  }
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, '0')).join('')
}

async function boot($: Engine): Promise<boolean> {
  const env = await $.process.hookEnv()
  const dir = `${env.CLAUDE_PLUGIN_ROOT}/server`
  const exe = `${dir}/out/voice-player-server.exe`
  await update($, error, () => null)

  if (!(await $.fs.exists(exe))) {
    await update($, phase, () => 'building' as Phase)
    try {
      const built = await $.process.run(['dotnet', 'build', 'VoicePlayer.csproj', '-c', 'Release', '-o', 'out'], { cwd: dir, timeoutMs: 600000 })
      if (built.exitCode !== 0) return fail($, `no compiló (${built.stdout.split('\n').find(l => l.includes('error')) ?? built.exitCode})`)
    } catch (cause) {
      return fail($, `no compiló: ${String(cause)}`)
    }
  }

  for (let attempt = 0; attempt < MAX_START_ATTEMPTS; attempt++) {
    await update($, phase, () => 'starting' as Phase)
    const port = 49152 + ((crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) % (65000 - 49152 + 1))
    const token = randomHex(16)
    conn = { port, token }
    const stream = $.process.spawn({
      argv: [exe, '--port', String(port), '--token', token, '--parent-pid', env.CLAUDE_PID ?? '0'],
    })
    child = stream
    const outcome = await new Promise<'ready' | number | null>(resolve => {
      void pump($, stream, resolve)
    })
    if (outcome === 'ready') {
      await update($, phase, () => 'ready' as Phase)
      await trace($, `server up on ${port}`)
      return true
    }
    if (outcome !== 3) return fail($, `el servidor terminó (${outcome})`)
  }
  return fail($, 'no hay puerto libre')
}

function ensureServer($: Engine): Promise<boolean> {
  if (ready) return Promise.resolve(true)
  booting ??= boot($).finally(() => {
    booting = undefined
  })
  return booting
}

async function withTimeout<T>($: Engine, work: Promise<T>, ms: number): Promise<T> {
  const cancel = new AbortController()
  const timer = $.clock.sleep(ms, { signal: cancel.signal }).then(() => {
    throw new Error('timeout')
  })
  timer.catch(() => {})
  try {
    return await Promise.race([work, timer])
  } finally {
    cancel.abort()
  }
}

// Una petición al servidor; si falla la conexión, lo reinicia una vez y reintenta una vez.
async function send($: Engine, path: string, body: object = {}): Promise<Status | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!(await ensureServer($)) || !conn) return undefined
    try {
      // HttpListener exige longitud de contenido en los POST: siempre se envía JSON.
      const reply = await withTimeout(
        $,
        $.http.fetch(`http://localhost:${conn.port}${path}`, {
          method: 'POST',
          headers: { 'X-Voice-Token': conn.token, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
        REQUEST_TIMEOUT_MS,
      )
      if (!reply.ok) throw new Error(`HTTP ${reply.status}`)
      const next = parseStatus(reply.text)
      if (next) await update($, status, () => next)
      return next
    } catch (cause) {
      await trace($, `send ${path} failed: ${String(cause)}`)
      ready = false
      const dead = child
      child = undefined
      void dead?.return(undefined as never)
    }
  }
  await fail($, 'sin conexión con el servidor de voz')
  return undefined
}

// ---------- Acciones ----------

async function speakText($: Engine, text: string): Promise<boolean> {
  const sentences = splitSentences(text)
  if (sentences.length === 0) return false
  const speed = Number((await $.store.get(KEY_RATE)) ?? 1)
  return (await send($, '/speak', { sentences, rate: speed, start: 0 })) !== undefined
}

async function again($: Engine, value: string | undefined): Promise<string> {
  const position = value === undefined ? 1 : Math.round(Number(value))
  if (!Number.isFinite(position) || position < 1) return 'Uso: /voice-player again [n]  (1 = la última)'
  const useLast = value === undefined && lastText !== ''
  const answer = useLast ? lastText : (await pastAnswers($))[position - 1]
  if (!answer) return `No hay una respuesta ${position}.`
  const text = useLast ? answer : toSpeech(answer)
  if (!text) return 'Esa respuesta no tiene texto para leer.'
  return (await speakText($, text)) ? `Leyendo la respuesta ${position} hacia atrás.` : 'No se pudo leer.'
}

async function setEnabled($: Engine, on: boolean): Promise<string> {
  await $.store.set(KEY_ENABLED, on)
  await update($, enabled, () => on)
  if (!on && ready) await send($, '/stop')
  if (on) void ensureServer($)
  return on ? 'Voz activada.' : 'Voz desactivada.'
}

async function setRate($: Engine, value: number): Promise<string> {
  const next = Math.max(-10, Math.min(10, Math.round(value)))
  await $.store.set(KEY_RATE, next)
  await update($, rate, () => next)
  if (ready) await send($, '/rate', { rate: next })
  return `Velocidad de voz: ${next}.`
}

// Controles que solo tienen sentido con el servidor ya levantado: no lo arrancan.
async function control($: Engine, action: 'pause' | 'resume' | 'stop' | 'next' | 'prev'): Promise<string> {
  if (!ready) return 'No hay nada leyéndose.'
  const state = await send($, `/${action}`)
  return state ? `${action}: ${state.state} ${state.sentence}/${state.total}` : 'Sin respuesta del servidor.'
}

async function statusLine($: Engine): Promise<string> {
  const current = {
    phase: await read($, phase),
    enabled: await read($, enabled),
    status: await read($, status),
    error: await read($, error),
  }
  return `${stateText(current)} · Vel ${await read($, rate)}`
}

type Action = 'prev' | 'toggle-pause' | 'next' | 'stop' | 'again' | 'slower' | 'faster' | 'toggle-voice'

async function act($: Engine, action: Action): Promise<void> {
  const state = (await read($, status)).state
  const speed = await read($, rate)
  if (action === 'prev' || action === 'next' || action === 'stop') await control($, action)
  else if (action === 'toggle-pause') await control($, state === 'paused' ? 'resume' : 'pause')
  else if (action === 'again') await again($, undefined)
  else if (action === 'slower') await setRate($, speed - 1)
  else if (action === 'faster') await setRate($, speed + 1)
  else await setEnabled($, !(await read($, enabled)))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'voice-player',
      description: 'Voice player: pause | resume | stop | next | prev | again [n] | rate <-10..10> | on | off | status | log',
    })
    const isOn = (await $.store.get(KEY_ENABLED)) !== false
    const speed = Number((await $.store.get(KEY_RATE)) ?? 1)
    await update($, enabled, () => isOn)
    await update($, rate, () => speed)
    if (isOn) void ensureServer($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    if (e.reason !== 'answer') return result
    if ((await $.store.get(KEY_ENABLED)) === false) return result
    const text = toSpeech(result.text || e.answer)
    if (!text) {
      await trace($, 'skip: empty text')
      return result
    }
    lastText = text
    await trace($, `speak: ${text.length} chars`)
    await speakText($, text)
    return result
  })

  // Un nuevo mensaje corta la lectura anterior.
  on('prompt.submit', async ($, e, next) => {
    if (ready && (await read($, status)).state !== 'idle') await send($, '/stop')
    return next(e)
  })

  on('command.run', { command: 'voice-player' }, async ($, e) => {
    const [action = 'status', value] = e.args.trim().toLowerCase().split(/\s+/)

    if (action === 'pause' || action === 'resume' || action === 'stop' || action === 'next' || action === 'prev') {
      return { text: await control($, action) }
    }
    if (action === 'on') return { text: await setEnabled($, true) }
    if (action === 'off') return { text: await setEnabled($, false) }
    if (action === 'rate') {
      const parsed = Number(value)
      if (value === undefined || Number.isNaN(parsed)) return { text: 'Uso: /voice-player rate <-10..10>' }
      return { text: await setRate($, parsed) }
    }
    if (action === 'again') return { text: await again($, value) }
    if (action === 'log') return { text: logLines.slice(-15).join('\n') || 'Bitácora vacía.' }
    return { text: await statusLine($) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const current = {
      phase: await read($, phase),
      enabled: await read($, enabled),
      status: await read($, status),
      error: await read($, error),
    }
    const speed = await read($, rate)
    const { Box, Button, Text } = $.ui.resolve(e)
    const label = <Text dimColor={!current.enabled}>{stateText(current)} </Text>
    const toggle = (
      <Button key="toggle" hotkey="o" label={current.enabled ? 'Apagar' : 'Encender'} onPress={() => act($, 'toggle-voice')} />
    )

    if (!current.enabled || current.phase === 'building' || current.phase === 'starting') {
      return (
        <Box>
          {label}
          {current.enabled ? null : toggle}
        </Box>
      )
    }

    const paused = current.status.state === 'paused'
    return (
      <Box>
        {label}
        <Button key="prev" hotkey="h" label="⏮" onPress={() => act($, 'prev')} />
        <Button key="pause" hotkey="p" label={paused ? '▶' : '⏸'} onPress={() => act($, 'toggle-pause')} />
        <Button key="next" hotkey="l" label="⏭" onPress={() => act($, 'next')} />
        <Button key="stop" hotkey="s" label="■" onPress={() => act($, 'stop')} />
        <Button key="again" hotkey="r" label="↻" onPress={() => act($, 'again')} />
        <Button key="slower" hotkey="j" label="−" onPress={() => act($, 'slower')} />
        <Text> Vel {speed} </Text>
        <Button key="faster" hotkey="k" label="+" onPress={() => act($, 'faster')} />
        {toggle}
      </Box>
    )
  })
}
