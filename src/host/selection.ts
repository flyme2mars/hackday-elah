import { selectionStore, type TimelineEngine } from '@elah/editor'

/** Stable host boundary for future command context; excludes removed clips. */
export function getSelectedClipIds(engine: TimelineEngine): string[] {
  return [...selectionStore.getState().selectedClipIds].filter((id) =>
    engine.findClip(id),
  )
}
