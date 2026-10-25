import type { LibraryAsset, LibraryKind } from './library.ts'

/** Host wrapper around an @elah/editor project document. Bump when the shape changes. */
export const PROJECT_SCHEMA = 1

export const PROJECT_STORAGE_KEY = 'frameflow.project'

export const DEFAULT_STAGE = { width: 1080, height: 1920 }

const MEDIA_TYPES = new Set(['video', 'audio', 'image'])

export interface PersistedLibraryItem {
  vaultId: string
  name: string
  kind: LibraryKind
  durationSec: number | null
  /** Fetchable URL, or the blob URL from the session that saved this item. */
  src: string
  thumb: string | null
  /** False for blob: and data: sources. Those need bytes stored beside the snapshot. */
  durable: boolean
}

export interface ProjectSnapshot {
  schema: typeof PROJECT_SCHEMA
  name: string
  playheadFrame: number
  library: PersistedLibraryItem[]
  /** Engine clip id to library vault id. Upload bytes are keyed by vault id. */
  clipVaults: Record<string, string>
  /** @elah/editor project document, including clips, transforms, motion, text, and transitions. */
  project: unknown
}

export interface UploadRewrite {
  vaultId: string
  name: string
  kind: LibraryKind
  durationSec: number | null
  clipIds: string[]
}

export interface PreparedRestore {
  project: unknown
  durable: PersistedLibraryItem[]
  rewrites: UploadRewrite[]
  droppedNames: string[]
}

interface LooseClip {
  id: string
  type: string
  name: string
  src?: string
  assetId?: string
  [key: string]: unknown
}

interface LooseTransition {
  fromClipId: string
  toClipId: string
  [key: string]: unknown
}

interface LooseProject {
  clips: Record<string, LooseClip[]>
  transitions: LooseTransition[]
  [key: string]: unknown
}

export function isDurableSrc(src: string): boolean {
  if (!src || src.startsWith('blob:') || src.startsWith('data:')) return false
  if (src.startsWith('https://') || src.startsWith('http://')) return true
  return src.startsWith('/') && !src.startsWith('//')
}

export function stageOf(snapshot: ProjectSnapshot | null): { width: number; height: number } | null {
  if (!snapshot || !snapshot.project || typeof snapshot.project !== 'object') return null
  const stage = (snapshot.project as { stage?: { width?: unknown; height?: unknown } }).stage
  if (!stage || typeof stage.width !== 'number' || typeof stage.height !== 'number') return null
  if (!Number.isFinite(stage.width) || !Number.isFinite(stage.height)) return null
  const width = Math.round(stage.width)
  const height = Math.round(stage.height)
  if (width < 2 || height < 2) return null
  return { width, height }
}

export function parseSnapshot(raw: string | null | undefined): ProjectSnapshot | null {
  if (!raw) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (row.schema !== PROJECT_SCHEMA) return null
  if (!row.project || typeof row.project !== 'object' || Array.isArray(row.project)) return null
  return {
    schema: PROJECT_SCHEMA,
    name: cleanName(row.name),
    playheadFrame: clampFrame(row.playheadFrame),
    library: parseLibrary(row.library),
    clipVaults: parseClipVaults(row.clipVaults),
    project: row.project,
  }
}

export function buildSnapshot(input: {
  name: string
  playheadFrame: number
  library: readonly LibraryAsset[]
  clipVaults: Readonly<Record<string, string>>
  project: unknown
}): ProjectSnapshot {
  return {
    schema: PROJECT_SCHEMA,
    name: cleanName(input.name),
    playheadFrame: clampFrame(input.playheadFrame),
    library: input.library.flatMap(persistLibraryItem),
    clipVaults: parseClipVaults(input.clipVaults),
    project: cloneJson(input.project),
  }
}

/**
 * Decide which library rows and clips can come back.
 * `storedUploadIds` are vault ids whose bytes are in IndexedDB.
 * Clips that cannot be rehydrated are removed from the cloned project.
 */
