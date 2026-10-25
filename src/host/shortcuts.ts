import { playbackStore, selectionStore, type TimelineEngine } from '@elah/editor'

/** Capture handled keys so Elah's window listener cannot apply them twice. */
export function timelineShortcut(engine: TimelineEngine, event: KeyboardEvent): void {
  const target = event.target
  if (event.defaultPrevented || event.altKey || event.isComposing) return
  if (!(target instanceof HTMLElement)) return
  if (event.metaKey || event.ctrlKey) {
    const key = event.key.toLowerCase()
    const undo = key === 'z' && !event.shiftKey
    const redo = (key === 'z' && event.shiftKey) || (key === 'y' && !event.shiftKey)
    if ((undo || redo) && !isTextEditing(target)) {
      event.preventDefault()
      event.stopImmediatePropagation()
      if (undo) undoEdit(engine)
      else engine.redo()
    }
    return
  }
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

function undoEdit(engine: TimelineEngine): void {
  engine.undo()
  if (engine.getTotalFrames() === 0) {
    const playback = playbackStore.getState()
    playback.pause()
    playback.setCurrentFrame(0)
  }
}

/** A filled text field keeps its own undo. An empty command field undoes the timeline. */
function isTextEditing(target: HTMLElement): boolean {
  const field = target.closest('input, textarea, select, [role="textbox"], [contenteditable]:not([contenteditable="false"])')
  if (!(field instanceof HTMLElement)) return false
  if (field instanceof HTMLInputElement) {
    if (field.type === 'range' || field.type === 'checkbox' || field.type === 'radio' || field.type === 'button') return false
    return field.value.length > 0
  }
  if (field instanceof HTMLTextAreaElement) return field.value.length > 0
  if (field instanceof HTMLSelectElement) return false
  return (field.textContent ?? '').trim().length > 0
}
