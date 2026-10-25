interface Job<T> {
  priority: number
  seq: number
  started: boolean
  task: () => Promise<T>
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

/**
 * Runs tasks with a concurrency cap. Calls that share a key join one in-flight
 * task. A lower priority number starts before a higher one still waiting.
 * Successful results stay shared; failures drop their keys so a later call retries.
 */
export function createSharedGate(limit: number) {
  if (limit < 1) throw new Error('import concurrency must be at least 1')
  let active = 0
  let seq = 0
  const queue: Job<unknown>[] = []
  const byKey = new Map<string, Job<unknown>>()

  function pump() {
    const pending = queue
      .filter((job) => !job.started)
      .sort((a, b) => a.priority - b.priority || a.seq - b.seq)
    for (const job of pending) {
      if (active >= limit) break
      job.started = true
      const index = queue.indexOf(job)
      if (index >= 0) queue.splice(index, 1)
      active += 1
      void (async () => {
        try {
          job.resolve(await job.task())
        } catch (error) {
          job.reject(error)
        } finally {
          active -= 1
          pump()
        }
      })()
    }
  }

  function forget(job: Job<unknown>) {
    for (const [key, current] of byKey) {
      if (current === job) byKey.delete(key)
    }
  }

  function run<T>(keys: readonly string[], priority: number, task: () => Promise<T>): Promise<T> {
    const usable = [...new Set(keys.filter((key) => key.length > 0))]
    for (const key of usable) {
      const existing = byKey.get(key)
      if (!existing) continue
      for (const extra of usable) byKey.set(extra, existing)
      if (!existing.started && priority < existing.priority) existing.priority = priority
      return existing.promise as Promise<T>
    }

    let resolve!: (value: T) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    const job: Job<T> = {
      priority,
      seq: seq++,
      started: false,
      task,
      promise,
      resolve,
      reject,
    }
    const stored = job as Job<unknown>
    const identity = usable.length > 0 ? usable : [`anon:${job.seq}`]
    queue.push(stored)
    for (const key of identity) byKey.set(key, stored)
    promise.then(
      () => undefined,
      () => forget(stored),
    )
    pump()
    return promise
  }

  return { run }
}
