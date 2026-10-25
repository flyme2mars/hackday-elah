import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface PanelAnchor {
  x: number
  y: number
  element?: Element
}

export default function FloatingPanel({
  anchor,
  label,
  children,
  onClose,
}: {
  anchor: PanelAnchor
  label: string
  children: ReactNode
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  useLayoutEffect(() => {
    closeRef.current = onClose
  }, [onClose])

  useLayoutEffect(() => {
    const panel = ref.current!
    const previousFocus = document.activeElement as HTMLElement | null
    const origin = anchor.element?.getBoundingClientRect()
    const offsetX = origin ? anchor.x - origin.left : 0
    const offsetY = origin ? anchor.y - origin.top : 0
    function position() {
      const viewport = window.visualViewport
      const leftEdge = (viewport?.offsetLeft ?? 0) + 10
      const topEdge = (viewport?.offsetTop ?? 0) + 10
      const rightEdge = leftEdge + (viewport?.width ?? window.innerWidth) - 20
      const bottomEdge = topEdge + (viewport?.height ?? window.innerHeight) - 20
      panel.style.maxWidth = `${Math.max(0, rightEdge - leftEdge)}px`
      panel.style.maxHeight = `${Math.max(0, bottomEdge - topEdge)}px`
      const current = anchor.element?.isConnected
        ? anchor.element.getBoundingClientRect()
        : null
      const x = current ? current.left + offsetX : anchor.x
      const y = current ? current.top + offsetY : anchor.y
      const { width, height } = panel.getBoundingClientRect()
      const flippedX = x + width > rightEdge ? x - width : x
      const flippedY = y + height > bottomEdge ? y - height : y
      panel.style.left = `${Math.max(leftEdge, Math.min(flippedX, rightEdge - width))}px`
      panel.style.top = `${Math.max(topEdge, Math.min(flippedY, bottomEdge - height))}px`
      panel.style.visibility = 'visible'
    }
    position()
    panel
      .querySelector<HTMLElement>('button, input, [tabindex="0"]')
      ?.focus({ preventScroll: true })
    const observer = new ResizeObserver(position)
    observer.observe(panel)
    function onPointer(event: PointerEvent) {
      if (!panel.contains(event.target as Node)) closeRef.current()
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        closeRef.current()
      }
    }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    window.visualViewport?.addEventListener('resize', position)
    window.visualViewport?.addEventListener('scroll', position)
    return () => {
      observer.disconnect()
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
      window.visualViewport?.removeEventListener('resize', position)
      window.visualViewport?.removeEventListener('scroll', position)
      if (panel.contains(document.activeElement))
        previousFocus?.focus({ preventScroll: true })
    }
  }, [anchor])

  return createPortal(
    <div
      ref={ref}
      className="elah-root floating-panel"
      role="dialog"
      aria-label={label}
      style={{ position: 'fixed', visibility: 'hidden' }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  )
}
