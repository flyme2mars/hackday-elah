import { selectionStore, type TimelineEngine } from '@elah/editor'

/** Elah selection-set insertion order. A modifier-click appends. Removed clips are left out. */
export function getSelectedClipIds(engine: TimelineEngine): string[] {
  return [...selectionStore.getState().selectedClipIds].filter((id) =>
    engine.findClip(id),
  )
}

export function selectSplitResults(engine: TimelineEngine): () => void {
  let active = true
  let scheduled = false
  let pending: NonNullable<ReturnType<TimelineEngine['splitClip']>>[] = []

  function onSplit({ leftId, rightId }: { leftId: string; rightId: string }) {
    pending.push([leftId, rightId])
    if (scheduled) return
    scheduled = true
    // Split events fire inside batches, before a later op can roll them back.
    queueMicrotask(() => {
      scheduled = false
      const completed = pending.filter(
        ([left, right]) => engine.findClip(left) && engine.findClip(right),
      )
      pending = []
      if (active && completed.length > 0) {
        selectionStore.getState().selectClips([...new Set(completed.flat())])
      }
    })
  }

  engine.on('clip:split', onSplit)
  return () => {
    active = false
    engine.off('clip:split', onSplit)
  }
}
