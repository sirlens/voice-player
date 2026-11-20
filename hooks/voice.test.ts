import { expect, test } from 'claude-code/testing'

import { answersFrom, splitSentences, stateText, toSpeech, type ApiMessage } from './register'

test('toSpeech drops code blocks, links and markdown marks', async () => {
  const markdown = [
    '## Título',
    '',
    'Usa **`make b`** y mira [la guía](https://x.dev/guia).',
    '',
    '```bash',
    'rm -rf /',
    '```',
    '- uno',
    '- dos',
  ].join('\n')

  expect(toSpeech(markdown)).toBe(
    'Título. Usa make b y mira la guía. (bloque de código omitido) uno dos',
  )
})

test('toSpeech reads table cells and skips the separator row', async () => {
  expect(toSpeech('| a | b |\n|---|---|\n| 1 | 2 |')).toBe('a, b. 1, 2.')
})

test('toSpeech replaces bare urls and caps very long answers', async () => {
  expect(toSpeech('ver https://example.com/x ya')).toBe('ver enlace ya')
  expect(toSpeech('a'.repeat(30_000))).toBe(`${'a'.repeat(20_000)}. Respuesta recortada.`)
})

test('toSpeech reads a path as its last segment', async () => {
  expect(toSpeech('Edita ~/.claude/settings.json y C:\\Users\\x\\.claude\\CLAUDE.md, no y/o.')).toBe(
    'Edita settings.json y CLAUDE.md, no y/o.',
  )
})

test('splitSentences splits on end punctuation and keeps decimals whole', async () => {
  expect(
    splitSentences('Esta es la primera frase del texto. Mide 3.5 metros de largo en total. ¿Quieres ver más ejemplos? ¡Claro que sí, vamos!'),
  ).toEqual([
    'Esta es la primera frase del texto.',
    'Mide 3.5 metros de largo en total.',
    '¿Quieres ver más ejemplos?',
    '¡Claro que sí, vamos!',
  ])
})

test('splitSentences does not cut after abbreviations followed by lowercase', async () => {
  expect(
    splitSentences('Hay varias opciones, p. ej. usar la cola de mensajes del sistema. Compra pan, leche, etc. y llévalo todo a casa hoy.'),
  ).toEqual([
    'Hay varias opciones, p. ej. usar la cola de mensajes del sistema.',
    'Compra pan, leche, etc. y llévalo todo a casa hoy.',
  ])
})

test('splitSentences merges short fragments into their neighbour', async () => {
  expect(splitSentences('Sí. Claro que podemos hacerlo ahora mismo. No.')).toEqual([
    'Sí. Claro que podemos hacerlo ahora mismo. No.',
  ])
  expect(splitSentences('')).toEqual([])
})

test('answersFrom takes the final assistant text of each turn, newest first', async () => {
  const messages: ApiMessage[] = [
    { role: 'user', content: 'primera pregunta' },
    { role: 'assistant', content: [{ type: 'text', text: 'Reviso.' }, { type: 'tool_use' }] },
    { role: 'user', content: [{ type: 'tool_result' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Respuesta uno' }] },
    { role: 'user', content: 'segunda pregunta' },
    { role: 'assistant', content: [{ type: 'tool_use' }] },
    { role: 'user', content: [{ type: 'tool_result' }] },
    { role: 'assistant', content: 'Respuesta dos' },
  ]

  expect(answersFrom(messages)).toEqual(['Respuesta dos', 'Respuesta uno'])
})

test('answersFrom skips turns that ended without text', async () => {
  const messages: ApiMessage[] = [
    { role: 'user', content: 'hola' },
    { role: 'assistant', content: [{ type: 'thinking' }] },
    { role: 'user', content: 'otra' },
    { role: 'assistant', content: [{ type: 'text', text: 'Hola' }] },
  ]

  expect(answersFrom(messages)).toEqual(['Hola'])
})

test('stateText summarises the player state', async () => {
  const idle = { state: 'idle', sentence: 0, total: 0, rate: 1 } as const
  const base = { phase: 'ready', enabled: true, status: idle, error: null } as const

  expect(stateText(base)).toBe('En espera')
  expect(stateText({ ...base, status: { ...idle, state: 'speaking', sentence: 4, total: 12 } })).toBe('🔊 Frase 4/12')
  expect(stateText({ ...base, status: { ...idle, state: 'paused', sentence: 4, total: 12 } })).toBe('⏸ En pausa 4/12')
  expect(stateText({ ...base, enabled: false })).toBe('🔇 Apagado')
  expect(stateText({ ...base, phase: 'building' })).toBe('Compilando…')
  expect(stateText({ ...base, error: 'boom' })).toBe('⚠ boom')
})