export function prepareRestore(
  snapshot: ProjectSnapshot,
  storedUploadIds: ReadonlySet<string>,
): PreparedRestore | null {
  const project = asProject(cloneJson(snapshot.project))
  if (!project) return null

  const durable: PersistedLibraryItem[] = []
  const rewrites: UploadRewrite[] = []
  const droppedNames: string[] = []
  const keptClipIds = new Set<string>()

  for (const item of snapshot.library) {
    if (item.durable && isDurableSrc(item.src)) {
      durable.push(item)
      continue
    }
    const clipIds = clipIdsForUpload(project, item, snapshot.clipVaults)
    if (!storedUploadIds.has(item.vaultId)) {
      droppedNames.push(item.name)
      continue
    }
    for (const id of clipIds) keptClipIds.add(id)
    rewrites.push({
      vaultId: item.vaultId,
      name: item.name,
      kind: item.kind,
      durationSec: item.durationSec,
      clipIds,
    })
  }

  const orphanIds: string[] = []
  for (const bucket of Object.values(project.clips)) {
    for (const clip of bucket) {
      if (!MEDIA_TYPES.has(clip.type)) continue
      if (isDurableSrc(clip.src ?? '')) continue
      if (keptClipIds.has(clip.id)) continue
      orphanIds.push(clip.id)
      if (clip.name) droppedNames.push(clip.name)
    }
  }
  removeClipIds(project, orphanIds)
  return { project, durable, rewrites, droppedNames: uniqueNames(droppedNames) }
}

export function retargetClips(project: unknown, clipIds: readonly string[], src: string, assetId: string): void {
  const loose = asProject(project)
  if (!loose) return
  const ids = new Set(clipIds)
  for (const bucket of Object.values(loose.clips)) {
    for (const clip of bucket) {
      if (!ids.has(clip.id)) continue
      clip.src = src
      clip.assetId = assetId
    }
  }
}

export function dropClipsWithSrc(project: unknown, srcs: readonly string[]): string[] {
  const loose = asProject(project)
  if (!loose) return []
  const banned = new Set(srcs)
  const names: string[] = []
  const ids: string[] = []
  for (const bucket of Object.values(loose.clips)) {
    for (const clip of bucket) {
      if (!clip.src || !banned.has(clip.src)) continue
      ids.push(clip.id)
      if (clip.name) names.push(clip.name)
    }
  }
  removeClipIds(loose, ids)
  return names
}

export function removeClipIds(project: unknown, clipIds: readonly string[]): void {
  const loose = asProject(project)
  if (!loose || clipIds.length === 0) return
  const ids = new Set(clipIds)
  for (const trackId of Object.keys(loose.clips)) {
    loose.clips[trackId] = loose.clips[trackId].filter((clip) => !ids.has(clip.id))
  }
  loose.transitions = loose.transitions.filter(
    (item) => !ids.has(item.fromClipId) && !ids.has(item.toClipId),
  )
}

export function droppedMediaNote(names: readonly string[]): string {
  const unique = uniqueNames(names)
  if (unique.length === 0) return ''
  if (unique.length === 1) return `Could not restore ${unique[0]}.`
  if (unique.length === 2) return `Could not restore ${unique[0]} and ${unique[1]}.`
  return `Could not restore ${unique[0]}, ${unique[1]} and ${unique.length - 2} more.`
}

export function libraryFromSnapshot(snapshot: ProjectSnapshot | null): LibraryAsset[] {
  if (!snapshot) return []
  return snapshot.library.flatMap((item) => {
    if (!item.durable || !isDurableSrc(item.src)) return []
    return [
      {
        vaultId: item.vaultId,
        name: item.name,
        kind: item.kind,
        durationSec: item.durationSec,
        src: item.src,
        thumb: item.thumb,
      },
    ]
  })
}

