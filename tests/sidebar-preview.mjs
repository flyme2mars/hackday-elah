// With Vite running: node tests/sidebar-preview.mjs
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/api/v1/command', (route) =>
    route.fulfill({
      json: {
        planner: 'test',
        note: '',
        ops: [],
        hits: {
          video: [
            { vault_id: 'flower.mp4', name: 'Flower', kind: 'video', duration_s: 5, src: '/samples/flower.mp4' },
            { vault_id: 'bunny.mp4', name: 'Bunny', kind: 'video', duration_s: 8, src: '/samples/bunny.mp4' },
          ],
          audio: [
            { vault_id: 'bed.m4a', name: 'Bed', kind: 'audio', duration_s: 8, src: '/samples/bed.m4a' },
          ],
          image: [
            { vault_id: 'still.png', name: 'Still', kind: 'image', duration_s: null, src: '/samples/flower.mp4' },
          ],
        },
      },
    }),
  )
  await page.goto(process.env.TEST_BASE_URL || 'http://127.0.0.1:43123')
  const input = page.getByRole('textbox', { name: 'Agent command' })
  await input.fill('find media')
  await input.press('Enter')
  await page.locator('.media-search button.hit').first().waitFor()
  await page.waitForFunction(() => !document.querySelector('.command-input').disabled)

  assert.equal(await page.getByRole('button', { name: 'Play', exact: true }).count(), 1)
  assert.equal(await page.locator('.media-search').getByRole('button', { name: /^Bed/ }).count(), 1)
  assert.equal(await page.getByRole('button', { name: 'Play Still', exact: true }).count(), 0)
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('.media-search button.hit')].find((node) =>
      node.textContent?.includes('Bed'),
    )
    return button instanceof HTMLElement && button.draggable
  })

  const timecode = () => page.locator('.timecode').innerText()
  const beforeTime = await timecode()
  const beforeVideo = await page.locator('[data-clip-type="video"]').count()
  const beforeAudio = await page.locator('[data-clip-type="audio"]').count()

  await page.getByRole('button', { name: 'Play Bed', exact: true }).click()
  await page.waitForFunction(() => {
    const node = document.querySelector('.media .sidebar-preview-audio')
    return node instanceof HTMLAudioElement && !node.paused
  })
  assert.equal(await page.locator('.thumb-live').count(), 0)
  assert.equal(await page.locator('.sidebar-preview-audio').count(), 1)
  assert.equal(await page.locator('[data-clip-type="audio"]').count(), beforeAudio)
  assert.equal(await page.locator('[data-clip-type="video"]').count(), beforeVideo)
  assert.equal(await timecode(), beforeTime)

  await page.locator('.media-search button.hit').filter({ hasText: 'Flower' }).click()
  await page.waitForFunction(
    (count) => document.querySelectorAll('[data-clip-type="video"]').length === count + 1,
    beforeVideo,
  )
  await page.waitForFunction(() => {
    const node = document.querySelector('.media .sidebar-preview-audio')
    return node instanceof HTMLAudioElement && !node.paused
  })
  assert.equal(await page.locator('[data-clip-type="audio"]').count(), beforeAudio)
  const placedTime = await timecode()
  assert.match(placedTime, /^00:00:00:00 /)

  const search = page.locator('.media-search')
  await search.getByRole('button', { name: 'Play Flower', exact: true }).click()
  await page.waitForFunction(() => {
    const node = document.querySelector('.thumb-live')
    return node instanceof HTMLVideoElement && !node.paused && !node.muted && node.readyState >= 2
  })
  assert.equal(await page.locator('.sidebar-preview-audio').count(), 0)
  assert.equal(await page.locator('.media-search .thumb-live').count(), 1)
  assert.equal(await page.locator('.media-library .thumb-live').count(), 0)
  assert.equal(await page.locator('.media-library').getByRole('button', { name: 'Play Flower', exact: true }).count(), 1)
  assert.equal(await page.locator('[data-clip-type="video"]').count(), beforeVideo + 1)
  assert.equal(await timecode(), placedTime)

  await search.getByRole('button', { name: 'Play Bunny', exact: true }).click()
  await page.waitForFunction(() => {
    const node = document.querySelector('.thumb-live')
    return node instanceof HTMLVideoElement && !node.paused && node.src.includes('bunny.mp4')
  })
  assert.equal(await page.locator('.thumb-live').count(), 1)
  assert.equal(await page.locator('[data-clip-type="video"]').count(), beforeVideo + 1)

  await page.waitForFunction(() => {
    const node = document.querySelector('.thumb-live')
    const bar = node?.parentElement?.querySelector('.hit-progress > span')
    if (!(node instanceof HTMLVideoElement) || !(bar instanceof HTMLElement)) return false
    const scale = Number(getComputedStyle(bar).transform.split(',')[0]?.replace('matrix(', ''))
    return node.currentTime > 0 && scale > 0
  })
  await search.getByRole('button', { name: 'Pause Bunny', exact: true }).click()
  await page.waitForFunction(() => {
    const node = document.querySelector('.thumb-live')
    return node instanceof HTMLVideoElement && node.paused && node.currentTime > 0
  })

  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.querySelector('.thumb-live, .sidebar-preview-audio') === null)
  assert.equal(await page.locator('[data-clip-type="video"]').count(), beforeVideo + 1)
  assert.equal(await timecode(), placedTime)
  assert.deepEqual(errors, [])
  console.log('Sidebar preview: audio and video play one at a time, and the card still places')
} finally {
  await browser.close()
}
