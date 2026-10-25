// With Vite running: CHROME_PATH=/path/to/chrome node tests/ui.mjs
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
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
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  let ops = []
  let hits = {}
  await page.route('**/api/library', (route) =>
    route.fulfill({
      json: {
        items: [
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
          {
            vault_id: 'bed.m4a',
            name: 'Bed',
            kind: 'audio',
            duration_s: 8,
            src: '/samples/bed.m4a',
          },
        ],
      },
    }),
  )
  await page.route('**/api/v1/command', (route) =>
    route.fulfill({ json: { ops, planner: 'test', hits, note: '' } }),
  )
  await page.goto(process.env.TEST_BASE_URL || 'http://127.0.0.1:43123')
  await page.getByText('Your library is empty', { exact: true }).waitFor()
  await page.getByText('Frame Flow', { exact: true }).waitFor()
  assert.equal(await page.locator('.project-name').innerText(), 'Untitled')
  assert.equal(await page.title(), 'Frame Flow')
  assert.equal(await page.getByRole('button', { name: /^Flower/ }).count(), 0)
  assert.equal(await page.getByRole('button', { name: /^Bunny/ }).count(), 0)
  assert.equal(await page.getByRole('button', { name: /^Bed/ }).count(), 0)
  assert.equal(await page.getByText('ELAH', { exact: true }).count(), 0)
  assert.equal(await page.getByText('Untitled sequence', { exact: true }).count(), 0)
  assert.equal(await page.getByText('—').count(), 0)
  await page
    .getByText('Add media to the timeline to begin.', { exact: true })
    .waitFor()
  await mkdir('docs/screenshots', { recursive: true })
  await page.screenshot({ path: 'docs/screenshots/editor-empty.png' })
  const input = page.getByRole('textbox', { name: 'Agent command' })
  hits = {
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
  }
  ops = [
    {
      op: 'add_clip',
      vault_id: 'flower.mp4',
      clip_id: 'a',
      track: 'V1',
      start_s: 0,
      duration_s: 4,
    },
    {
      op: 'add_clip',
      vault_id: 'bunny.mp4',
      clip_id: 'b',
      track: 'V1',
      start_s: 4,
      duration_s: 4,
    },
    {
      op: 'add_clip',
      vault_id: 'flower.mp4',
      clip_id: 'c',
      track: 'V1',
      start_s: 8,
      duration_s: 4,
    },
    {
      op: 'add_text',
      content: 'A STUDY IN MOTION',
      start_s: 0,
      duration_s: 3,
      y: 0.78,
      font_size: 60,
    },
  ]
  await input.fill('Arrange clips and add a title')
  await input.press('Enter')
  await page.waitForFunction(
    () => document.querySelectorAll('[data-clip-type="video"]').length === 3,
  )
  assert.equal(await page.locator('.item-count').innerText(), '2')
  assert.equal(await page.locator('.media-library').getByRole('button', { name: /^Flower/ }).count(), 1)
  assert.equal(await page.locator('.media-library').getByRole('button', { name: /^Bunny/ }).count(), 1)
  assert.equal(await page.locator('.media-library').getByRole('button', { name: /^Bed/ }).count(), 0)
  await page.getByRole('button', { name: 'Fit timeline', exact: true }).click()
  const clips = page.locator('[data-clip-type="video"]')
  const lastClipId = await clips.nth(2).getAttribute('data-clip-id')
  const clickClip = async (index, modifiers = []) => {
    const box = await clips.nth(index).boundingBox()
    await clips
      .nth(index)
      .click({ position: { x: box.width / 2, y: box.height / 2 }, modifiers })
  }
  await clickClip(0)
  await clickClip(1, ['Shift'])
  await page.getByText('2 clips selected', { exact: true }).waitFor()
  await clickClip(2, ['Meta'])
  await page.getByText('3 clips selected', { exact: true }).waitFor()
  assert.equal(await page.locator('[data-selected="true"]').count(), 3)
  const selectedIds = await page
    .locator('.selection-summary')
    .getAttribute('data-selection-ids')
  assert.equal(JSON.parse(selectedIds).length, 3)
  await page.waitForFunction(() => {
    const toolbar = document
      .querySelector('button[title="Resize"]')
      ?.parentElement.getBoundingClientRect()
    const preview = document
      .querySelector('.stage-canvas')
      .getBoundingClientRect()
    return (
      toolbar &&
      toolbar.top >= preview.top &&
      toolbar.left >= preview.left &&
      toolbar.right <= preview.right &&
      toolbar.bottom <= preview.bottom
    )
  })
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click()
  await page.getByRole('button', { name: 'Fit timeline', exact: true }).click()
  await page.locator('.stage').focus()
  await page.keyboard.press('ArrowRight')
  assert.equal(
    await page.locator('.selection-summary').getAttribute('data-selection-ids'),
    selectedIds,
  )
  await page.screenshot({ path: 'docs/screenshots/editor-selection.png' })

  async function inViewport(dialog) {
    await page.waitForFunction(
      (label) => {
        const el = [...document.querySelectorAll('[role="dialog"]')].find(
          (node) => node.getAttribute('aria-label') === label,
        )
        if (!el) return false
        const box = el.getBoundingClientRect()
        return (
          box.x >= 9 &&
          box.y >= 9 &&
          box.right <= window.innerWidth - 9 &&
          box.bottom <= window.innerHeight - 9
        )
      },
      await dialog.getAttribute('aria-label'),
    )
    const box = await dialog.boundingBox()
    const size = page.viewportSize()
    assert(
      box &&
        box.x >= 9 &&
        box.y >= 9 &&
        box.x + box.width <= size.width - 9 &&
        box.y + box.height <= size.height - 9,
      `Panel outside viewport: ${JSON.stringify(box)} in ${JSON.stringify(size)}`,
    )
  }
  // Right edge, bottom edge, viewport resize and Escape from an input.
  await clips.nth(2).click({ button: 'right' })
  const clipDialog = page.getByRole('dialog', { name: 'Clip', exact: true })
  await clipDialog.waitFor()
  await inViewport(clipDialog)
  await page.setViewportSize({ width: 1024, height: 640 })
  await inViewport(clipDialog)
  await page.getByRole('spinbutton', { name: 'Angle in degrees' }).focus()
  await page.keyboard.press('Escape')
  assert.equal(await clipDialog.count(), 0)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('button', { name: 'Fit timeline', exact: true }).click()
  await clips.nth(0).dblclick()
  await clipDialog.waitFor()
  await inViewport(clipDialog)
  await page.locator('.brand').click()
  assert.equal(await clipDialog.count(), 0)
  for (let i = 0; i < 3; i++)
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await page.evaluate(() => {
    const scroll = document.querySelector('.studio-timeline > div:nth-child(2)')
    scroll.scrollLeft = scroll.scrollWidth
  })
  await page
    .locator(`[data-clip-id="${lastClipId}"]`)
    .click({ button: 'right' })
  await inViewport(clipDialog)
  await page.evaluate(() => {
    const scroll = document.querySelector('.studio-timeline > div:nth-child(2)')
    scroll.scrollLeft = Math.max(0, scroll.scrollLeft - 30)
  })
  await inViewport(clipDialog)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Fit timeline', exact: true }).click()

  // Both native timeline cut affordances open the same portal-based controls.
  for (const index of [0, 1]) {
    await page
      .locator('[title="Add transition"], [title$="click to change"]')
      .nth(index)
      .click()
    const transition = page.getByRole('dialog', {
      name: 'Transition',
      exact: true,
    })
    await transition.waitFor()
    await inViewport(transition)
    await page.getByRole('spinbutton', { name: /Duration/ }).fill('0.5')
    if (index === 1)
      await page.screenshot({ path: 'docs/screenshots/editor-transition.png' })
    await page
      .getByRole('button', { name: 'Apply dissolve', exact: true })
      .click()
    assert.equal(await transition.count(), 0)
  }
  await page
    .getByRole('button', { name: 'Clear selection', exact: true })
    .click()
  assert.equal(await page.locator('[data-selected="true"]').count(), 0)

  for (const size of [
    { width: 1280, height: 720 },
    { width: 1024, height: 640 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    )
    assert.equal(overflow, false, `Horizontal page overflow at ${size.width}`)
    await page
      .getByRole('button', { name: 'Fit timeline', exact: true })
      .click()
    await clips.nth(0).click({ button: 'right' })
    await inViewport(clipDialog)
    await page.keyboard.press('Escape')
    await page.screenshot({
      path: `docs/screenshots/editor-${size.width}.png`,
      fullPage: true,
    })
  }
  assert.deepEqual(errors, [])
  console.log(
    'UI passed: multi-select, zoom/scrub persistence, clip/transition collision handling, dismissal, desktop/laptop/mobile overflow',
  )
} finally {
  await browser.close()
}
