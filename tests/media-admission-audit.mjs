// Counts admitted work while media responses are deliberately held, not latency.
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const url = process.env.AUDIT_URLS || 'http://127.0.0.1:43124'
const size = Number(process.env.AUDIT_ASSETS || 300)
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: ['--no-sandbox'],
})
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const held = []
  const warnings = []
  page.on('console', (message) => {
    if (message.type() === 'warning' || message.type() === 'error') warnings.push(message.text())
  })
  await page.addInitScript(() => {
    window.createdVideos = 0
    const create = document.createElement.bind(document)
    document.createElement = (...args) => {
      if (args[0] === 'video') window.createdVideos++
      return create(...args)
    }
  })
  await page.route(/\/samples\/flower\.mp4\?admission=/, (route) => { held.push(route) })
  await page.route('**/api/v1/command', (route) => route.fulfill({ json: {
    planner: 'audit', ops: [], note: '', hits: { video: Array.from({ length: size }, (_, id) => ({
      vault_id: `admission/${id}.mp4`, name: `Video ${id}`, kind: 'video', duration_s: 5,
      src: `${url}/samples/flower.mp4?admission=${id}`,
    })) },
  } }))
  await page.goto(url)
  const input = page.getByRole('textbox', { name: 'Agent command' })
  await input.fill('show footage')
  await input.press('Enter')
  await page.waitForFunction((count) => document.querySelectorAll('.media-search .hit').length === count, size)
  await page.waitForFunction(() => document.querySelectorAll('.media-search video').length > 0)
  // Hold long enough that an eager list would have admitted every card.
  await page.waitForTimeout(500)
  const counts = await page.evaluate(() => {
    const panel = document.querySelector('.media-search')
    const bounds = panel.getBoundingClientRect()
    const cards = [...panel.querySelectorAll('.hit')]
    return {
      cards: cards.length,
      cards_intersecting_scroll_panel: cards.filter((card) => {
        const rect = card.getBoundingClientRect()
        return rect.bottom > bounds.top && rect.top < bounds.bottom
      }).length,
      dom_videos: panel.querySelectorAll('video').length,
      created_video_elements: window.createdVideos,
    }
  })
  assert.equal(counts.cards, size)
  // Before P0 this fixture admitted every card: 300 thumbnail videos, 600 created
  // video elements, and 600 held requests, with about 6 cards actually visible.
  assert.ok(counts.cards_intersecting_scroll_panel > 0)
  assert.ok(counts.cards_intersecting_scroll_panel < size / 10)
  assert.ok(counts.dom_videos > 0, 'visible cards should still mount a thumbnail')
  assert.ok(
    counts.dom_videos <= counts.cards_intersecting_scroll_panel + 8,
    `thumbnail videos should stay near the visible set, got ${counts.dom_videos}`,
  )
  assert.ok(counts.created_video_elements < 80, `created videos ${counts.created_video_elements}`)
  assert.ok(held.length < 80, `held requests ${held.length}`)
  assert.ok(counts.created_video_elements < size)
  assert.ok(held.length < size)
  const result = { url, chrome: browser.version(), media_responses_deliberately_held: true, ...counts, held_requests: held.length, warnings }
  await writeFile(process.env.AUDIT_OUTPUT || '/tmp/frame-flow-media-admission.json', JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} finally {
  await browser.close()
}
