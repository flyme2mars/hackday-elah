import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const browser = await chromium.launch({
  ...(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH }
    : {}),
  args: ['--no-sandbox'],
})
try {
  const page = await browser.newPage()
  await page.goto(
    `${process.env.TEST_BASE_URL || 'http://127.0.0.1:43123'}/tests/voice.html`,
  )
  const counts = async () =>
    JSON.parse(await page.locator('output').innerText())
  const mic = page.locator('.mic-button')
  const input = page.getByRole('textbox', { name: 'Agent command' })
  await input.fill('rotate both clips')
  await page
    .locator('.command')
    .screenshot({ path: '/tmp/frame-flow-mic-idle.png' })
  await page
    .getByRole('button', { name: 'Start voice input', exact: true })
    .focus()
  await page.keyboard.press('Enter')
  assert.equal(await mic.getAttribute('aria-pressed'), 'true')
  await page.getByRole('status').filter({ hasText: 'Listening…' }).waitFor()
  assert.equal((await counts()).starts, 1)
  assert.equal((await counts()).submits, 0, 'Mic does not submit the form')
  await page
    .locator('.command')
    .screenshot({ path: '/tmp/frame-flow-mic-listening.png' })
  await page.keyboard.press('Space')
  assert.equal((await counts()).stops, 1)
  assert.equal(
    await input.inputValue(),
    'rotate both clips',
    'Toggling mic preserves typed text',
  )
  await page.getByRole('button', { name: 'Simulate permission denied' }).click()
  await page
    .getByRole('status')
    .filter({ hasText: 'Microphone access is blocked' })
    .waitFor()
  await page
    .locator('.command')
    .screenshot({ path: '/tmp/frame-flow-mic-denied.png' })
  await page.getByRole('button', { name: /Microphone access denied/ }).click()
  assert.equal((await counts()).retries, 1)
  await page.getByRole('button', { name: 'Toggle busy' }).click()
  assert.equal(
    await mic.isDisabled(),
    true,
    'Busy command cannot start voice capture',
  )
  await page.getByRole('button', { name: 'Toggle busy' }).click()
  await page
    .getByRole('button', { name: 'Start voice input', exact: true })
    .click()
  await page.getByRole('button', { name: 'Toggle busy' }).click()
  assert.equal(
    await mic.isEnabled(),
    true,
    'Stop remains available while a command is busy',
  )
  await page.getByRole('button', { name: 'Stop listening' }).click()
  assert.equal((await counts()).stops, 2)
  await page.getByRole('button', { name: 'Toggle busy' }).click()
  await page.getByRole('button', { name: 'Disconnect speech control' }).click()
  assert.equal(await mic.isDisabled(), true)
  assert.equal(await mic.getAttribute('aria-label'), 'Voice input unavailable')
  await input.fill('trim the clip')
  await input.press('Enter')
  assert.equal(
    (await counts()).submits,
    1,
    'Command typing and submission still work',
  )
  console.log(
    'Voice chrome passed: controlled callbacks, keyboard, listening/denied/unavailable states, busy handling and typing',
  )
} finally {
  await browser.close()
}
