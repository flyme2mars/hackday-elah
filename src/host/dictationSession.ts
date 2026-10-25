import {
  IDLE_DICTATION,
  composeDictation,
  dictateIntent,
  dictationReducer,
  holdAction,
  parakeetFailureMessage,
  type DictationChord,
  type DictationState,
} from './dictation.ts'
import { recordingStop } from './recordCommand.ts'

export type TakeRecorder = {
  state: string
  readonly mimeType: string
  ondataavailable: ((event: { readonly data: Blob }) => void) | null
  onstop: (() => void) | null
  start(): void
  stop(): void
}

export type SpeechMeter = {
  loud(): boolean
  close(): void
}

export type DictationPorts = {
  now(): number
  setInterval(fn: () => void, ms: number): number
  clearInterval(id: number): void
  openMic(): Promise<MediaStream>
  isTypeSupported(mime: string): boolean
  preferredMime(supported: (mime: string) => boolean): string
  createRecorder(stream: MediaStream, mime: string): TakeRecorder
  openMeter(stream: MediaStream): SpeechMeter | null
  stopStream(stream: MediaStream): void
  transcribe(audio: Blob, signal: AbortSignal): Promise<string>
  onChange(value: string): void
  getValue(): string
  getBusy(): boolean
}

export type DictationSession = {
  getState(): DictationState
  subscribe(listener: (state: DictationState) => void): () => void
  toggle(): void
  finish(): void
  halt(): void
  noteValue(value: string): void
  noteBusy(busy: boolean): void
  key(chord: DictationChord): boolean
  blur(): void
  dispose(): void
}

function tryStop(recorder: TakeRecorder): boolean {
  try {
    recorder.stop()
    return true
  } catch {
    return false
  }
}

function micErrorCode(error: unknown): string {
  const name = error instanceof Error ? error.name : ''
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return 'not-allowed'
  }
  if (
    name === 'NotFoundError' ||
    name === 'DevicesNotFoundError' ||
    name === 'NotReadableError' ||
    name === 'OverconstrainedError'
  ) {
    return 'audio-capture'
  }
  return ''
}

