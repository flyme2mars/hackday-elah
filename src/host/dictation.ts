export const IDLE_DICTATION: DictationState = { phase: 'idle' }

export type DictationState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'arming' }
  | { readonly phase: 'listening' }
  | { readonly phase: 'finalizing' }
  | { readonly phase: 'failed'; readonly message: string }
  | { readonly phase: 'denied'; readonly reason: 'blocked' | 'missing' }
  | { readonly phase: 'unsupported' }

export type DictationEvent =
  | { readonly type: 'probe'; readonly supported: boolean }
  | { readonly type: 'arm' }
  | { readonly type: 'started' }
  | { readonly type: 'ended' }
  | { readonly type: 'halt' }
  | { readonly type: 'finalize' }
  | { readonly type: 'accept' }
  | { readonly type: 'reject'; readonly message: string }
  | { readonly type: 'error'; readonly code: string }

export type DictationMode = 'idle' | 'listening' | 'denied'

export type DictationChunk = {
  readonly text: string
  readonly final: boolean
}

type DictationFault =
  | { readonly kind: 'denied' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'ignore' }

type DenyReason = 'blocked' | 'missing'

function faultFromCode(code: string): DictationFault {
  if (code === 'not-allowed' || code === 'service-not-allowed') return { kind: 'denied' }
  if (code === 'audio-capture') return { kind: 'missing' }
  return { kind: 'ignore' }
}

function deny(state: DictationState, reason: DenyReason): DictationState {
  if (state.phase === 'denied' && state.reason === reason) return state
  return { phase: 'denied', reason }
}

