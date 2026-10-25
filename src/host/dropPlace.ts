import type { LibraryAsset } from './library.ts'

export interface TimelineClipRef {
  readonly id: string
  readonly assetId: string | null
}

export interface PendingDrop {
  readonly asset: LibraryAsset
  readonly clipIds: ReadonlySet<string>
}

export function droppedLibraryAsset(
  pending: PendingDrop | undefined,
  assetId: string,
  clipsAfter: readonly TimelineClipRef[],
): LibraryAsset | null {
  if (!pending) return null
  const landed = clipsAfter.some((clip) => !pending.clipIds.has(clip.id) && clip.assetId === assetId)
  return landed ? pending.asset : null
}