export function createDictationSession(
  ports: DictationPorts,
  supported: boolean,
  initialValue: string,
): DictationSession {
  let state = dictationReducer(IDLE_DICTATION, { type: 'probe', supported })
  let echo = initialValue
  let base = initialValue
  let busy = false
  let token = 0
  let holding: string | null = null
  let takeKind: 'click' | 'hold' = 'click'
  let armRelease: 'send' | null = null
  let discard = false
  let stopping = false
  let timer = 0
  let meter: SpeechMeter | null = null
  let stream: MediaStream | null = null
  let recorder: TakeRecorder | null = null
  let abort: AbortController | null = null
  const listeners = new Set<(next: DictationState) => void>()

  function emit(): void {
    for (const listener of listeners) listener(state)
  }

  function commit(event: Parameters<typeof dictationReducer>[1]): void {
    const next = dictationReducer(state, event)
    if (next === state) return
    state = next
    emit()
  }

  function releaseMeter(): void {
    ports.clearInterval(timer)
    timer = 0
    const current = meter
    meter = null
    current?.close()
  }

  function releaseStream(): void {
    if (stream) ports.stopStream(stream)
    stream = null
    recorder = null
  }

  function stopRecorder(mode: 'transcribe' | 'discard'): void {
    if (stopping && mode === 'transcribe') return
    stopping = true
    if (mode === 'discard') discard = true
    releaseMeter()
    const current = recorder
    if (current && current.state === 'recording' && tryStop(current)) return
    releaseStream()
  }

  function cancelTake(): void {
    if (
      state.phase !== 'arming' &&
      state.phase !== 'listening' &&
      state.phase !== 'finalizing' &&
      state.phase !== 'failed'
    ) {
      return
    }
    token += 1
    holding = null
    armRelease = null
    discard = true
    abort?.abort()
    abort = null
    stopRecorder('discard')
    commit({ type: 'halt' })
  }

  function applySpoken(text: string): void {
    const next = composeDictation(base, [{ text, final: true }])
    echo = next
    ports.onChange(next)
  }

  async function publish(id: number, audio: Blob): Promise<void> {
    if (token !== id) return
    if (audio.size < 32) {
      commit({ type: 'reject', message: 'No speech heard.' })
      return
    }
    const controller = new AbortController()
    abort = controller
    try {
      const text = await ports.transcribe(audio, controller.signal)
      if (token !== id || controller.signal.aborted) return
      if (!text) {
        commit({ type: 'reject', message: 'No speech heard.' })
        return
      }
      applySpoken(text)
      commit({ type: 'accept' })
    } catch (error) {
      if (token !== id || controller.signal.aborted) return
      commit({ type: 'reject', message: parakeetFailureMessage(error) })
    } finally {
      if (abort === controller) abort = null
    }
  }

  function watchTake(id: number, live: MediaStream, silence: boolean): void {
    const started = ports.now()
    let lastLoud = started
    let heard = false
    const level = silence ? ports.openMeter(live) : null
    meter = level
    ports.clearInterval(timer)
    timer = ports.setInterval(() => {
      if (token !== id || stopping) return
      const now = ports.now()
      if (level?.loud()) {
        heard = true
        lastLoud = now
      }
      const reason = recordingStop(
        {
          elapsedMs: now - started,
          silentMs: level ? now - lastLoud : 0,
          heardSpeech: level ? heard : true,
        },
        silence,
      )
      if (reason) stopRecorder('transcribe')
    }, 100)
  }

  async function begin(id: number): Promise<void> {
    let live: MediaStream
    try {
      live = await ports.openMic()
    } catch (error) {
      if (token !== id) return
      holding = null
      commit({ type: 'error', code: micErrorCode(error) })
      return
    }
    if (token !== id || state.phase !== 'arming') {
      ports.stopStream(live)
      return
    }
    stream = live
    const mime = ports.preferredMime((candidate) => ports.isTypeSupported(candidate))
    let next: TakeRecorder
    try {
      next = ports.createRecorder(live, mime)
    } catch (error) {
      releaseStream()
      ports.stopStream(live)
      if (token !== id) return
      holding = null
      commit({ type: 'error', code: micErrorCode(error) || 'audio-capture' })
      return
    }
    const chunks: Blob[] = []
    next.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    }
    next.onstop = () => {
      const take = new Blob(chunks, { type: next.mimeType || mime || 'audio/webm' })
      releaseMeter()
      releaseStream()
      if (token !== id || discard) return
      commit({ type: 'finalize' })
      void publish(id, take)
    }
    recorder = next
    try {
      next.start()
    } catch (error) {
      releaseStream()
      ports.stopStream(live)
      if (token !== id) return
      holding = null
      commit({ type: 'error', code: micErrorCode(error) })
      return
    }
    if (token !== id) {
      stopRecorder('discard')
      return
    }
    commit({ type: 'started' })
    if (armRelease === 'send') {
      armRelease = null
      stopRecorder('transcribe')
      return
    }
    watchTake(id, live, takeKind === 'click')
  }

  function beginTake(kind: 'click' | 'hold'): boolean {
    if (busy || !supported) return false
    if (state.phase === 'arming' || state.phase === 'listening' || state.phase === 'finalizing') return false
    if (state.phase === 'unsupported') return false
    base = ports.getValue()
    discard = false
    stopping = false
    armRelease = null
    takeKind = kind
    commit({ type: 'arm' })
    const id = ++token
    void begin(id)
    return true
  }

  function sendTake(): void {
    if (state.phase === 'listening') {
      stopRecorder('transcribe')
      return
    }
    if (state.phase === 'arming') armRelease = 'send'
  }

  function toggle(): void {
    const intent = dictateIntent(state)
    if (intent === 'none') return
    if (intent === 'stop') {
      finish()
      return
    }
    if (!supported) {
      commit({ type: 'probe', supported: false })
      return
    }
    holding = null
    beginTake('click')
  }

  function finish(): void {
    if (state.phase === 'listening' || state.phase === 'arming') {
      holding = null
      sendTake()
      return
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    toggle,
    finish,
    halt: cancelTake,
    noteValue(value) {
      if (value === echo) return
      echo = value
      cancelTake()
    },
    noteBusy(next) {
      busy = next
      if (next) cancelTake()
    },
    key(chord) {
      const action = holdAction(chord, state.phase, busy, holding)
      switch (action.type) {
        case 'ignore':
          return false
        case 'start':
          holding = chord.code || 'Alt'
          if (!beginTake('hold')) holding = null
          return false
        case 'send':
          holding = null
          sendTake()
          return true
        case 'cancel':
          holding = null
          cancelTake()
          return action.prevent
        case 'drop':
          holding = null
          return true
        default: {
          const _exhaustive: never = action
          return _exhaustive
        }
      }
    },
    blur() {
      if (holding !== null && (state.phase === 'arming' || state.phase === 'listening')) cancelTake()
    },
    dispose() {
      token += 1
      holding = null
      armRelease = null
      discard = true
      abort?.abort()
      abort = null
      releaseMeter()
      if (recorder && recorder.state === 'recording') tryStop(recorder)
      releaseStream()
      listeners.clear()
    },
  }
}
