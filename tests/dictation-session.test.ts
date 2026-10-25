import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { DictationRequestError } from '../src/sense/client.ts'
import {
  createDictationSession,
  type DictationPorts,
  type DictationSession,
  type TakeRecorder,
} from '../src/host/dictationSession.ts'
import type { DictationChord } from '../src/host/dictation.ts'

class FakeRecorder implements TakeRecorder {
  state = 'inactive'
  mimeType = 'audio/webm'
  ondataavailable: ((event: { readonly data: Blob }) => void) | null = null
  onstop: (() => void) | null = null

  start(): void {
    this.state = 'recording'
  }

  stop(): void {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob([new Uint8Array(64)], { type: 'audio/webm' }) })
    this.onstop?.()
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

function alt(type: 'down' | 'up', patch: Partial<DictationChord> = {}): DictationChord {
  return {
    type,
    code: 'AltLeft',
    key: 'Alt',
    repeat: false,
    ctrl: false,
    meta: false,
    shift: false,
    composing: false,
    focus: 'command',
    ...patch,
  }
}

type Harness = {
  session: DictationSession
  command: () => string
  posts: () => number
  mics: () => number
  releaseMic: (stream?: MediaStream) => void
  clock: { now: number }
  fireTimer: () => void
}

function harness(transcribe: DictationPorts['transcribe'], command = 'cut'): Harness {
  let value = command
  let posts = 0
  let mics = 0
  let release: ((stream: MediaStream) => void) | null = null
  const timers: Array<() => void> = []
  const clock = { now: 0 }
  const wrapped: DictationPorts['transcribe'] = async (audio, signal) => {
    posts += 1
    return transcribe(audio, signal)
  }
  const ports: DictationPorts = {
    now: () => clock.now,
    setInterval: (fn) => {
      timers.push(fn)
      return timers.length
    },
    clearInterval: () => {
      timers.length = 0
    },
    openMic: () => {
      mics += 1
      return new Promise((resolve) => {
        release = resolve
      })
    },
    isTypeSupported: () => true,
    preferredMime: () => 'audio/webm',
    createRecorder: () => new FakeRecorder(),
    openMeter: () => ({ loud: () => false, close() {} }),
    stopStream: () => undefined,
    transcribe: wrapped,
    onChange: (next) => {
      value = next
    },
    getValue: () => value,
    getBusy: () => false,
  }
  return {
    session: createDictationSession(ports, true, command),
    command: () => value,
    posts: () => posts,
    mics: () => mics,
    releaseMic: (stream = {} as MediaStream) => {
      const open = release
      release = null
      if (!open) throw new Error('mic was not requested')
      open(stream)
    },
    clock,
    fireTimer: () => {
      for (const fn of [...timers]) fn()
    },
  }
}

async function listen(box: Harness): Promise<void> {
  box.releaseMic()
  await tick()
  assert.equal(box.session.getState().phase, 'listening')
}

test('a second press while the mic is still opening still sends', async () => {
  const box = harness(async () => 'the flower')
  box.session.toggle()
  assert.equal(box.session.getState().phase, 'arming')
  box.session.toggle()
  assert.equal(box.posts(), 0)
  box.releaseMic()
  await tick()
  assert.equal(box.posts(), 1)
  assert.equal(box.command(), 'cut the flower')
  assert.equal(box.session.getState().phase, 'idle')
})

