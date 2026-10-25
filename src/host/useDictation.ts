import { useEffect, useRef, useState } from 'react'
import { transcribeCommand } from '../sense/client.ts'
import {
  dictationLabel,
  dictationMode,
  dictationNotice,
  shownCommandStatus,
  type DictationChord,
  type DictationFocus,
  type DictationMode,
} from './dictation.ts'
import { createDictationSession, type DictationSession, type TakeRecorder } from './dictationSession.ts'
import { mediaRecorderAvailable, preferredAudioMime } from './recordCommand.ts'

export type DictationInput = {
  readonly value: string
  readonly busy: boolean
  readonly onChange: (value: string) => void
}

export type DictationHandle = {
  readonly mode: DictationMode
  readonly unavailable: boolean
  readonly label: string
  readonly line: (appStatus: string) => string
  readonly toggle: () => void
  readonly finish: () => void
  readonly onEdit: (value: string) => void
  readonly halt: () => void
}

const SPEECH_RMS = 0.02

function focusOf(target: EventTarget | null): DictationFocus {
  if (!(target instanceof Element)) return 'shell'
  if (target.closest('.command-input')) return 'command'
  if (target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) {
    return 'field'
  }
  return 'shell'
}

function chordFrom(event: KeyboardEvent): DictationChord {
  return {
    type: event.type === 'keyup' ? 'up' : 'down',
    code: event.code,
    key: event.key,
    repeat: event.repeat,
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    shift: event.shiftKey,
    composing: event.isComposing,
    focus: focusOf(event.target),
  }
}

function speechRms(analyser: AnalyserNode, samples: Uint8Array<ArrayBuffer>): number {
  analyser.getByteTimeDomainData(samples)
  let sum = 0
  for (let index = 0; index < samples.length; index += 1) {
    const sample = ((samples[index] ?? 128) - 128) / 128
    sum += sample * sample
  }
  return Math.sqrt(sum / samples.length)
}

function openMeter(stream: MediaStream): { loud(): boolean; close(): void } | null {
  try {
    const context = new AudioContext()
    const source = context.createMediaStreamSource(stream)
    const analyser = context.createAnalyser()
    analyser.fftSize = 1024
    source.connect(analyser)
    const samples = new Uint8Array(analyser.fftSize)
    return {
      loud: () => speechRms(analyser, samples) >= SPEECH_RMS,
      close: () => {
        void context.close().catch(() => undefined)
      },
    }
  } catch {
    return null
  }
}

function browserRecorder(stream: MediaStream, mime: string): TakeRecorder {
  const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
  let ondataavailable: TakeRecorder['ondataavailable'] = null
  let onstop: TakeRecorder['onstop'] = null
  recorder.ondataavailable = (event) => {
    ondataavailable?.({ data: event.data })
  }
  recorder.onstop = () => {
    onstop?.()
  }
  return {
    get state() {
      return recorder.state
    },
    get mimeType() {
      return recorder.mimeType
    },
    get ondataavailable() {
      return ondataavailable
    },
    set ondataavailable(fn) {
      ondataavailable = fn
    },
    get onstop() {
      return onstop
    },
    set onstop(fn) {
      onstop = fn
    },
    start() {
      recorder.start()
    },
    stop() {
      recorder.stop()
    },
  }
}

export function useDictation(input: DictationInput): DictationHandle {
  const live = useRef({
    onChange: input.onChange,
    value: input.value,
    busy: input.busy,
  })
  live.current = {
    onChange: input.onChange,
    value: input.value,
    busy: input.busy,
  }

  const sessionRef = useRef<DictationSession | null>(null)
  if (sessionRef.current === null) {
    sessionRef.current = createDictationSession(
      {
        now: () => performance.now(),
        setInterval: (fn, ms) => window.setInterval(fn, ms),
        clearInterval: (id) => window.clearInterval(id),
        openMic: () =>
          navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
          }),
        isTypeSupported: (mime) => {
          try {
            return MediaRecorder.isTypeSupported(mime)
          } catch {
            return false
          }
        },
        preferredMime: preferredAudioMime,
        createRecorder: browserRecorder,
        openMeter,
        stopStream: (stream) => {
          stream.getTracks().forEach((track) => track.stop())
        },
        transcribe: (audio, signal) => transcribeCommand(audio, signal),
        onChange: (value) => live.current.onChange(value),
        getValue: () => live.current.value,
        getBusy: () => live.current.busy,
      },
      mediaRecorderAvailable(),
      input.value,
    )
  }
  const session = sessionRef.current
  const [state, setState] = useState(() => session.getState())

  useEffect(() => session.subscribe(setState), [session])

  useEffect(() => {
    session.noteValue(input.value)
  }, [session, input.value])

  useEffect(() => {
    session.noteBusy(input.busy)
  }, [session, input.busy])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.type !== 'keydown' && event.type !== 'keyup') return
      if (!session.key(chordFrom(event))) return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKey, true)
    window.addEventListener('blur', session.blur)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKey, true)
      window.removeEventListener('blur', session.blur)
    }
  }, [session])

  useEffect(() => () => session.dispose(), [session])

  const mode = dictationMode(state)
  return {
    mode,
    unavailable: state.phase === 'unsupported',
    label: dictationLabel(state),
    line: (appStatus: string) =>
      shownCommandStatus(appStatus, dictationNotice(state), mode === 'listening', input.busy),
    toggle: () => session.toggle(),
    finish: () => session.finish(),
    onEdit: (next: string) => {
      live.current.value = next
      session.noteValue(next)
      live.current.onChange(next)
    },
    halt: () => session.halt(),
  }
}
