import {
  readProjectDocument,
  relinkProjectMedia,
  useMediaLibraryStore,
  type Project,
  type TimelineEngine,
} from '@elah/editor'
import {
  clearClipBindings,
  collectClipVaults,
  reconcileClipVaults,
  rememberClipVault,
} from './applyOps.ts'
import { clearLibraryRegistry, type LibraryAsset } from './library.ts'
import { clearMediaCache, ensureImported, restoreUploadBlob } from './media.ts'
import {
  DEFAULT_STAGE,
  dropClipsWithSrc,
  droppedMediaNote,
  prepareRestore,
  removeClipIds,
  retargetClips,
  type ProjectSnapshot,
} from './projectSnapshot.ts'
import { getUploadBlob, listUploadIds } from './projectStorage.ts'

export interface RestoredProject {
  library: LibraryAsset[]
  name: string
  playheadFrame: number
  note: string
}

export function collectProjectVaults(engine: TimelineEngine): Record<string, string> {
  return collectClipVaults(engine)
}

export async function restoreProject(
  engine: TimelineEngine,
  snapshot: ProjectSnapshot,
  canApply: () => boolean = () => true,
): Promise<RestoredProject | null> {
  const prepared = prepareRestore(snapshot, new Set(await listUploadIds()))
  if (!prepared) return null

  const dropped = [...prepared.droppedNames]
  const library: LibraryAsset[] = []
  const failedSrcs: string[] = []

  for (const item of prepared.durable) {
    const asset: LibraryAsset = {
      vaultId: item.vaultId,
      name: item.name,
      kind: item.kind,
      durationSec: item.durationSec,
      src: item.src,
      thumb: item.thumb,
    }
    try {
      await ensureImported(asset)
      library.push(asset)
    } catch {
      dropped.push(item.name)
      failedSrcs.push(item.src)
    }
  }

  for (const upload of prepared.rewrites) {
    const blob = await getUploadBlob(upload.vaultId)
    if (!blob) {
      dropped.push(upload.name)
      removeClipIds(prepared.project, upload.clipIds)
      continue
    }
    try {
      const restored = await restoreUploadBlob(
        {
          vaultId: upload.vaultId,
          name: upload.name,
          kind: upload.kind,
          durationSec: upload.durationSec,
        },
        blob,
      )
      retargetClips(prepared.project, upload.clipIds, restored.asset.src, restored.mediaId)
      library.push(restored.asset)
    } catch {
      dropped.push(upload.name)
      removeClipIds(prepared.project, upload.clipIds)
    }
  }

  if (failedSrcs.length > 0) dropped.push(...dropClipsWithSrc(prepared.project, failedSrcs))
  if (!canApply()) return null

  let document: Project
  try {
    document = readProjectDocument(prepared.project)
  } catch {
    return null
  }
  const assets = Object.values(useMediaLibraryStore.getState().assets)
  const relinked = relinkProjectMedia(document, assets)
  if (!canApply()) return null
  engine.loadProject(relinked.project, { transport: 'keep', history: 'reset' })
  if (!canApply()) {
    blankTimeline(engine)
    return null
  }
  clearClipBindings()
  for (const [clipId, vaultId] of Object.entries(snapshot.clipVaults)) {
    if (!engine.findClip(clipId)) continue
    rememberClipVault(clipId, vaultId)
  }
  reconcileClipVaults(engine)
  const total = engine.getTotalFrames()
  return {
    library,
    name: snapshot.name,
    playheadFrame: total > 0 ? Math.min(snapshot.playheadFrame, Math.max(0, total - 1)) : 0,
    note: droppedMediaNote(dropped),
  }
}

export function blankTimeline(engine: TimelineEngine): void {
  const current = engine.getProject()
  const clips: Project['clips'] = {}
  for (const track of current.tracks) clips[track.id] = []
  engine.loadProject(
    {
      id: current.id,
      fps: current.fps,
      stage: { width: DEFAULT_STAGE.width, height: DEFAULT_STAGE.height },
      tracks: current.tracks.map((track) => ({ ...track })),
      clips,
      transitions: [],
      version: current.version,
      ...(current.masterVolume === undefined ? {} : { masterVolume: current.masterVolume }),
    },
    { transport: 'rewind', history: 'reset' },
  )
}

export function releaseMediaLibrary(): void {
  const state = useMediaLibraryStore.getState()
  for (const asset of Object.values(state.assets)) {
    if (asset.src.startsWith('blob:')) URL.revokeObjectURL(asset.src)
  }
  for (const id of [...state.order]) state.removeAsset(id)
  clearMediaCache()
  clearLibraryRegistry()
  clearClipBindings()
}
