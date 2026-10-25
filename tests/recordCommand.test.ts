import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DICTATION_LEADING_SILENCE_MS,
  DICTATION_MAX_MS,
  DICTATION_TRAILING_SILENCE_MS,
  preferredAudioMime,
  recordingStop,
} from '../src/host/recordCommand.ts'

test('recording keeps going while speech is recent', () => {
  assert.equal(
    recordingStop({ elapsedMs: 5_000, silentMs: 200, heardSpeech: true }),
    null,
  )
})

test('trailing silence stops after speech', () => {
  assert.equal(
    recordingStop({
      elapsedMs: 4_000,
      silentMs: DICTATION_TRAILING_SILENCE_MS,
      heardSpeech: true,
    }),
    'silence',
  )
})

test('leading silence stops a take that never heard speech', () => {
  assert.equal(
    recordingStop({
      elapsedMs: DICTATION_LEADING_SILENCE_MS,
      silentMs: DICTATION_LEADING_SILENCE_MS,
      heardSpeech: false,
    }),
    'silence',
  )
  assert.equal(
    recordingStop({ elapsedMs: DICTATION_LEADING_SILENCE_MS - 1, silentMs: 2_999, heardSpeech: false }),
    null,
  )
})

test('hold-to-talk ignores silence and still stops at the cap', () => {
  assert.equal(
    recordingStop({ elapsedMs: 5_000, silentMs: 5_000, heardSpeech: true }, false),
    null,
  )
  assert.equal(
    recordingStop({ elapsedMs: DICTATION_MAX_MS, silentMs: 0, heardSpeech: false }, false),
    'max',
  )
})

test('the duration cap stops a long take', () => {
  assert.equal(
    recordingStop({ elapsedMs: DICTATION_MAX_MS, silentMs: 0, heardSpeech: true }),
    'max',
  )
})

test('preferredAudioMime uses the first supported webm or ogg type', () => {
  assert.equal(
    preferredAudioMime((mime) => mime === 'audio/webm'),
    'audio/webm',
  )
  assert.equal(preferredAudioMime(() => false), '')
})
