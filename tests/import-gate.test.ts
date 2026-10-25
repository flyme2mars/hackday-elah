import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSharedGate } from '../src/host/importGate.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test('shared keys run the task once', async () => {
  const gate = createSharedGate(2)
  let calls = 0
  const first = gate.run(['vault:a', 'src:/flower.mp4'], 0, async () => {
    calls += 1
    return 'asset-1'
  })
  const second = gate.run(['vault:a'], 0, async () => {
    calls += 1
    return 'other'
  })
  const third = gate.run(['vault:b', 'src:/flower.mp4'], 0, async () => {
    calls += 1
    return 'another'
  })
  assert.equal(await first, 'asset-1')
  assert.equal(await second, 'asset-1')
  assert.equal(await third, 'asset-1')
  assert.equal(calls, 1)
  const again = gate.run(['src:/flower.mp4'], 0, async () => {
    calls += 1
    return 'fresh'
  })
  assert.equal(await again, 'asset-1')
  assert.equal(calls, 1)
})

test('concurrency stays at the limit', async () => {
  const gate = createSharedGate(2)
  let running = 0
  let peak = 0
  const tasks = Array.from({ length: 6 }, (_, index) =>
    gate.run([`vault:${index}`], 1, async () => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, 20))
      running -= 1
      return index
    }),
  )
  assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3, 4, 5])
  assert.equal(peak, 2)
  assert.equal(running, 0)
})

test('a visible import starts before a queued background import', async () => {
  const gate = createSharedGate(1)
  const blocker = deferred<string>()
  const started: string[] = []
  const hold = gate.run(['hold'], 1, () => blocker.promise)
  const background = gate.run(['background'], 1, async () => {
    started.push('background')
    return 'background'
  })
  const visible = gate.run(['visible'], 0, async () => {
    started.push('visible')
    return 'visible'
  })
  blocker.resolve('hold')
  await Promise.all([hold, visible, background])
  assert.deepEqual(started, ['visible', 'background'])
})

test('a failed import can be retried', async () => {
  const gate = createSharedGate(1)
  let calls = 0
  await assert.rejects(
    gate.run(['vault:retry'], 0, async () => {
      calls += 1
      throw new Error('busy')
    }),
    /busy/,
  )
  const second = gate.run(['vault:retry'], 0, async () => {
    calls += 1
    return 'ok'
  })
  assert.equal(await second, 'ok')
  assert.equal(calls, 2)
})
