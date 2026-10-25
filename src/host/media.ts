import { importBlob, importFiles, importUrl, MEDIA_DRAG_MIME, mediaDragKindMime, type MediaAsset, type TimelineEngine } from '@elah/editor'
import { droppedLibraryAsset, type PendingDrop, type TimelineClipRef } from './dropPlace.ts'
import { getLibraryAsset, registerAssets, type LibraryAsset, type LibraryKind } from './library.ts'

const elahIds = new Map<string, string>()

const EXTENSION_KIND: Record<string, LibraryKind> = {
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  m4v: 'video',
  mkv: 'video',
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
  aac: 'audio',
  ogg: 'audio',
  flac: 'audio',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
}

export async function ensureImported(asset: LibraryAsset): Promise<string> {
  const cached = elahIds.get(asset.vaultId)
  if (cached) return cached
  const imported = await importUrl(asset.src, { name: asset.name, kind: asset.kind })
  elahIds.set(asset.vaultId, imported.id)
  registerAssets([{ ...asset, src: imported.src }])
  return imported.id
}

/** Register local files into the library as `upload/<name>` and remember the elah asset id. */
export async function importLocalFiles(files: readonly File[]): Promise<LibraryAsset[]> {
  if (files.length === 0) return []
  const result = await importFiles(files)
  const taken = new Set<string>()
  const assets: LibraryAsset[] = []
  for (const imported of result.imported) {
    const asset = rememberUpload(imported, taken)
    if (asset) assets.push(asset)
  }
  for (const skipped of result.skipped) {
    if (skipped.reason !== 'unsupported') continue
    const kind = kindFromName(skipped.file.name)
    if (!kind) continue
    const imported = await importBlob(skipped.file, { name: skipped.file.name, kind })
    const asset = rememberUpload(imported, taken)
    if (asset) assets.push(asset)
  }
  registerAssets(assets)
  return assets
}

function rememberUpload(imported: MediaAsset, taken: Set<string>): LibraryAsset | null {
  if (!isLibraryKind(imported.kind) || !imported.src) return null
  const vaultId = uniqueUploadId(imported.name, taken)
  elahIds.set(vaultId, imported.id)
  return {
    vaultId,
    name: imported.name.trim() || 'Upload',
    kind: imported.kind,
    durationSec: imported.durationSec > 0 ? imported.durationSec : null,
    src: imported.src,
    thumb: imported.thumbnailUrl ?? null,
  }
}

function uniqueUploadId(name: string, taken: Set<string>): string {
  const safe = name.trim().replace(/[^\w.-]+/g, '_') || 'file'
  const base = `upload/${safe}`
  if (!taken.has(base) && !getLibraryAsset(base)) {
    taken.add(base)
    return base
  }
  let index = 2
  while (taken.has(`${base}-${index}`) || getLibraryAsset(`${base}-${index}`)) index += 1
  const vaultId = `${base}-${index}`
  taken.add(vaultId)
  return vaultId
}

function kindFromName(name: string): LibraryKind | null {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return EXTENSION_KIND[ext] ?? null
}

function isLibraryKind(kind: string): kind is LibraryKind {
  return kind === 'video' || kind === 'audio' || kind === 'image'
}

const pendingDrops = new Map<string, PendingDrop>()

export function beginMediaDrag(
  data: DataTransfer,
  asset: LibraryAsset,
  assetId: string,
  engine: TimelineEngine,
): void {
  pendingDrops.set(assetId, { asset, clipIds: new Set(timelineClipRefs(engine).map((clip) => clip.id)) })
  const payload = JSON.stringify({ kind: 'media-asset', assetId })
  data.setData(MEDIA_DRAG_MIME, payload)
  data.setData(mediaDragKindMime(asset.kind), '')
  data.effectAllowed = 'copy'
}

export function finishMediaDrag(assetId: string, engine: TimelineEngine): LibraryAsset | null {
  const pending = pendingDrops.get(assetId)
  pendingDrops.delete(assetId)
  if (!pending) return null
  return droppedLibraryAsset(pending, assetId, timelineClipRefs(engine))
}

function timelineClipRefs(engine: TimelineEngine): TimelineClipRef[] {
  const refs: TimelineClipRef[] = []
  for (const clips of Object.values(engine.getProject().clips)) {
    for (const clip of clips) refs.push({ id: clip.id, assetId: clip.assetId ?? null })
  }
  return refs
}
