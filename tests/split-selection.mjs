import assert from 'node:assert/strict'
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
  const page = await browser.newPage()
  let ops = []
  const requests = []
  await page.route('**/api/v1/command', (route) => {
    requests.push(route.request().postDataJSON())
    return route.fulfill({
      json: {
        planner: 'test',
        ops,
        note: '',
        hits: {
          video: [
            {
              vault_id: 'flower.mp4',
              name: 'Flower',
              kind: 'video',
              duration_s: 5,
              src: '/samples/flower.mp4',
            },
          ],
        },
      },
    })
  })
  await page.goto(
    `${process.env.TEST_BASE_URL || 'http://127.0.0.1:43123'}/?debug=1`,
  )
  const input = page.getByRole('textbox', { name: 'Agent command' })
  const clips = page.locator('[data-clip-type="video"]')
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
  const selection = () =>
    page
      .locator('.selection-summary')
      .getAttribute('data-selection-ids')
      .then(JSON.parse)
  await command('place a clip', [
    {
      op: 'add_clip',
      vault_id: 'flower.mp4',
      clip_id: 'original',
      track: 'V1',
      start_s: 0,
      duration_s: 4,
    },
  ])
  await clips.first().click()
  await page.locator('.stage').focus()
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('s')
  await page.waitForFunction(
    () => document.querySelectorAll('[data-clip-type="video"]').length === 2,
  )
  assert.equal(
    await page
      .locator('[data-clip-type="video"][data-selected="true"]')
      .count(),
    2,
    'Keyboard split selects both halves',
  )
  await command('rotate both halves', [])
  const snapshot = requests
    .at(-1)
    .timeline.tracks.find((track) => track.alias === 'V1')
  assert.deepEqual(
    new Set(requests.at(-1).selected_clip_ids),
    new Set(snapshot.clips.map((clip) => clip.alias || clip.id)),
    'Next command receives both halves',
  )
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  assert.equal(await clips.count(), 1, 'One undo restores the original clip')
  await page.getByRole('button', { name: 'Redo', exact: true }).click()
  assert.equal(
    await page
      .locator('[data-clip-type="video"][data-selected="true"]')
      .count(),
    2,
    'Redo restores both selected halves',
  )
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  const clipBox = await clips.first().boundingBox()
  await clips
    .first()
    .click({
      button: 'right',
      position: { x: clipBox.width / 4, y: clipBox.height / 2 },
    })
  await page
    .getByRole('button', { name: 'Split at playhead', exact: true })
    .click()
  assert.equal(
    await page
      .locator('[data-clip-type="video"][data-selected="true"]')
      .count(),
    2,
    'Menu split selects both halves',
  )
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await command('cut the clip', [{ op: 'split', clip_id: 'original', at_s: 2 }])
  assert.equal(
    await page
      .locator('[data-clip-type="video"][data-selected="true"]')
      .count(),
    2,
    'Agent split selects both halves',
  )
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await command('cut twice', [
    { op: 'split', clip_id: 'original', at_s: 1, right_id: 'right' },
    { op: 'split', clip_id: 'right', at_s: 3 },
  ])
  assert.equal(
    await page
      .locator('[data-clip-type="video"][data-selected="true"]')
      .count(),
    3,
    'All surviving split pieces are selected',
  )
  const beforeFailure = await selection()
  ops = [
    { op: 'split', clip_id: 'original', at_s: 0.5 },
    { op: 'remove', clip_id: 'missing' },
  ]
  await input.fill('invalid edit')
  await input.press('Enter')
  await page.getByRole('status').filter({ hasText: 'Unknown clip' }).waitFor()
  assert.equal(await clips.count(), 3)
  assert.deepEqual(
    await selection(),
    beforeFailure,
    'Rolled-back split does not change selection',
  )
  console.log(
    'Split selection passed: keyboard, menu, agent, command context, undo, multiple cuts and rollback',
  )
} finally {
  await browser.close()
}
