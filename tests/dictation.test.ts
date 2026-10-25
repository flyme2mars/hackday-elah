import assert from 'node:assert/strict'
import test from 'node:test'
import {
  IDLE_DICTATION,
  composeDictation,
  dictateIntent,
  dictationLabel,
  dictationMode,
  dictationNotice,
  dictationReducer,
  holdAction,
  parakeetFailureMessage,
  shownCommandStatus,
  type DictationChord,
  type DictationEvent,
  type DictationState,
} from '../src/host/dictation.ts'
import { DictationRequestError } from '../src/sense/client.ts'

function run(events: readonly DictationEvent[], start: DictationState = IDLE_DICTATION): DictationState {
  let state = start
  for (const event of events) state = dictationReducer(state, event)
  return state
}

const listening = (): DictationState => run([{ type: 'arm' }, { type: 'started' }])

test('second halt stays idle', () => {
  const once = dictationReducer(IDLE_DICTATION, { type: 'halt' })
  const twice = dictationReducer(once, { type: 'halt' })
  assert.deepEqual(once, { phase: 'idle' })
  assert.deepEqual(twice, { phase: 'idle' })
})

test('second arm stays arming', () => {
  const once = dictationReducer(IDLE_DICTATION, { type: 'arm' })
  const twice = dictationReducer(once, { type: 'arm' })
  assert.deepEqual(once, { phase: 'arming' })
  assert.deepEqual(twice, { phase: 'arming' })
})

test('probe supported false then probe supported true stays unsupported', () => {
  const unsupported = dictationReducer(IDLE_DICTATION, { type: 'probe', supported: false })
  const again = dictationReducer(unsupported, { type: 'probe', supported: true })
  assert.deepEqual(unsupported, { phase: 'unsupported' })
  assert.deepEqual(again, { phase: 'unsupported' })
})

test('not-allowed from listening becomes denied blocked', () => {
  const state = dictationReducer(listening(), { type: 'error', code: 'not-allowed' })
  assert.deepEqual(state, { phase: 'denied', reason: 'blocked' })
  const service = dictationReducer(listening(), { type: 'error', code: 'service-not-allowed' })
  assert.deepEqual(service, { phase: 'denied', reason: 'blocked' })
})

test('audio-capture becomes denied missing', () => {
  const state = dictationReducer(listening(), { type: 'error', code: 'audio-capture' })
  assert.deepEqual(state, { phase: 'denied', reason: 'missing' })
})

test('unknown error from listening becomes idle', () => {
  const state = dictationReducer(listening(), { type: 'error', code: 'xyz' })
  assert.deepEqual(state, { phase: 'idle' })
})

test('unknown error from denied stays denied', () => {
  const denied: DictationState = { phase: 'denied', reason: 'blocked' }
  const state = dictationReducer(denied, { type: 'error', code: 'xyz' })
  assert.deepEqual(state, { phase: 'denied', reason: 'blocked' })
})

test('ended from listening becomes idle', () => {
  assert.deepEqual(dictationReducer(listening(), { type: 'ended' }), { phase: 'idle' })
})

test('dictateIntent maps unsupported, listening, idle, and denied', () => {
  const unsupported = dictationReducer(IDLE_DICTATION, { type: 'probe', supported: false })
  assert.equal(dictateIntent(unsupported), 'none')
  assert.equal(dictateIntent(listening()), 'stop')
  assert.equal(dictateIntent(IDLE_DICTATION), 'start')
  assert.equal(dictateIntent({ phase: 'denied', reason: 'missing' }), 'start')
})

test('shownCommandStatus prefers busy, then a notice, then listening', () => {
  const denied = 'Microphone access was denied.'
  assert.equal(shownCommandStatus('Searching\u2026', denied, true, true), 'Searching\u2026')
  assert.equal(shownCommandStatus('Title added.', denied, false, false), denied)
  assert.equal(shownCommandStatus('', null, true, false), 'Listening\u2026')
  assert.equal(shownCommandStatus('', null, false, false), 'Ready')
})

test('composeDictation replaces an interim when a later chunk is final', () => {
  const base = 'cut the'
  assert.equal(composeDictation(base, [{ text: 'flow', final: false }]), 'cut the flow')
  assert.equal(composeDictation(base, [{ text: 'flower', final: true }]), 'cut the flower')
})

test('composeDictation keeps a trailing space on the base', () => {
  assert.equal(composeDictation('cut the ', [{ text: 'flower', final: true }]), 'cut the flower')
})

test('composeDictation of an empty list returns the base', () => {
  assert.equal(composeDictation('cut the', []), 'cut the')
})

test('a final clears the interim ahead of it in the same list', () => {
  assert.equal(
    composeDictation('cut the', [
      { text: 'flow', final: false },
      { text: 'flower', final: true },
    ]),
    'cut the flower',
  )
})

test('a later interim replaces the earlier interim', () => {
  assert.equal(
    composeDictation('cut the', [
      { text: 'flow', final: false },
      { text: 'flower', final: false },
    ]),
    'cut the flower',
  )
})

test('dictationMode reports arming as listening', () => {
  assert.equal(dictationMode(IDLE_DICTATION), 'idle')
  assert.equal(dictationMode({ phase: 'arming' }), 'listening')
  assert.equal(dictationMode({ phase: 'listening' }), 'listening')
  assert.equal(dictationMode({ phase: 'denied', reason: 'blocked' }), 'denied')
  assert.equal(dictationMode({ phase: 'unsupported' }), 'denied')
})