export function dictationReducer(state: DictationState, event: DictationEvent): DictationState {
  if (typeof event?.type !== 'string') return state
  switch (event.type) {
    case 'probe':
      if (!event.supported && state.phase !== 'unsupported') return { phase: 'unsupported' }
      return state
    case 'arm':
      if (state.phase === 'idle' || state.phase === 'denied' || state.phase === 'failed') {
        return { phase: 'arming' }
      }
      return state
    case 'started':
      if (state.phase === 'arming') return { phase: 'listening' }
      return state
    case 'ended':
    case 'halt':
      if (
        state.phase === 'arming' ||
        state.phase === 'listening' ||
        state.phase === 'finalizing' ||
        state.phase === 'failed'
      ) {
        return IDLE_DICTATION
      }
      return state
    case 'finalize':
      if (state.phase === 'listening') return { phase: 'finalizing' }
      return state
    case 'accept':
      if (state.phase === 'finalizing') return IDLE_DICTATION
      return state
    case 'reject':
      if (
        state.phase === 'arming' ||
        state.phase === 'listening' ||
        state.phase === 'finalizing'
      ) {
        return { phase: 'failed', message: event.message }
      }
      return state
    case 'error':
      return reduceError(state, event.code)
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}

function reduceError(state: DictationState, code: string): DictationState {
  if (state.phase === 'unsupported') return state
  const fault = faultFromCode(code)
  switch (fault.kind) {
    case 'denied':
      return deny(state, 'blocked')
    case 'missing':
      return deny(state, 'missing')
    case 'ignore':
      if (state.phase === 'arming' || state.phase === 'listening' || state.phase === 'finalizing') {
        return IDLE_DICTATION
      }
      return state
    default: {
      const _exhaustive: never = fault
      void _exhaustive
      return state
    }
  }
}

export function dictateIntent(state: DictationState): 'start' | 'stop' | 'none' {
  switch (state.phase) {
    case 'unsupported':
      return 'none'
    case 'arming':
    case 'listening':
    case 'finalizing':
      return 'stop'
    case 'idle':
    case 'denied':
    case 'failed':
      return 'start'
    default: {
      const _exhaustive: never = state
      return _exhaustive
    }
  }
}

export function dictationMode(state: DictationState): DictationMode {
  switch (state.phase) {
    case 'arming':
    case 'listening':
    case 'finalizing':
      return 'listening'
    case 'denied':
    case 'unsupported':
      return 'denied'
    case 'idle':
    case 'failed':
      return 'idle'
    default: {
      const _exhaustive: never = state
      return _exhaustive
    }
  }
}

function deniedNotice(reason: DenyReason): string {
  switch (reason) {
    case 'blocked':
      return 'Microphone access was denied.'
    case 'missing':
      return 'No microphone was found.'
    default: {
      const _exhaustive: never = reason
      return _exhaustive
    }
  }
}

function deniedLabel(reason: DenyReason): string {
  switch (reason) {
    case 'blocked':
      return 'Microphone denied'
    case 'missing':
      return 'No microphone'
    default: {
      const _exhaustive: never = reason
      return _exhaustive
    }
  }
}

export function dictationNotice(state: DictationState): string | null {
  switch (state.phase) {
    case 'unsupported':
      return 'Microphone recording is not available in this browser.'
    case 'denied':
      return deniedNotice(state.reason)
    case 'finalizing':
      return 'Transcribing…'
    case 'failed':
      return state.message
    case 'idle':
    case 'arming':
    case 'listening':
      return null
    default: {
      const _exhaustive: never = state
      return _exhaustive
    }
  }
}

export function dictationLabel(state: DictationState): string {
  switch (state.phase) {
    case 'unsupported':
      return 'Microphone unavailable'
    case 'denied':
      return deniedLabel(state.reason)
    case 'arming':
    case 'listening':
    case 'finalizing':
      return 'Stop dictation'
    case 'idle':
    case 'failed':
      return 'Start dictation'
    default: {
      const _exhaustive: never = state
      return _exhaustive
    }
  }
}

export function shownCommandStatus(
  appStatus: string,
  notice: string | null,
  listening: boolean,
  busy: boolean,
): string {
  if (busy) return appStatus || 'Ready'
  if (notice !== null) return notice
  if (listening) return 'Listening\u2026'
  return appStatus || 'Ready'
}

function spokenText(chunks: readonly DictationChunk[]): string {
  const committed: string[] = []
  let interim = ''
  for (const chunk of chunks) {
    const text = chunk.text.trim()
    if (!text) continue
    if (chunk.final) {
      committed.push(text)
      interim = ''
      continue
    }
    interim = text
  }
  if (interim) committed.push(interim)
  return committed.join(' ')
}

export function composeDictation(base: string, chunks: readonly DictationChunk[]): string {
  const spoken = spokenText(chunks)
  if (!spoken) return base
  if (base.length === 0 || /\s$/.test(base)) return `${base}${spoken}`
  return `${base} ${spoken}`
}

export type DictationFocus = 'command' | 'field' | 'shell'

export type DictationChord = {
  readonly type: 'down' | 'up'
  readonly code: string
  readonly key: string
  readonly repeat: boolean
  readonly ctrl: boolean
  readonly meta: boolean
  readonly shift: boolean
  readonly composing: boolean
  readonly focus: DictationFocus
}

export type HoldAction =
  | { readonly type: 'ignore' }
  | { readonly type: 'start' }
  | { readonly type: 'send' }
  | { readonly type: 'cancel'; readonly prevent: boolean }
  | { readonly type: 'drop' }

const ACTIVE = new Set<DictationState['phase']>(['arming', 'listening', 'finalizing'])

function isAlt(chord: DictationChord): boolean {
  return chord.code === 'AltLeft' || chord.code === 'AltRight' || (chord.key === 'Alt' && chord.code === '')
}

function altIdentity(chord: DictationChord): string {
  return chord.code || 'Alt'
}

export function holdAction(
  chord: DictationChord,
  phase: DictationState['phase'],
  busy: boolean,
  holding: string | null,
): HoldAction {
  if (chord.composing) return { type: 'ignore' }
  if (chord.type === 'down' && chord.key === 'Escape' && !chord.repeat) {
    if (phase === 'arming' || phase === 'listening' || phase === 'finalizing') {
      return { type: 'cancel', prevent: true }
    }
    return { type: 'ignore' }
  }
  if (chord.type === 'down' && isAlt(chord)) {
    if (chord.repeat || holding !== null) return { type: 'ignore' }
    if (chord.ctrl || chord.meta || chord.shift) return { type: 'ignore' }
    if (chord.focus === 'field') return { type: 'ignore' }
    if (busy || phase === 'unsupported' || ACTIVE.has(phase)) return { type: 'ignore' }
    return { type: 'start' }
  }
  if (chord.type === 'up' && isAlt(chord)) {
    if (holding === null || holding !== altIdentity(chord)) return { type: 'ignore' }
    if (phase === 'arming' || phase === 'listening') return { type: 'send' }
    return { type: 'drop' }
  }
  if (chord.type === 'down' && holding !== null && !isAlt(chord)) {
    if (phase === 'arming' || phase === 'listening') return { type: 'cancel', prevent: false }
  }
  return { type: 'ignore' }
}

export function parakeetFailureMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'DictationRequestError') {
    const message = error.message.trim()
    return (message || 'Parakeet is not loaded.').slice(0, 180)
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'Parakeet is not loaded.'
  }
  return 'Parakeet returned no text.'
}
