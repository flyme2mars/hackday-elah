import { insertMediaAsset, playbackStore, type TimelineEngine } from '@elah/editor'
import { applyOps, rememberClipVault } from './applyOps.ts'
import type { LibraryAsset } from './library.ts'
import { ensureImported } from './media.ts'
import { frameCountToSeconds, type TrackAlias } from './types.ts'

export async function placeAsset(engine: TimelineEngine, asset: LibraryAsset): Promise<void> {
  const startFrame = playbackStore.getState().currentFrame
  const fps = engine.getProject().fps
  const start = frameCountToSeconds(startFrame, fps)

  if (asset.kind === 'image') {
    const assetId = await ensureImported(asset)
    const placed = await insertMediaAsset(engine, assetId, {
      desiredStartFrame: startFrame,
      videoOnly: true,
    })
    if (!placed.ok) {
      throw new Error('Could not place that image.')
    }
    for (const clipId of placed.clipIds) rememberClipVault(clipId, asset.vaultId)
    return
  }

  const tracks: TrackAlias[] = asset.kind === 'audio' ? ['A1'] : ['V1', 'V2']
  let lastError: unknown
  for (const track of tracks) {
    try {
      await applyOps(
        engine,
        [
          {
            op: 'add_clip',
            vault_id: asset.vaultId,
            track,
            start_s: start,
          },
        ],
        'Place',
      )
      return
    } catch (error) {
      lastError = error
    }
  }
  const message = lastError instanceof Error ? lastError.message : 'Could not place that file.'
  throw new Error(message)
}
