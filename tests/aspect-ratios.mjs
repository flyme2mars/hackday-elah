import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

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
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  let ops = []
  const requests = []
  await page.route('**/api/v1/command', (route) => {
    requests.push(route.request().postDataJSON())
    return route.fulfill({ json: { planner: 'test', ops, hits: {}, note: '' } })
  })
  const url = process.env.TEST_BASE_URL || 'http://127.0.0.1:43123'
  await page.goto(`${url}/?debug=1`)
  await page.getByRole('textbox', { name: 'Agent command' }).waitFor()
  const control = page.getByRole('combobox', { name: 'Project aspect ratio' })
  assert.equal(await control.count(), 1, 'Aspect ratio control is available')
  const snapshot = async () =>
    JSON.parse(await page.locator('.debug-json').textContent())
  const input = page.getByRole('textbox', { name: 'Agent command' })
  async function command(text, nextOps) {
    ops = nextOps
    await input.fill(text)
    await input.press('Enter')
    await page.waitForFunction(
      () =>
        document.querySelector('.command-input').value === '' &&
        !document.querySelector('.command-input').disabled,
    )
  }
  assert.deepEqual((await snapshot()).stage, { width: 1080, height: 1920 })
  await command('add a title', [
    {
      op: 'add_text',
      content: 'Frame Flow',
      start_s: 0,
      duration_s: 0.1,
      font_size: 90,
    },
  ])
  const clipId = (await snapshot()).tracks.find((track) => track.alias === 'T1')
    .clips[0].id
  for (const [label, width, height] of [
    ['16:9', 1920, 1080],
    ['1:1', 1080, 1080],
    ['4:5', 1080, 1350],
    ['9:16', 1080, 1920],
  ]) {
    const option = control.locator('option').filter({ hasText: label }).first()
    await control.selectOption(await option.getAttribute('value'))
    assert.deepEqual(
      (await snapshot()).stage,
      { width, height },
      `Engine stage follows ${label}`,
    )
    assert.match(
      await page.locator('.project-format').innerText(),
      new RegExp(`${width} × ${height}`),
    )
    assert.match(
      await control.locator('option:checked').innerText(),
      new RegExp(label),
    )
    assert.equal(
      (await snapshot()).tracks.find((track) => track.alias === 'T1').clips[0]
        .id,
      clipId,
      'Changing format preserves clips',
    )
    await page.waitForFunction((ratio) => {
      const border = document.querySelector(
        '.stage-canvas [style*="--elah-stage-border"]',
      )
      if (!border) return false
      const box = border.getBoundingClientRect()
      return Math.abs(box.width / box.height - ratio) < 0.02
    }, width / height)
    const downloading = page.waitForEvent('download', { timeout: 20000 })
    await page.getByRole('button', { name: 'Export', exact: true }).click()
    const download = await downloading
    const bytes = await readFile(await download.path())
    const metadata = await page.evaluate(
      (base64) =>
        new Promise((resolve, reject) => {
          const data = Uint8Array.from(atob(base64), (character) =>
            character.charCodeAt(0),
          )
          const url = URL.createObjectURL(
            new Blob([data], { type: 'video/mp4' }),
          )
          const video = document.createElement('video')
          video.onloadedmetadata = () => {
            resolve({ width: video.videoWidth, height: video.videoHeight })
            URL.revokeObjectURL(url)
          }
          video.onerror = () => {
            URL.revokeObjectURL(url)
            reject(new Error('Exported MP4 metadata could not be read'))
          }
          video.src = url
        }),
      bytes.toString('base64'),
    )
    const scale = 720 / Math.min(width, height)
    assert.deepEqual(
      metadata,
      {
        width: Math.round((width * scale) / 2) * 2,
        height: Math.round((height * scale) / 2) * 2,
      },
      `Real exported MP4 follows ${label}`,
    )
    await page.screenshot({
      path: `/tmp/frame-flow-aspect-${width}x${height}.png`,
    })
    await command('read project state', [])
    assert.deepEqual(
      requests.at(-1).timeline.stage,
      { width, height },
      'Command context uses the same stage',
    )
  }
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  assert.deepEqual(
    (await snapshot()).stage,
    { width: 1080, height: 1350 },
    'A preset change is one undo step',
  )
  await page.getByRole('button', { name: 'Redo', exact: true }).click()
  assert.deepEqual((await snapshot()).stage, { width: 1080, height: 1920 })
  // Agent sizes need not match a preset's exact pixel dimensions.
  await command('set stage', [{ op: 'set_stage', width: 1600, height: 900 }])
  assert.deepEqual((await snapshot()).stage, { width: 1600, height: 900 })
  assert.match(await page.locator('.project-format').innerText(), /1600 × 900/)
  assert.match(await control.locator('option:checked').innerText(), /16:9/)
  await command('set an unusual stage', [
    { op: 'set_stage', width: 1200, height: 800 },
  ])
  assert.match(await control.locator('option:checked').innerText(), /3:2/)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  assert.deepEqual((await snapshot()).stage, { width: 1600, height: 900 })
  await page.getByRole('button', { name: 'Redo', exact: true }).click()
  assert.deepEqual((await snapshot()).stage, { width: 1200, height: 800 })
  await page.reload()
  assert.deepEqual(
    (await snapshot()).stage,
    { width: 1080, height: 1920 },
    'Reload retains the original demo default',
  )
  await page.setViewportSize({ width: 390, height: 844 })
  await control.waitFor({ state: 'visible' })
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
  )
  console.log(
    'Aspect ratio UI passed: defaults, presets, Preview geometry, real MP4 dimensions, command context, agent sizes, undo/redo and mobile layout',
  )
} finally {
  await browser.close()
}
