import assert from 'node:assert/strict'
import test from 'node:test'
import { DictationRequestError, transcribeCommand } from '../src/sense/client.ts'

const originalFetch = globalThis.fetch

test.afterEach(() => {
  globalThis.fetch = originalFetch
})

test('transcribeCommand posts the blob and returns trimmed text', async () => {
  const audio = new Blob([Uint8Array.from([1, 2, 3, 4])], { type: 'audio/webm;codecs=opus' })
  let seen: { url: string; type: string; bytes: number } | null = null
  globalThis.fetch = async (input, init) => {
    const body = init?.body
    const bytes = body instanceof Blob ? body.size : 0
    seen = {
      url: String(input),
      type: new Headers(init?.headers).get('content-type') ?? '',
      bytes,
    }
    return new Response(JSON.stringify({ text: '  trim the flower  ' }), { status: 200 })
  }
  assert.equal(await transcribeCommand(audio), 'trim the flower')
  assert.deepEqual(seen, {
    url: '/api/v1/dictation',
    type: 'audio/webm;codecs=opus',
    bytes: 4,
  })
})

test('a 503 is Parakeet down, not a cloud error', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ detail: 'Parakeet is not loaded.' }), { status: 503 })
  await assert.rejects(
    () => transcribeCommand(new Blob([Uint8Array.from([1])], { type: 'audio/webm' })),
    (error: unknown) => {
      assert.ok(error instanceof DictationRequestError)
      assert.equal(error.reachable, false)
      assert.equal(error.message, 'Parakeet is not loaded.')
      return true
    },
  )
})

test('a network failure is unreachable and a 400 stays reachable', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch')
  }
  await assert.rejects(
    () => transcribeCommand(new Blob([Uint8Array.from([1])])),
    (error: unknown) => {
      assert.ok(error instanceof DictationRequestError)
      assert.equal(error.reachable, false)
      assert.equal(error.message, 'Sense worker is not running.')
      return true
    },
  )
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ detail: 'Expected an audio recording.' }), { status: 400 })
  await assert.rejects(
    () => transcribeCommand(new Blob([Uint8Array.from([1])], { type: 'audio/webm' })),
    (error: unknown) => {
      assert.ok(error instanceof DictationRequestError)
      assert.equal(error.reachable, true)
      assert.equal(error.message, 'Expected an audio recording.')
      return true
    },
  )
})
