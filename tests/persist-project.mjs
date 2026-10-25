// With Vite running: node tests/persist-project.mjs
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ],
})

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  let ops = []
  let hits = {}
  await page.route('**/api/v1/command', (route) =>
    route.fulfill({ json: { planner: 'test', ops, hits, note: '' } }),
  )
  await page.route('**/api/library', (route) => route.fulfill({ json: { items: [] } }))
  const url = process.env.TEST_BASE_URL || 'http://127.0.0.1:43123'
  await page.goto(`${url}/?debug=1`)
  await page.locator('[data-project-ready="true"]').waitFor()
  await page.evaluate(() => localStorage.removeItem('frameflow.project'))
  await page.reload()
  await page.locator('[data-project-ready="true"]').waitFor()
  const input = page.getByRole('textbox', { name: 'Agent command' })
  const snapshot = async () => JSON.parse(await page.locator('.debug-json').textContent())
  async function command(text, nextOps, nextHits = {}) {
    ops = nextOps
    hits = nextHits
    await input.fill(text)
    await input.press('Enter')
    await page.waitForFunction(
      () =>
        document.querySelector('.command-input').value === '' &&
        !document.querySelector('.command-input').disabled,
    )
  }

  assert.equal(await page.locator('.project-name').innerText(), 'Untitled')
  assert.equal(await page.getByRole('button', { name: 'New project' }).count(), 1)
  await page.getByText('Your library is empty', { exact: true }).waitFor()

  await command(
    'cut the flower',
    [
      {
        op: 'add_clip',
        vault_id: 'flower.mp4',
        clip_id: 'flower',
        track: 'V1',
        start_s: 0,
        duration_s: 4,
      },
      {
        op: 'add_clip',
        vault_id: 'bunny.mp4',
        clip_id: 'bunny',
        track: 'V1',
        start_s: 4,
        duration_s: 4,
      },
      {
        op: 'add_text',
        content: 'Frame Flow',
        start_s: 0,
        duration_s: 3,
        font_size: 72,
      },
      {
        op: 'set_transform',
        clip_id: 'flower',
        rotation: 15,
        scale: 1.2,
      },
      {
        op: 'set_motion',
        clip_id: 'flower',
        property: 'rotation',
        keys: [
          { t_s: 0, value: 15 },
          { t_s: 2, value: 45 },
        ],
      },
      {
        op: 'crossfade',
        from_clip_id: 'flower',
        to_clip_id: 'bunny',
        duration_s: 0.5,
      },
    ],
    {
      video: [
        {
          vault_id: 'flower.mp4',
          name: 'Flower',
          kind: 'video',
          duration_s: 5,
          src: '/samples/flower.mp4',
        },
        {
          vault_id: 'bunny.mp4',
          name: 'Bunny',
          kind: 'video',
          duration_s: 8,
          src: '/samples/bunny.mp4',
        },
      ],
    },
  )

  const aspect = page.getByRole('combobox', { name: 'Project aspect ratio' })
  await aspect.selectOption({ label: '16:9 · Landscape' })
  await page.locator('input[type=file]').setInputFiles({
    name: 'dot.png',
    mimeType: 'image/png',
    buffer: PNG,
  })
  await page.locator('.media-library').getByRole('button', { name: /^dot\.png/ }).click()
  await page.waitForFunction(
    () => document.querySelector('.debug-json')?.textContent?.includes('"type": "image"'),
  )
  await page.locator('.timeline-pane').click()
  await page.keyboard.press('Shift+ArrowRight')
  const timecode = (await page.locator('.timecode').innerText()).trim()
  assert.notEqual(timecode.split('/')[0].trim(), '00:00:00:00')

  await page.waitForFunction(() => {
    const raw = localStorage.getItem('frameflow.project')
    if (!raw) return false
    const data = JSON.parse(raw)
    const clips = Object.values(data.project?.clips ?? {}).flat()
    return (
      data.schema === 1 &&
      data.project?.stage?.width === 1920 &&
      data.playheadFrame > 0 &&
      clips.some((clip) => clip.name === 'Flower' && clip.hostMotion?.rotation) &&
      clips.some((clip) => clip.content === 'Frame Flow') &&
      (data.project?.transitions?.length ?? 0) > 0 &&
      data.library.some((item) => item.vaultId === 'flower.mp4' && item.durable === true) &&
      data.library.some((item) => item.vaultId === 'upload/dot.png' && item.durable === false)
    )
  })

  await page.reload()
  await page.locator('[data-project-ready="true"]').waitFor()
  const restored = await snapshot()
  assert.deepEqual(restored.stage, { width: 1920, height: 1080 })
  const flower = restored.tracks.flatMap((track) => track.clips).find((clip) => clip.name === 'Flower')
  assert.ok(flower, 'vault clip returns after refresh')
  assert.equal(flower.rotation_deg, 15)
  assert.equal(flower.scale, 1.2)
  assert.ok(flower.motion?.rotation?.length >= 2)
  const title = restored.tracks.flatMap((track) => track.clips).find((clip) => clip.type === 'text')
  assert.equal(title?.content, 'Frame Flow')
  assert.ok(restored.transitions.length > 0, 'crossfade returns after refresh')
  assert.equal(
    restored.tracks.flatMap((track) => track.clips).some((clip) => clip.type === 'image'),
    true,
    'uploaded still returns after refresh',
  )
  assert.equal(await page.locator('.media-library').getByRole('button', { name: /^Flower/ }).count(), 1)
  assert.equal(await page.locator('.media-library').getByRole('button', { name: /^Bunny/ }).count(), 1)
  assert.equal(await page.locator('.media-library').getByRole('button', { name: /^dot\.png/ }).count(), 1)
  assert.equal((await page.locator('.timecode').innerText()).trim(), timecode)
  assert.match(await page.locator('.project-format').innerText(), /1920 × 1080/)

  await page.getByRole('button', { name: 'New project' }).click()
  await page.locator('[data-project-ready="true"]').waitFor()
  await page.getByText('Your library is empty', { exact: true }).waitFor()
  await page.waitForFunction(() => {
    const raw = localStorage.getItem('frameflow.project')
    if (!raw) return false
    const data = JSON.parse(raw)
    const clips = Object.values(data.project?.clips ?? {}).flat()
    return clips.length === 0 && data.library.length === 0 && data.project.stage.width === 1080
  })
  const cleared = await snapshot()
  assert.equal(
    cleared.tracks.every((track) => track.clips.length === 0),
    true,
  )
  assert.deepEqual(cleared.stage, { width: 1080, height: 1920 })
  assert.equal(cleared.transitions.length, 0)

  await page.reload()
  await page.locator('[data-project-ready="true"]').waitFor()
  await page.getByText('Your library is empty', { exact: true }).waitFor()
  const stayed = await snapshot()
  assert.equal(
    stayed.tracks.every((track) => track.clips.length === 0),
    true,
  )
  assert.deepEqual(stayed.stage, { width: 1080, height: 1920 })
  assert.equal(await page.locator('.media-library').getByRole('button', { name: /^Flower/ }).count(), 0)
  assert.equal(await page.locator('.media-library').getByRole('button', { name: /^dot\.png/ }).count(), 0)
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
}
