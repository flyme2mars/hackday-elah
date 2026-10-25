import { useEffect, useRef, useState } from 'react'
import { DictationRequestError, transcribeCommand } from '../sense/client.ts'
import {
  IDLE_DICTATION,
  chunksFromResultList,
  composeDictation,
  dictateIntent,
  dictationLabel,
  dictationMode,
  dictationNotice,
  dictationReducer,
  shownCommandStatus,
  type DictationEvent,
  type DictationMode,
  type DictationState,
  type ResultListLike,
} from './dictation.ts'
import { mediaRecorderAvailable, preferredAudioMime, recordingStop } from './recordCommand.ts'

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

type RecognitionCtor = new () => BrowserRecognition

type BrowserRecognition = {
  continuous: boolean
  interimResults: boolean
  lang: string
  onstart: (() => void) | null
  onend: (() => void) | null
  onerror: ((event: { readonly error?: string }) => void) | null
  onresult: ((event: { readonly results?: ResultListLike }) => void) | null
  start: () => void
  stop: () => void
}

type LevelMeter = {
  readonly context: AudioContext
  readonly analyser: AnalyserNode
  readonly samples: Uint8Array<ArrayBuffer>
}

const SPEECH_RMS = 0.02

function isRecognitionCtor(value: unknown): value is RecognitionCtor {
  return typeof value === 'function'
}

function ctorNamed(name: string): RecognitionCtor | null {
  if (!(name in window)) return null
  const value: unknown = Reflect.get(window, name)
  return isRecognitionCtor(value) ? value : null
}

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null
  if (!window.isSecureContext) return null
  return ctorNamed('SpeechRecognition') ?? ctorNamed('webkitSpeechRecognition')
}

function eventFromStartFailure(error: unknown): DictationEvent {
  const name = error instanceof Error ? error.name : ''
  if (name === 'InvalidStateError') return { type: 'started' }
  if (name === 'NotAllowedError') return { type: 'error', code: 'not-allowed' }
  return { type: 'error', code: '' }
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

function safeStop(recognition: BrowserRecognition | null): void {
  if (!recognition) return
  try {
    recognition.stop()
  } catch {
    // stop() throws when start() never succeeded.
  }
}

function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop())
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

function openMeter(stream: MediaStream): LevelMeter | null {
  try {
    const context = new AudioContext()
    const source = context.createMediaStreamSource(stream)
    const analyser = context.createAnalyser()
    analyser.fftSize = 1024
    source.connect(analyser)
    return { context, analyser, samples: new Uint8Array(analyser.fftSize) }
  } catch {
    return null
  }
}

