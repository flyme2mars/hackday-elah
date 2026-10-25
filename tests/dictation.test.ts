import assert from 'node:assert/strict'
import test from 'node:test'
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
  type DictationState,
} from '../src/host/dictation.ts'

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

test('composeDictation replaces an interim when a later list is final', () => {
  const base = 'cut the'
  const interim = chunksFromResultList([
    { isFinal: false, length: 1, 0: { transcript: 'flow' } },
  ])
  const finalList = chunksFromResultList([
    { isFinal: true, length: 1, 0: { transcript: 'flower' } },
  ])
  assert.equal(composeDictation(base, interim), 'cut the flow')
  assert.equal(composeDictation(base, finalList), 'cut the flower')
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

test('chunksFromResultList drops empty transcripts', () => {
  const chunks = chunksFromResultList([
    { isFinal: false, length: 1, 0: { transcript: '   ' } },
    { isFinal: true, length: 1, 0: { transcript: '' } },
    { isFinal: true, length: 0 },
    { isFinal: true, length: 1, 0: { transcript: ' flower ' } },
  ])
  assert.deepEqual(chunks, [{ text: 'flower', final: true }])
})

test('dictationMode reports arming as listening', () => {
  assert.equal(dictationMode(IDLE_DICTATION), 'idle')
  assert.equal(dictationMode({ phase: 'arming' }), 'listening')
  assert.equal(dictationMode({ phase: 'listening' }), 'listening')
  assert.equal(dictationMode({ phase: 'denied', reason: 'blocked' }), 'denied')
  assert.equal(dictationMode({ phase: 'unsupported' }), 'denied')
})

test('finalize then accept returns to idle, and a miss can fall back', () => {
  const listening = run([{ type: 'arm' }, { type: 'started' }])
  const finalizing = dictationReducer(listening, { type: 'finalize' })
  assert.deepEqual(finalizing, { phase: 'finalizing' })
  assert.equal(dictationMode(finalizing), 'listening')
  assert.equal(dictationNotice(finalizing), 'Transcribing…')
  assert.equal(dictateIntent(finalizing), 'stop')
  assert.deepEqual(dictationReducer(finalizing, { type: 'accept' }), { phase: 'idle' })
  const fallback = dictationReducer(finalizing, { type: 'fallback' })
  assert.equal(dictationNotice(fallback), 'Browser speech. Parakeet did not answer.')
  assert.equal(dictationMode(fallback), 'listening')
  const failed = dictationReducer(finalizing, { type: 'reject', message: 'Parakeet is not loaded.' })
  assert.deepEqual(failed, { phase: 'failed', message: 'Parakeet is not loaded.' })
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
    'Speech recognition is not available in this browser.',
  )
  assert.equal(
    dictationNotice({ phase: 'denied', reason: 'blocked' }),
    'Microphone access was denied.',
  )
  assert.equal(dictationNotice({ phase: 'denied', reason: 'missing' }), 'No microphone was found.')
  assert.equal(dictationLabel(IDLE_DICTATION), 'Start dictation')
  assert.equal(dictationLabel({ phase: 'arming' }), 'Stop dictation')
  assert.equal(dictationLabel({ phase: 'listening' }), 'Stop dictation')
  assert.equal(dictationLabel({ phase: 'unsupported' }), 'Speech recognition unavailable')
  assert.equal(dictationLabel({ phase: 'denied', reason: 'blocked' }), 'Microphone denied')
  assert.equal(dictationLabel({ phase: 'denied', reason: 'missing' }), 'No microphone')
})
