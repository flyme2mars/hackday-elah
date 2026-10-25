import { useEffect, useRef, useState } from 'react'
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

function safeStop(recognition: BrowserRecognition | null): void {
  if (!recognition) return
  try {
    recognition.stop()
  } catch {
    // stop() throws when start() never succeeded.
  }
}

export function useDictation(input: DictationInput): DictationHandle {
  const onChangeRef = useRef(input.onChange)
  const valueRef = useRef(input.value)
  const busyRef = useRef(input.busy)

  const [state, setState] = useState<DictationState>(() =>
    dictationReducer(IDLE_DICTATION, {
      type: 'probe',
      supported: recognitionCtor() !== null,
    }),
  )
  const phaseRef = useRef(state)
  const echoRef = useRef(input.value)
  const baseRef = useRef(input.value)
  const recognitionRef = useRef<BrowserRecognition | null>(null)
  const sessionRef = useRef(0)

  function commit(event: DictationEvent): void {
    phaseRef.current = dictationReducer(phaseRef.current, event)
    setState(phaseRef.current)
  }

  function halt(): void {
    const phase = phaseRef.current.phase
    if (phase !== 'arming' && phase !== 'listening') return
    commit({ type: 'halt' })
    safeStop(recognitionRef.current)
  }

  function abandonStart(error: unknown): void {
    commit(eventFromStartFailure(error))
    const phase = phaseRef.current.phase
    if (phase === 'idle' || phase === 'denied') safeStop(recognitionRef.current)
  }

  function bindRecognition(recognition: BrowserRecognition, id: number): void {
    recognition.continuous = false
    recognition.interimResults = true
    recognition.lang = 'en-US'
    recognition.onstart = () => {
      if (sessionRef.current !== id) return
      if (phaseRef.current.phase !== 'arming') {
        safeStop(recognition)
        return
      }
      commit({ type: 'started' })
    }
    recognition.onend = () => {
      if (sessionRef.current !== id) return
      commit({ type: 'ended' })
    }
    recognition.onerror = (event) => {
      if (sessionRef.current !== id) return
      commit({ type: 'error', code: event.error ?? '' })
    }
    recognition.onresult = (event) => {
      if (sessionRef.current !== id) return
      if (busyRef.current) return
      const phase = phaseRef.current.phase
      if (phase !== 'arming' && phase !== 'listening') return
      const next = composeDictation(
        baseRef.current,
        chunksFromResultList(event.results ?? []),
      )
      if (next === echoRef.current) return
      echoRef.current = next
      onChangeRef.current(next)
    }
  }

  function toggle(): void {
    const intent = dictateIntent(phaseRef.current)
    if (intent === 'none') return
    if (intent === 'stop') {
      halt()
      return
    }
    const Ctor = recognitionCtor()
    if (Ctor === null) {
      commit({ type: 'probe', supported: false })
      return
    }
    baseRef.current = valueRef.current
    commit({ type: 'arm' })
    let recognition: BrowserRecognition
    try {
      recognition = new Ctor()
    } catch (error) {
      abandonStart(error)
      return
    }
    const id = ++sessionRef.current
    const previous = recognitionRef.current
    bindRecognition(recognition, id)
    recognitionRef.current = recognition
    safeStop(previous)
    try {
      recognition.start()
    } catch (error) {
      abandonStart(error)
    }
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
      // A late event from this mount must not settle the next one.
      sessionRef.current += 1
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
    onEdit,
    halt,
  }
}
