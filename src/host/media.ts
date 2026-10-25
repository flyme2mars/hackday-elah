import { importBlob, importFiles, importUrl, MEDIA_DRAG_MIME, mediaDragKindMime, type MediaAsset, type TimelineEngine } from '@elah/editor'
import { droppedLibraryAsset, type PendingDrop, type TimelineClipRef } from './dropPlace.ts'
import { createSharedGate } from './importGate.ts'
import { getLibraryAsset, registerAssets, type LibraryAsset, type LibraryKind } from './library.ts'
import { putUploadBlob } from './projectStorage.ts'

const elahIds = new Map<string, string>()
const loadedByVault = new Map<string, MediaAsset>()

/** Visible cards and the nearby row share this many SDK imports. */
export const MEDIA_IMPORT_CONCURRENCY = 2

const mediaImports = createSharedGate(MEDIA_IMPORT_CONCURRENCY)

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

function importKeys(asset: LibraryAsset): string[] {
  const keys = [`vault:${asset.vaultId}`]
  if (!asset.src) return keys
  keys.push(`src:${asset.src}`)
  if (typeof window === 'undefined') return keys
  try {
    const url = new URL(asset.src, window.location.origin)
    keys.push(`src:${url.href}`)
    keys.push(`src:${url.pathname}${url.search}`)
  } catch {
    // Keep the raw source key when the URL cannot be parsed.
  }
  return keys
}

/**
 * Import a library file once per vault id and source URL.
 * Callers join an in-flight import instead of probing the same URL again.
 * At most {@link MEDIA_IMPORT_CONCURRENCY} imports run at a time.
 */
export async function importLibraryMedia(asset: LibraryAsset): Promise<MediaAsset> {
  const cached = loadedByVault.get(asset.vaultId)
  if (cached) return cached
  const imported = await mediaImports.run(importKeys(asset), 0, () =>
    importUrl(asset.src, { name: asset.name, kind: asset.kind }),
  )
  loadedByVault.set(asset.vaultId, imported)
  elahIds.set(asset.vaultId, imported.id)
  if (imported.src) registerAssets([{ ...asset, src: imported.src }])
  return imported
}

export async function ensureImported(asset: LibraryAsset): Promise<string> {
  const cached = elahIds.get(asset.vaultId)
  if (cached) return cached
  const imported = await importLibraryMedia(asset)
  return imported.id
}

export function clearMediaCache(): void {
  elahIds.clear()
  loadedByVault.clear()
}

/** Re-import bytes saved for a browser upload and point the library at the new blob URL. */
export async function restoreUploadBlob(
  asset: Pick<LibraryAsset, 'vaultId' | 'name' | 'kind' | 'durationSec'>,
  blob: Blob,
): Promise<{ asset: LibraryAsset; mediaId: string }> {
  const imported = await importBlob(blob, { name: asset.name, kind: asset.kind })
  const stored: LibraryAsset = {
    vaultId: asset.vaultId,
    name: asset.name,
    kind: asset.kind,
    durationSec: imported.durationSec > 0 ? imported.durationSec : asset.durationSec,
    src: imported.src,
    thumb: null,
  }
  elahIds.set(asset.vaultId, imported.id)
  loadedByVault.set(asset.vaultId, imported)
  registerAssets([stored])
  return { asset: stored, mediaId: imported.id }
}

/** Register local files into the library as `upload/<name>` and remember the elah asset id. */
export async function importLocalFiles(files: readonly File[]): Promise<LibraryAsset[]> {
  if (files.length === 0) return []
  const result = await importFiles(files)
  const taken = new Set<string>()
  const assets: LibraryAsset[] = []
  const pending = [...files]
  for (const imported of result.imported) {
    const file = takeFile(pending, imported.name, imported.byteSize)
    const asset = rememberUpload(imported, taken)
    if (!asset) continue
    assets.push(asset)
    if (file) await putUploadBlob(asset.vaultId, file)
  }
  for (const skipped of result.skipped) {
    if (skipped.reason !== 'unsupported') continue
    const kind = kindFromName(skipped.file.name)
    if (!kind) continue
    const imported = await importBlob(skipped.file, { name: skipped.file.name, kind })
    const asset = rememberUpload(imported, taken)
    if (!asset) continue
    assets.push(asset)
    await putUploadBlob(asset.vaultId, skipped.file)
  }
  registerAssets(assets)
  return assets
}

function takeFile(pending: File[], name: string, size: number): File | undefined {
  const index = pending.findIndex((file) => file.name === name && file.size === size)
  if (index < 0) return undefined
  return pending.splice(index, 1)[0]
}

function rememberUpload(imported: MediaAsset, taken: Set<string>): LibraryAsset | null {
  if (!isLibraryKind(imported.kind) || !imported.src) return null
  const vaultId = uniqueUploadId(imported.name, taken)
  elahIds.set(vaultId, imported.id)
  loadedByVault.set(vaultId, imported)
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
