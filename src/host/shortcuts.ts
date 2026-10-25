import { playbackStore, selectionStore, type TimelineEngine } from '@elah/editor'

/** Capture handled keys so Elah's window listener cannot apply them twice. */
export function timelineShortcut(engine: TimelineEngine, event: KeyboardEvent): void {
  const target = event.target
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return
  if (!(target instanceof HTMLElement)) return
  if (target.closest('input, textarea, select, button, a, [role="textbox"], [role="slider"], [contenteditable]:not([contenteditable="false"])')) return
  if (target !== document.body && !target.closest('.stage, .timeline-pane')) return

  const key = event.key.toLowerCase()
  if (![' ', 'j', 'l', 'arrowleft', 'arrowright', 'delete', 'backspace'].includes(key)) return
  event.preventDefault()
  event.stopImmediatePropagation()
  const playback = playbackStore.getState()
  if (key === ' ') {
    if (!event.repeat) playback.togglePlayPause()
  } else if (['j', 'l', 'arrowleft', 'arrowright'].includes(key)) {
    playback.pause()
    const direction = key === 'j' || key === 'arrowleft' ? -1 : 1
    const step = event.shiftKey ? engine.getProject().fps : 1
    const lastFrame = Math.max(0, engine.getTotalFrames() - 1)
    playback.setCurrentFrame(Math.max(0, Math.min(lastFrame, playback.currentFrame + direction * step)))
  } else {
    const selection = selectionStore.getState()
    engine.batch(() => {
      for (const id of selection.selectedClipIds) {
        const found = engine.findClip(id)
        if (found && !found.clip.locked) engine.removeClip(id, found.trackId)
      }
    }, 'Delete selected clips')
    selection.clearSelection()
  }
}
