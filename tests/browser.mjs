// Start Vite first with npm run dev. No planner, vault or MLX service needed.
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
try {
  const page = await browser.newPage()
  const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:43123'
  await page.goto(`${base}/tests/browser.html`)
  await page.waitForFunction(() => typeof window.runHostCases === 'function')
  console.log(await page.evaluate(() => window.runHostCases()))

  // Exercise the real command field, parser and host through a mocked planner response.
  let nextOps = []
  const requests = []
  await page.route('**/api/library', (route) => route.fulfill({ json: { items: [] } }))
  await page.route('**/api/v1/command', (route) => {
    requests.push(route.request().postDataJSON())
    return route.fulfill({ json: { planner: 'test', hits: {}, ops: nextOps, ops_label: 'Test edit', note: '' } })
  })
  await page.goto(`${base}/?debug=1`)
  const input = page.getByRole('textbox', { name: 'Agent command' })
  const snapshot = async () => JSON.parse(await page.locator('.debug-json').textContent())
  const command = async (text, ops) => {
    nextOps = ops
    await input.fill(text)
    await input.press('Enter')
    await page.waitForFunction(() => document.querySelector('.command-input').value === '' && !document.querySelector('.command-input').disabled)
  }
  await page.getByRole('button', { name: /^Flower/ }).waitFor()
  await command('place two clips', [
    { op: 'add_clip', vault_id: 'flower.mp4', clip_id: 'a', track: 'V1', start_s: 0, duration_s: 2 },
    { op: 'add_clip', vault_id: 'bunny.mp4', clip_id: 'b', track: 'V1', start_s: 2, duration_s: 2 },
  ])
  await command('add title Hello at the start for 2 seconds', [{ op: 'add_text', clip_id: 'title1', content: 'Hello', start_s: 0, duration_s: 2 }])
  assert.equal((await snapshot()).tracks.find((t) => t.alias === 'T1').clips[0].content, 'Hello')
  await page.getByText('Title added.', { exact: true }).waitFor()
  await page.locator('.stage canvas').first().waitFor()
  assert.equal(await page.locator('.elah-root').evaluate((el) => getComputedStyle(el).getPropertyValue('--elah-clip-text-accent').trim()), '#c6c6c6')
  await page.getByRole('button', { name: 'Play', exact: true }).focus()
  await page.keyboard.press('Space')
  await page.getByRole('button', { name: 'Pause', exact: true }).waitFor()
  await page.keyboard.press('Space')
  await page.getByRole('button', { name: 'Play', exact: true }).waitFor()
  // Rewind after the transport control check.
  await page.locator('.stage').focus()
  await page.keyboard.press('Shift+ArrowLeft')
  await page.screenshot({ path: '/tmp/hackday-title-preview.png' })
  await command('change the title to Welcome for 3 seconds', [{ op: 'update_text', clip_id: 'title1', content: 'Welcome', duration_s: 3 }])
  assert.equal(requests.at(-1).timeline.tracks.find((t) => t.alias === 'T1').clips[0].content, 'Hello')
  assert.equal((await snapshot()).tracks.find((t) => t.alias === 'T1').clips[0].duration_s, 3)
  await input.fill('j l words')
  await input.press('Space')
  await input.press('Backspace')
  assert.equal(await input.inputValue(), 'j l words')
  assert.equal((await snapshot()).tracks.find((t) => t.alias === 'T1').clips.length, 1)
  await command('remove the title', [{ op: 'remove', clip_id: 'title1' }])
  assert.equal((await snapshot()).tracks.find((t) => t.alias === 'T1').clips.length, 0)
  await page.getByText('Title removed.', { exact: true }).waitFor()
  console.log('Command UI: add/update/remove title, snapshot context, status and typing safety passed')
  await command('crossfade the clips', [{ op: 'crossfade', from_clip_id: 'a', to_clip_id: 'b' }])
  await page.locator('.stage').focus()
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Shift+ArrowRight')
  await page.waitForFunction(() => [...document.querySelectorAll('.stage-canvas canvas')].some((canvas) => canvas.parentElement.style.opacity === '0.5'))
  await page.screenshot({ path: '/tmp/hackday-crossfade-preview.png' })
  console.log('Preview: native crossfade overlay reaches 50% at the cut during keyboard scrubbing')
} finally {
  await browser.close()
}