function persistLibraryItem(item: LibraryAsset): PersistedLibraryItem[] {
  if (!item.vaultId || !item.src) return []
  if (item.kind !== 'video' && item.kind !== 'audio' && item.kind !== 'image') return []
  const name = item.name.trim()
  if (!name) return []
  return [
    {
      vaultId: item.vaultId,
      name,
      kind: item.kind,
      durationSec:
        typeof item.durationSec === 'number' && Number.isFinite(item.durationSec) ? item.durationSec : null,
      src: item.src,
      thumb: item.thumb && isDurableSrc(item.thumb) ? item.thumb : null,
      durable: isDurableSrc(item.src),
    },
  ]
}

function parseLibrary(raw: unknown): PersistedLibraryItem[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item) => {
    const parsed = parseLibraryItem(item)
    return parsed ? [parsed] : []
  })
}

function parseLibraryItem(raw: unknown): PersistedLibraryItem | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  if (typeof row.vaultId !== 'string' || row.vaultId.trim() === '') return null
  if (row.kind !== 'video' && row.kind !== 'audio' && row.kind !== 'image') return null
  if (typeof row.name !== 'string' || row.name.trim() === '') return null
  if (typeof row.src !== 'string' || row.src === '') return null
  const durationSec =
    typeof row.durationSec === 'number' && Number.isFinite(row.durationSec) ? row.durationSec : null
  const thumb = typeof row.thumb === 'string' && isDurableSrc(row.thumb) ? row.thumb : null
  return {
    vaultId: row.vaultId,
    name: row.name.trim(),
    kind: row.kind,
    durationSec,
    src: row.src,
    thumb,
    durable: isDurableSrc(row.src),
  }
}

function parseClipVaults(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const vaults: Record<string, string> = {}
  for (const [clipId, vaultId] of Object.entries(raw)) {
    if (!clipId || typeof vaultId !== 'string' || vaultId.trim() === '') continue
    vaults[clipId] = vaultId
  }
  return vaults
}

function clipIdsForUpload(
  project: LooseProject,
  item: PersistedLibraryItem,
  clipVaults: Readonly<Record<string, string>>,
): string[] {
  const ids = new Set<string>()
  for (const [clipId, vaultId] of Object.entries(clipVaults)) {
    if (vaultId === item.vaultId) ids.add(clipId)
  }
  for (const bucket of Object.values(project.clips)) {
    for (const clip of bucket) {
      if (clip.src && clip.src === item.src) ids.add(clip.id)
    }
  }
  return [...ids]
}

function asProject(value: unknown): LooseProject | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (!row.clips || typeof row.clips !== 'object' || Array.isArray(row.clips)) return null
  const clips: Record<string, LooseClip[]> = {}
  for (const [trackId, bucket] of Object.entries(row.clips as Record<string, unknown>)) {
    if (!Array.isArray(bucket)) return null
    const parsed: LooseClip[] = []
    for (const clip of bucket) {
      if (!clip || typeof clip !== 'object') return null
      const item = clip as Record<string, unknown>
      if (typeof item.id !== 'string' || typeof item.type !== 'string') return null
      parsed.push(clip as LooseClip)
    }
    clips[trackId] = parsed
  }
  const transitions: LooseTransition[] = []
  if (Array.isArray(row.transitions)) {
    for (const item of row.transitions) {
      if (!item || typeof item !== 'object') continue
      const transition = item as Record<string, unknown>
      if (typeof transition.fromClipId !== 'string' || typeof transition.toClipId !== 'string') continue
      transitions.push(item as LooseTransition)
    }
  }
  row.clips = clips
  row.transitions = transitions
  return row as LooseProject
}

function cloneJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown
}

function uniqueNames(names: readonly string[]): string[] {
  const unique: string[] = []
  for (const name of names) {
    const trimmed = name.trim()
    if (!trimmed || unique.includes(trimmed)) continue
    unique.push(trimmed)
  }
  return unique
}

function cleanName(value: unknown): string {
  if (typeof value !== 'string') return 'Untitled'
  const trimmed = value.trim()
  if (!trimmed) return 'Untitled'
  return trimmed.slice(0, 80)
}

function clampFrame(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.round(value))
}