test('finalize then accept returns to idle, and a Parakeet miss stays failed', () => {
  const listening = run([{ type: 'arm' }, { type: 'started' }])
  const finalizing = dictationReducer(listening, { type: 'finalize' })
  assert.deepEqual(finalizing, { phase: 'finalizing' })
  assert.equal(dictationMode(finalizing), 'listening')
  assert.equal(dictationNotice(finalizing), 'Transcribing…')
  assert.equal(dictateIntent(finalizing), 'stop')
  assert.deepEqual(dictationReducer(finalizing, { type: 'accept' }), { phase: 'idle' })
  const failed = dictationReducer(finalizing, { type: 'reject', message: 'Parakeet is not loaded.' })
  assert.deepEqual(failed, { phase: 'failed', message: 'Parakeet is not loaded.' })
  assert.equal(dictationNotice(failed), 'Parakeet is not loaded.')
  assert.equal(dictationMode(failed), 'idle')
  assert.equal(dictateIntent(failed), 'start')
  assert.deepEqual(dictationReducer(failed, { type: 'arm' }), { phase: 'arming' })
  assert.deepEqual(dictationReducer(failed, { type: 'halt' }), { phase: 'idle' })
})

test('dictationNotice and dictationLabel use the mic copy', () => {
  assert.equal(dictationNotice(IDLE_DICTATION), null)
  assert.equal(dictationNotice({ phase: 'arming' }), null)
  assert.equal(dictationNotice({ phase: 'listening' }), null)
  assert.equal(
    dictationNotice({ phase: 'unsupported' }),
    'Microphone recording is not available in this browser.',
  )
  assert.equal(
    dictationNotice({ phase: 'denied', reason: 'blocked' }),
    'Microphone access was denied.',
  )
  assert.equal(dictationNotice({ phase: 'denied', reason: 'missing' }), 'No microphone was found.')
  assert.equal(dictationLabel(IDLE_DICTATION), 'Start dictation')
  assert.equal(dictationLabel({ phase: 'arming' }), 'Stop dictation')
  assert.equal(dictationLabel({ phase: 'listening' }), 'Stop dictation')
  assert.equal(dictationLabel({ phase: 'unsupported' }), 'Microphone unavailable')
  assert.equal(dictationLabel({ phase: 'denied', reason: 'blocked' }), 'Microphone denied')
  assert.equal(dictationLabel({ phase: 'denied', reason: 'missing' }), 'No microphone')
})

function chord(patch: Partial<DictationChord>): DictationChord {
  return {
    type: 'down',
    code: 'AltLeft',
    key: 'Alt',
    repeat: false,
    ctrl: false,
    meta: false,
    shift: false,
    composing: false,
    focus: 'shell',
    ...patch,
  }
}

test('Option down starts a hold and Option up sends it', () => {
  assert.equal(holdAction(chord({}), 'idle', false, null).type, 'start')
  assert.equal(holdAction(chord({ code: 'AltRight' }), 'denied', false, null).type, 'start')
  assert.equal(holdAction(chord({ type: 'up', code: 'AltLeft' }), 'listening', false, 'AltLeft').type, 'send')
  assert.equal(holdAction(chord({ type: 'up', code: 'AltLeft' }), 'arming', false, 'AltLeft').type, 'send')
})

test('Option hold ignores repeat, other text fields, busy, and an in-flight take', () => {
  assert.equal(holdAction(chord({ repeat: true }), 'idle', false, null).type, 'ignore')
  assert.equal(holdAction(chord({ focus: 'field' }), 'idle', false, null).type, 'ignore')
  assert.equal(holdAction(chord({ focus: 'command' }), 'idle', false, null).type, 'start')
  assert.equal(holdAction(chord({}), 'idle', true, null).type, 'ignore')
  assert.equal(holdAction(chord({}), 'finalizing', false, null).type, 'ignore')
  assert.equal(holdAction(chord({}), 'listening', false, null).type, 'ignore')
  assert.equal(holdAction(chord({ shift: true }), 'idle', false, null).type, 'ignore')
})

test('Escape cancels a take and another key yields the hold without preventing the character', () => {
  const escape = holdAction(chord({ code: 'Escape', key: 'Escape' }), 'listening', false, 'AltLeft')
  assert.deepEqual(escape, { type: 'cancel', prevent: true })
  assert.deepEqual(
    holdAction(chord({ code: 'Escape', key: 'Escape' }), 'finalizing', false, null),
    { type: 'cancel', prevent: true },
  )
  assert.equal(holdAction(chord({ code: 'Escape', key: 'Escape' }), 'idle', false, null).type, 'ignore')
  const letter = holdAction(chord({ code: 'KeyA', key: 'a', focus: 'command' }), 'listening', false, 'AltLeft')
  assert.deepEqual(letter, { type: 'cancel', prevent: false })
})

test('a Parakeet 503 or timeout names Parakeet and does not describe browser speech', () => {
  const down = new DictationRequestError('Parakeet is not loaded.', false)
  assert.equal(parakeetFailureMessage(down), 'Parakeet is not loaded.')
  const timeout = new Error('timed out')
  timeout.name = 'TimeoutError'
  assert.equal(parakeetFailureMessage(timeout), 'Parakeet is not loaded.')
  const rejected = new DictationRequestError('Expected an audio recording.', true)
  assert.equal(parakeetFailureMessage(rejected), 'Expected an audio recording.')
  assert.equal(parakeetFailureMessage(down).includes('Browser'), false)
})