function parakeetMissed(error: unknown): boolean {
  if (error instanceof DictationRequestError) return !error.reachable
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

export function useDictation(input: DictationInput): DictationHandle {
  const onChangeRef = useRef(input.onChange)
  const valueRef = useRef(input.value)
  const busyRef = useRef(input.busy)

  const [state, setState] = useState<DictationState>(() =>
    dictationReducer(IDLE_DICTATION, {
      type: 'probe',
      supported: mediaRecorderAvailable(),
    }),
  )
  const phaseRef = useRef(state)
  const echoRef = useRef(input.value)
  const baseRef = useRef(input.value)
  const recognitionRef = useRef<BrowserRecognition | null>(null)
  const sessionRef = useRef(0)
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const meterRef = useRef<LevelMeter | null>(null)
  const timerRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const discardRef = useRef(false)
  const stoppingRef = useRef(false)

  function commit(event: DictationEvent): void {
    phaseRef.current = dictationReducer(phaseRef.current, event)
    setState(phaseRef.current)
  }

  function releaseMeter(): void {
    window.clearInterval(timerRef.current)
    timerRef.current = 0
    const meter = meterRef.current
    meterRef.current = null
    if (!meter) return
    void meter.context.close().catch(() => undefined)
  }

  function releaseStream(): void {
    stopStream(streamRef.current)
    streamRef.current = null
    recorderRef.current = null
  }

  function stopRecorder(mode: 'transcribe' | 'discard'): void {
    if (stoppingRef.current && mode === 'transcribe') return
    stoppingRef.current = true
    if (mode === 'discard') discardRef.current = true
    releaseMeter()
    const recorder = recorderRef.current
    if (recorder && recorder.state === 'recording') {
      try {
        recorder.stop()
        return
      } catch {
        // stop() throws when the recorder never started.
      }
    }
    releaseStream()
  }

  function applySpoken(text: string): void {
    const next = composeDictation(baseRef.current, [{ text, final: true }])
    echoRef.current = next
    onChangeRef.current(next)
  }

  function halt(): void {
    const phase = phaseRef.current.phase
    if (
      phase !== 'arming' &&
      phase !== 'listening' &&
      phase !== 'finalizing' &&
      phase !== 'fallback' &&
      phase !== 'failed'
    ) {
      return
    }
    sessionRef.current += 1
    discardRef.current = true
    abortRef.current?.abort()
    abortRef.current = null
    stopRecorder('discard')
    safeStop(recognitionRef.current)
    recognitionRef.current = null
    commit({ type: 'halt' })
  }

  function finish(): void {
    const phase = phaseRef.current.phase
    if (phase === 'listening') {
      stopRecorder('transcribe')
      return
    }
    if (phase === 'arming' || phase === 'finalizing' || phase === 'fallback') halt()
  }

  async function publish(id: number, audio: Blob): Promise<void> {
    if (sessionRef.current !== id) return
    if (audio.size < 32) {
      commit({ type: 'reject', message: 'No speech heard.' })
      return
    }
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const text = await transcribeCommand(audio, controller.signal)
      if (sessionRef.current !== id || controller.signal.aborted) return
      if (!text) {
        commit({ type: 'reject', message: 'No speech heard.' })
        return
      }
      applySpoken(text)
      commit({ type: 'accept' })
    } catch (error) {
      if (sessionRef.current !== id || controller.signal.aborted) return
      if (parakeetMissed(error) && recognitionCtor()) {
        commit({ type: 'fallback' })
        startWebSpeech(id)
        return
      }
      const message =
        error instanceof DictationRequestError
          ? error.message
          : parakeetMissed(error)
            ? 'Parakeet is not loaded.'
            : 'Parakeet returned no text.'
      commit({ type: 'reject', message: message.slice(0, 180) })
    } finally {
      if (abortRef.current === controller) abortRef.current = null
    }
  }

  function watchSilence(id: number, stream: MediaStream): void {
    const started = performance.now()
    let lastLoud = started
    let heard = false
    const meter = openMeter(stream)
    meterRef.current = meter
    window.clearInterval(timerRef.current)
    timerRef.current = window.setInterval(() => {
      if (sessionRef.current !== id || stoppingRef.current) return
      const now = performance.now()
      if (meter && speechRms(meter.analyser, meter.samples) >= SPEECH_RMS) {
        heard = true
        lastLoud = now
      }
      const reason = recordingStop({
        elapsedMs: now - started,
        silentMs: meter ? now - lastLoud : 0,
        heardSpeech: meter ? heard : true,
      })
      if (reason) stopRecorder('transcribe')
    }, 100)
  }

  async function beginRecording(id: number): Promise<void> {
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      })
    } catch (error) {
      if (sessionRef.current !== id) return
      commit({ type: 'error', code: micErrorCode(error) })
      return
    }
    if (sessionRef.current !== id || phaseRef.current.phase !== 'arming') {
      stopStream(stream)
      return
    }
    streamRef.current = stream
    const mime = preferredAudioMime((candidate) => {
      try {
        return MediaRecorder.isTypeSupported(candidate)
      } catch {
        return false
      }
    })
    let recorder: MediaRecorder
    try {
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
    } catch (error) {
      releaseStream()
      stopStream(stream)
      if (sessionRef.current !== id) return
      commit({ type: 'error', code: micErrorCode(error) || 'audio-capture' })
      return
    }
    const chunks: Blob[] = []
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    }
    recorder.onstop = () => {
      const take = new Blob(chunks, { type: recorder.mimeType || mime || 'audio/webm' })
      releaseMeter()
      releaseStream()
      if (sessionRef.current !== id || discardRef.current) return
      commit({ type: 'finalize' })
      void publish(id, take)
    }
    recorderRef.current = recorder
    try {
      recorder.start()
    } catch (error) {
      releaseStream()
      stopStream(stream)
      if (sessionRef.current !== id) return
      commit({ type: 'error', code: micErrorCode(error) })
      return
    }
    if (sessionRef.current !== id) {
      stopRecorder('discard')
      return
    }
    commit({ type: 'started' })
    watchSilence(id, stream)
  }

  function bindRecognition(recognition: BrowserRecognition, id: number): void {
    recognition.continuous = false
    recognition.interimResults = true
    recognition.lang = 'en-US'
    recognition.onstart = () => {
      if (sessionRef.current !== id) safeStop(recognition)
    }
    recognition.onend = () => {
      if (sessionRef.current !== id) return
      if (phaseRef.current.phase === 'fallback') commit({ type: 'accept' })
    }
    recognition.onerror = (event) => {
      if (sessionRef.current !== id) return
      commit({ type: 'error', code: event.error ?? '' })
    }
    recognition.onresult = (event) => {
      if (sessionRef.current !== id) return
      if (busyRef.current) return
      if (phaseRef.current.phase !== 'fallback') return
      const next = composeDictation(baseRef.current, chunksFromResultList(event.results ?? []))
      if (next === echoRef.current) return
      echoRef.current = next
      onChangeRef.current(next)
    }
  }

  function startWebSpeech(id: number): void {
    const Ctor = recognitionCtor()
    if (Ctor === null) {
      commit({ type: 'reject', message: 'Parakeet is not loaded.' })
      return
    }
    let recognition: BrowserRecognition
    try {
      recognition = new Ctor()
    } catch (error) {
      commit(eventFromStartFailure(error))
      return
    }
    bindRecognition(recognition, id)
    const previous = recognitionRef.current
    recognitionRef.current = recognition
    safeStop(previous)
    try {
      recognition.start()
    } catch (error) {
      commit(eventFromStartFailure(error))
    }
  }

  function toggle(): void {
    const intent = dictateIntent(phaseRef.current)
    if (intent === 'none') return
    if (intent === 'stop') {
      finish()
      return
    }
    if (!mediaRecorderAvailable()) {
      commit({ type: 'probe', supported: false })
      return
    }
    baseRef.current = valueRef.current
    discardRef.current = false
    stoppingRef.current = false
    commit({ type: 'arm' })
    const id = ++sessionRef.current
    void beginRecording(id)
  }

  function onEdit(next: string): void {
    halt()
    echoRef.current = next
    onChangeRef.current(next)
  }

  useEffect(() => {
    onChangeRef.current = input.onChange
    valueRef.current = input.value
    busyRef.current = input.busy
  }, [input.onChange, input.value, input.busy])

  useEffect(() => {
    if (!input.busy) return
    halt()
  }, [input.busy])

  useEffect(() => {
    if (input.value === echoRef.current) return
    echoRef.current = input.value
    halt()
  }, [input.value])

  useEffect(() => {
    return () => {
      sessionRef.current += 1
      discardRef.current = true
      abortRef.current?.abort()
      window.clearInterval(timerRef.current)
      const meter = meterRef.current
      meterRef.current = null
      if (meter) void meter.context.close().catch(() => undefined)
      const recorder = recorderRef.current
      if (recorder && recorder.state === 'recording') {
        try {
          recorder.stop()
        } catch {
          // already stopped
        }
      }
      stopStream(streamRef.current)
      safeStop(recognitionRef.current)
    }
  }, [])

  const mode = dictationMode(state)
  return {
    mode,
    unavailable: state.phase === 'unsupported',
    label: dictationLabel(state),
    line: (appStatus: string) =>
      shownCommandStatus(appStatus, dictationNotice(state), mode === 'listening', input.busy),
    toggle,
    finish,
    onEdit,
    halt,
  }
}