test('a second press while Parakeet is already working keeps the transcript', async () => {
  let finish: ((text: string) => void) | null = null
  const box = harness(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  box.session.toggle()
  await listen(box)
  box.session.toggle()
  assert.equal(box.session.getState().phase, 'finalizing')
  box.session.toggle()
  assert.equal(box.session.getState().phase, 'finalizing')
  finish?.('the flower')
  await tick()
  assert.equal(box.command(), 'cut the flower')
  assert.equal(box.session.getState().phase, 'idle')
})

test('typing or leaving the window cancels a hold without sending', async () => {
  const box = harness(async () => 'nope')
  box.session.key(alt('down'))
  await listen(box)
  box.session.noteValue('cut the')
  assert.equal(box.session.getState().phase, 'idle')
  assert.equal(box.posts(), 0)

  box.session.key(alt('down'))
  await listen(box)
  box.session.blur()
  assert.equal(box.session.getState().phase, 'idle')
  assert.equal(box.posts(), 0)
  box.session.key(alt('up'))
  await tick()
  assert.equal(box.posts(), 0)
})

test('button start then stop sends the clip to Parakeet', async () => {
  const box = harness(async () => 'the flower')
  box.session.toggle()
  assert.equal(box.session.getState().phase, 'arming')
  await listen(box)
  box.session.toggle()
  await tick()
  assert.equal(box.posts(), 1)
  assert.equal(box.command(), 'cut the flower')
  assert.equal(box.session.getState().phase, 'idle')
})

test('Option keydown then keyup sends the clip to Parakeet', async () => {
  const box = harness(async () => 'the flower')
  assert.equal(box.session.key(alt('down')), false)
  await listen(box)
  assert.equal(box.session.key(alt('up')), true)
  await tick()
  assert.equal(box.posts(), 1)
  assert.equal(box.command(), 'cut the flower')
  assert.equal(box.session.getState().phase, 'idle')
})

test('Escape while listening cancels without sending', async () => {
  const box = harness(async () => 'nope')
  box.session.key(alt('down'))
  await listen(box)
  assert.equal(box.session.key(alt('down', { type: 'down', code: 'Escape', key: 'Escape' })), true)
  assert.equal(box.session.getState().phase, 'idle')
  assert.equal(box.posts(), 0)
  assert.equal(box.command(), 'cut')
  box.session.key(alt('up'))
  await tick()
  assert.equal(box.posts(), 0)
  assert.equal(box.command(), 'cut')
})

test('Escape during a click take and during Parakeet does not insert text', async () => {
  let finish: ((text: string) => void) | null = null
  const box = harness(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  box.session.toggle()
  await listen(box)
  box.session.key(alt('down', { code: 'Escape', key: 'Escape' }))
  assert.equal(box.session.getState().phase, 'idle')
  assert.equal(box.posts(), 0)

  box.session.toggle()
  await listen(box)
  box.session.toggle()
  assert.equal(box.session.getState().phase, 'finalizing')
  assert.equal(box.posts(), 1)
  box.session.key(alt('down', { code: 'Escape', key: 'Escape' }))
  assert.equal(box.session.getState().phase, 'idle')
  finish?.('secret')
  await tick()
  assert.equal(box.command(), 'cut')
  assert.equal(box.session.getState().phase, 'idle')
})

test('a Parakeet 503 rejects with the Parakeet status and stays idle', async () => {
  const box = harness(async () => {
    throw new DictationRequestError('Parakeet is not loaded.', false)
  })
  box.session.toggle()
  await listen(box)
  box.session.toggle()
  await tick()
  const state = box.session.getState()
  assert.equal(state.phase, 'failed')
  if (state.phase === 'failed') assert.equal(state.message, 'Parakeet is not loaded.')
  assert.equal(box.command(), 'cut')
  assert.equal(box.session.key(alt('down', { type: 'up' })), false)
})

test('Option is ignored in another text field and yields when a character is typed', async () => {
  const box = harness(async () => 'nope')
  assert.equal(box.session.key(alt('down', { focus: 'field' })), false)
  assert.equal(box.session.getState().phase, 'idle')
  assert.equal(box.mics(), 0)

  box.session.key(alt('down'))
  await listen(box)
  const typed = box.session.key(alt('down', { code: 'KeyA', key: 'a' }))
  assert.equal(typed, false)
  assert.equal(box.session.getState().phase, 'idle')
  assert.equal(box.posts(), 0)
  box.session.key(alt('up'))
  await tick()
  assert.equal(box.posts(), 0)
  assert.equal(box.command(), 'cut')
})

test('hold-to-talk does not stop on silence and click mode does', async () => {
  const held = harness(async () => 'held')
  held.session.key(alt('down'))
  await listen(held)
  held.clock.now = 5_000
  held.fireTimer()
  assert.equal(held.session.getState().phase, 'listening')
  assert.equal(held.posts(), 0)

  const clicked = harness(async () => 'clicked')
  clicked.session.toggle()
  await listen(clicked)
  clicked.clock.now = 5_000
  clicked.fireTimer()
  await tick()
  assert.equal(clicked.posts(), 1)
  assert.equal(clicked.command(), 'cut clicked')
})

test('command dictation source does not call browser speech recognition', () => {
  for (const path of ['src/host/useDictation.ts', 'src/host/dictationSession.ts', 'src/host/dictation.ts']) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
    assert.equal(source.includes('webkitSpeechRecognition'), false, path)
    assert.equal(source.includes('SpeechRecognition'), false, path)
    assert.equal(source.includes("type: 'fallback'"), false, path)
    assert.equal(source.includes('startWebSpeech'), false, path)
  }
  const hook = readFileSync(new URL('../src/host/useDictation.ts', import.meta.url), 'utf8')
  assert.match(hook, /transcribeCommand/)
  assert.match(hook, /addEventListener\('keydown', onKey, true\)/)
  assert.match(hook, /addEventListener\('keyup', onKey, true\)/)
})
