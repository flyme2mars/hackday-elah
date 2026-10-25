// Production builds only. Alternate baseline/candidate URLs to control drift.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { SourceMap } from 'node:module'
import { chromium } from 'playwright'

const urls = (process.env.AUDIT_URLS || 'http://127.0.0.1:43124').split(',')
const runs = Number(process.env.AUDIT_RUNS || 5)
const size = Number(process.env.AUDIT_ASSETS || 300)
const output = process.env.AUDIT_OUTPUT || '/tmp/frame-flow-performance.json'
const profileDirectory = process.env.AUDIT_PROFILE_DIR
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH }
    : {}),
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ],
})
const results = []
const thumbnail = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="#333"/></svg>')}`

async function trial(url, index) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  })
  const page = await context.newPage()
  const errors = []
  const failures = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('response', (response) => {
    if (response.status() >= 400)
      failures.push(`${response.status()} ${response.url()}`)
  })
  const cdp = await context.newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  await cdp.send('Performance.enable')
  await page.addInitScript(() => {
    window.audit = { tasks: [], frames: [], start: 0 }
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        window.audit.tasks.push({
          start: entry.startTime,
          duration: entry.duration,
        })
    }).observe({ type: 'longtask', buffered: true })
  })
  let ops = []
  let mode = 'warmup'
  let requests = 0
  const hits = Array.from({ length: size }, (_, id) => ({
    vault_id: `audit/${id}.mp4`,
    name: `Clip ${String(id).padStart(4, '0')}`,
    kind: 'video',
    src: `${url}/samples/flower.mp4`,
    duration_s: 5.005,
    thumb: thumbnail,
  }))
  await page.route('**/api/v1/command', (route) => {
    requests++
    const body = route.request().postDataJSON()
    const selected = body.selected_clip_ids ?? []
    const returnedOps =
      mode === 'transform'
        ? selected.map((id) => ({
            op: 'set_transform',
            clip_id: id,
            rotation: 35,
            scale: 1.2,
          }))
        : mode === 'motion'
          ? selected.map((id) => ({
              op: 'set_motion',
              clip_id: id,
              property: 'scale',
              from: 1.2,
              to: 1.5,
              duration_s: 1,
            }))
          : ops
    return route.fulfill({
      json: {
        planner: 'audit',
        ops: returnedOps,
        hits: { video: mode === 'warmup' ? hits.slice(0, 1) : hits },
        note: '',
      },
    })
  })
  await page.goto(url, { waitUntil: 'networkidle' })
  const input = page.getByRole('textbox', { name: 'Agent command' })
  await input.waitFor()
  const emptyLoad = await page.evaluate(() => performance.now())
  async function start() {
    return page.evaluate(() => {
      window.audit.start = performance.now()
      return window.audit.start
    })
  }
  async function end(begin) {
    return page.evaluate(async (begin) => {
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      )
      return {
        ms: performance.now() - begin,
        long_tasks: window.audit.tasks
          .filter((t) => t.start >= begin)
          .map((t) => t.duration),
      }
    }, begin)
  }
  async function command(text) {
    await input.fill(text)
    const begin = await start()
    await input.press('Enter')
    await page.waitForFunction(
      () =>
        !document.querySelector('.command-input').disabled &&
        document.querySelector('.command-input').value === '',
    )
    return end(begin)
  }
  // One real import primes the shared URL. This isolates card work from hundreds
  // of duplicate metadata probes, not a claim about cold or unique vault files.
  ops = [
    {
      op: 'add_clip',
      vault_id: hits[0].vault_id,
      clip_id: 'warmup',
      track: 'V1',
      start_s: 0,
      duration_s: 1.5,
    },
  ]
  await command('place one clip')
  ops = []
  mode = 'search'
  const search = await command('find footage')
  assert.equal(await page.locator('.media-search .hit').count(), size)
  await page.waitForFunction(
    (size) =>
      document.querySelectorAll('.media-search .hit[draggable="true"]')
        .length === size,
    size,
  )
  await cdp.send('HeapProfiler.collectGarbage')
  const metrics = await cdp.send('Performance.getMetrics')
  const heap = metrics.metrics.find((m) => m.name === 'JSHeapUsedSize')?.value
  if (profileDirectory) {
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.start')
  }
  await input.fill('')
  const typingStart = await start()
  const text = 'trim the first clip then rotate both halves slightly'
  await input.pressSequentially(text)
  const typing = await end(typingStart)
  assert.equal(await input.inputValue(), text)
  if (profileDirectory) {
    const { profile } = await cdp.send('Profiler.stop')
    await mkdir(profileDirectory, { recursive: true })
    await writeFile(
      `${profileDirectory}/typing-${index}.cpuprofile`,
      JSON.stringify(profile),
    )
    const sourceFile = process.env.AUDIT_SOURCE_MAP
    if (sourceFile) {
      const map = new SourceMap(JSON.parse(await readFile(sourceFile, 'utf8')))
      const nodes = new Map(profile.nodes.map((node) => [node.id, node]))
      const groups = {}
      for (let i = 0; i < (profile.samples?.length ?? 0); i++) {
        const node = nodes.get(profile.samples[i])
        const frame = node.callFrame
        const entry = frame.url.includes('/assets/index-')
          ? map.findEntry(frame.lineNumber, frame.columnNumber)
          : null
        const key =
          entry?.originalSource || frame.url || frame.functionName || 'unknown'
        groups[key] = (groups[key] || 0) + (profile.timeDeltas?.[i] ?? 0) / 1000
      }
      await writeFile(
        `${profileDirectory}/typing-${index}-samples.json`,
        JSON.stringify(groups, null, 2),
      )
    }
  }
  ops = [
    { op: 'remove', clip_id: 'warmup' },
    ...[0, 1, 2].map((id) => ({
      op: 'add_clip',
      vault_id: hits[id].vault_id,
      clip_id: `clip${id}`,
      track: 'V1',
      start_s: id * 1.5,
      duration_s: 1.5,
    })),
  ]
  mode = 'place'
  const place = await command('place three clips')
  assert.equal(await page.locator('[data-clip-type="video"]').count(), 3)
  const first = page.locator('[data-clip-type="video"]').first()
  const box = await first.boundingBox()
  await first.click({ position: { x: box.width / 3, y: box.height / 2 } })
  await page.locator('.stage').focus()
  await page.keyboard.press('Shift+ArrowRight')
  const splitStart = await start()
  await page.keyboard.press('s')
  await page.waitForFunction(
    () =>
      document.querySelectorAll(
        '[data-clip-type="video"][data-selected="true"]',
      ).length === 2,
  )
  const split = await end(splitStart)
  mode = 'transform'
  const transform = await command('rotate and zoom both halves')
  mode = 'motion'
  const motion = await command('animate zoom on both halves')
  await page.locator('.stage').focus()
  const scrubStart = await start()
  for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowRight')
  const scrub = await end(scrubStart)
  let exportAttempt = null
  let exportOutcome = 'Not attempted in timing comparison'
  if (process.env.AUDIT_EXPORT === '1') {
    const exportStart = await start()
    await page.getByRole('button', { name: 'Export', exact: true }).click()
    try {
      await page.waitForFunction(
        () =>
          /Saved edit\.mp4|Export failed|cannot export|empty/i.test(
            document.querySelector('.status').textContent,
          ),
        undefined,
        { timeout: 30000 },
      )
      exportAttempt = await end(exportStart)
      exportOutcome = await page.locator('.status').innerText()
    } catch (error) {
      if (error.name !== 'TimeoutError') throw error
      exportOutcome = 'Failed audit deadline: no completion within 30 seconds'
    }
  }
  const output = {
    url,
    run: index,
    assets: size,
    cpu_throttle: 4,
    empty_load_ms: emptyLoad,
    search,
    typing,
    place,
    split,
    transform,
    motion,
    scrub,
    export_attempt: exportAttempt,
    export_outcome: exportOutcome,
    js_heap_bytes_after_gc: heap,
    requests,
    errors,
    failures,
  }
  assert.equal(requests, 5)
  assert.equal(await page.locator('[data-clip-type="video"]').count(), 4)
  assert.deepEqual(errors, [])
  assert.deepEqual(failures, [])
  await context.close()
  return output
}

try {
  for (let run = 0; run < runs; run++) {
    for (const url of urls) {
      const result = await trial(url, run)
      results.push(result)
      await writeFile(
        output,
        JSON.stringify(
          { chrome: browser.version(), platform: process.platform, results },
          null,
          2,
        ),
      )
      console.log(
        JSON.stringify({
          url,
          run,
          search_ms: result.search.ms,
          typing_ms: result.typing.ms,
          export: result.export_outcome,
        }),
      )
    }
  }
} finally {
  await browser.close()
}
