export type Phase = 'off' | 'building' | 'starting' | 'ready' | 'down'

export type Status = {
  state: 'idle' | 'speaking' | 'paused'
  sentence: number
  total: number
  rate: number
}

declare module 'claude-code' {
  interface PluginState {
    'voice-player': {
      status: Status
      phase: Phase
      enabled: boolean
      rate: number
      error: string | null
    }
  }
}
