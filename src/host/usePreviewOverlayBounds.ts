import { useEffect, type RefObject } from 'react'

/** Keep the SDK's crop/resize toolbar inside its clipping preview container. */
export function usePreviewOverlayBounds(
  root: RefObject<HTMLDivElement | null>,
): void {
  useEffect(() => {
    const container = root.current
    if (!container) return
    const offsets = new WeakMap<HTMLElement, { x: number; y: number }>()
    let frame = 0
    function measure() {
      frame = 0
      const pane = container!.getBoundingClientRect()
      for (const button of container!.querySelectorAll<HTMLElement>(
        'button[title="Resize"]',
      )) {
        const toolbar = button.parentElement!
        const previous = offsets.get(toolbar) ?? { x: 0, y: 0 }
        const box = toolbar.getBoundingClientRect()
        const left = Math.max(0, pane.left) + 8
        const top = Math.max(0, pane.top) + 8
        const right = Math.min(window.innerWidth, pane.right) - 8
        const bottom = Math.min(window.innerHeight, pane.bottom) - 8
        const baseX = box.left - previous.x
        const baseY = box.top - previous.y
        const x = Math.max(left, Math.min(baseX, right - box.width)) - baseX
        const y = Math.max(top, Math.min(baseY, bottom - box.height)) - baseY
        if (Math.abs(x - previous.x) > 0.5 || Math.abs(y - previous.y) > 0.5) {
          toolbar.style.translate = `${x}px ${y}px`
          offsets.set(toolbar, { x, y })
        }
      }
    }
    function schedule() {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    const mutations = new MutationObserver(schedule)
    mutations.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style'],
    })
    const resize = new ResizeObserver(schedule)
    resize.observe(container)
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    schedule()
    return () => {
      cancelAnimationFrame(frame)
      mutations.disconnect()
      resize.disconnect()
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
    }
  }, [root])
}
