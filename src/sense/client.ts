import { registerAssets, type LibraryAsset, type LibraryKind } from '../host/library.ts'
import { fallbackLibrary } from '../host/samples.ts'
import type { Op, TimelineSnapshot } from '../host/types.ts'

export interface SenseHits {
  video: LibraryAsset[]
  audio: LibraryAsset[]
  image: LibraryAsset[]
}

export interface CommandResult {
  note: string
  planner: string
  hits: LibraryAsset[]
  ops: Op[]
  opsLabel: string
}

const LIBRARY_TIMEOUT_MS = 2500
const COMMAND_TIMEOUT_MS = 120_000

export async function loadLibrary(): Promise<LibraryAsset[]> {
  try {
    const response = await fetch('/api/library', { signal: AbortSignal.timeout(LIBRARY_TIMEOUT_MS) })
    if (!response.ok) return fallbackLibrary()
    const body: unknown = await response.json()
    const items = parseAssetList(readItems(body))
    return items.length > 0 ? items : fallbackLibrary()
  } catch {
    return fallbackLibrary()
  }
}

export async function runCommand(
  command: string,
  timeline: TimelineSnapshot,
  library: readonly LibraryAsset[],
): Promise<CommandResult> {
  const response = await fetch('/api/v1/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      command,
      timeline,
      library: library.map(toPayload),
    }),
    signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
  })
  const body = await readJson(response)
  if (!response.ok) {
    throw new Error(noteFrom(body) || 'The sense worker rejected the command.')
  }
  const hits = flattenHits(body)
  registerAssets(hits)
  return {
    note: noteFrom(body),
    planner: typeof body.planner === 'string' ? body.planner : '',
    hits,
    ops: coerceOps(body.ops),
    opsLabel: typeof body.ops_label === 'string' && body.ops_label.trim() ? body.ops_label.trim() : 'Edit',
  }
}

export async function findSimilar(
  vaultId: string,
  timeline: TimelineSnapshot,
  library: readonly LibraryAsset[],
): Promise<{ note: string; hits: LibraryAsset[] }> {
  const response = await fetch('/api/similar', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      vault_id: vaultId,
      k: 5,
      timeline,
      library: library.map(toPayload),
    }),
    signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
  })
  const body = await readJson(response)
  if (!response.ok) {
    throw new Error(noteFrom(body) || 'Similar search failed.')
  }
  const hits = flattenHits(body)
  registerAssets(hits)
  return { note: noteFrom(body), hits }
}

export function isWorkerDown(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'TypeError' || error.name === 'TimeoutError' || error.name === 'AbortError') {
    return true
  }
  return /failed to fetch|network|econnrefused|proxy/i.test(error.message)
}

function toPayload(asset: LibraryAsset) {
  return {
    vault_id: asset.vaultId,
    name: asset.name,
    kind: asset.kind,
    duration_s: asset.durationSec,
    src: asset.src,
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json()
    if (body && typeof body === 'object') return body as Record<string, unknown>
  } catch {
    if (response.status >= 500) {
      throw new Error('Sense worker is not running.')
    }
  }
  return {}
}

function noteFrom(body: Record<string, unknown>): string {
  return typeof body.note === 'string' ? body.note.trim() : ''
}

function readItems(body: unknown): unknown[] {
  if (!body || typeof body !== 'object') return []
  const items = (body as { items?: unknown }).items
  return Array.isArray(items) ? items : []
}

function flattenHits(body: Record<string, unknown>): LibraryAsset[] {
  const hits = body.hits
  if (!hits || typeof hits !== 'object') return []
  const grouped = hits as Record<string, unknown>
  return [
    ...parseAssetList(grouped.video),
    ...parseAssetList(grouped.audio),
    ...parseAssetList(grouped.image),
  ]
}

function parseAssetList(raw: unknown): LibraryAsset[] {
  if (!Array.isArray(raw)) return []
  const assets: LibraryAsset[] = []
  for (const item of raw) {
    const asset = parseAsset(item)
    if (asset) assets.push(asset)
  }
  return assets
}

function parseAsset(raw: unknown): LibraryAsset | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  if (typeof row.vault_id !== 'string' || row.vault_id.trim() === '') return null
  if (!isKind(row.kind)) return null
  const src = resolveMediaSrc(typeof row.src === 'string' ? row.src : '')
  if (!src) return null
  const duration =
    typeof row.duration_s === 'number' && Number.isFinite(row.duration_s) ? row.duration_s : null
  const thumb = typeof row.thumb === 'string' && row.thumb ? resolveMediaSrc(row.thumb) : null
  const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : 'Untitled'
  return { vaultId: row.vault_id, name, kind: row.kind, durationSec: duration, src, thumb }
}

function isKind(value: unknown): value is LibraryKind {
  return value === 'video' || value === 'audio' || value === 'image'
}

export function resolveMediaSrc(src: string): string {
  if (!src) return ''
  if (src.startsWith('/media') || src.startsWith('/thumb')) {
    return new URL(`/api${src}`, window.location.origin).href
  }
  try {
    return new URL(src, window.location.origin).href
  } catch {
    return ''
  }
}

const TRACKS = new Set(['V1', 'V2', 'A1', 'T1'])
const OP_NAMES = new Set([
  'set_stage',
  'add_clip',
  'add_text',
  'trim',
  'split',
  'move',
  'remove',
  'set_volume',
  'update_text',
])

export function coerceOps(raw: unknown): Op[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new Error('Ops were not a list.')
  return raw.map((item, index) => coerceOp(item, index))
}

function coerceOp(raw: unknown, index: number): Op {
  if (!raw || typeof raw !== 'object') throw new Error(`Op ${index} is not an object.`)
  const row = raw as Record<string, unknown>
  const name = row.op
  if (typeof name !== 'string' || !OP_NAMES.has(name)) {
    throw new Error(`Op ${index} has an unknown type.`)
  }
  switch (name) {
    case 'set_stage':
      return { op: 'set_stage', width: requiredNumber(row, 'width'), height: requiredNumber(row, 'height') }
    case 'add_clip':
      return {
        op: 'add_clip',
        vault_id: requiredString(row, 'vault_id'),
        track: requiredTrack(row.track),
        start_s: requiredNumber(row, 'start_s'),
        duration_s: optionalNumber(row.duration_s),
        in_s: optionalNumber(row.in_s),
        name: optionalString(row.name),
        clip_id: optionalString(row.clip_id),
      }
    case 'add_text':
      return {
        op: 'add_text',
        content: requiredString(row, 'content'),
        start_s: requiredNumber(row, 'start_s'),
        duration_s: requiredNumber(row, 'duration_s'),
        track: row.track === undefined ? undefined : requiredTrack(row.track),
        clip_id: optionalString(row.clip_id),
        name: optionalString(row.name),
        x: optionalNumber(row.x),
        y: optionalNumber(row.y),
        font_size: optionalNumber(row.font_size),
        color: optionalString(row.color),
        background: optionalString(row.background),
        background_opacity: optionalNumber(row.background_opacity),
      }
    case 'trim':
      return {
        op: 'trim',
        clip_id: requiredString(row, 'clip_id'),
        start_s: optionalNumber(row.start_s),
        duration_s: optionalNumber(row.duration_s),
        in_s: optionalNumber(row.in_s),
      }
    case 'split':
      return {
        op: 'split',
        clip_id: requiredString(row, 'clip_id'),
        at_s: requiredNumber(row, 'at_s'),
        left_id: optionalString(row.left_id),
        right_id: optionalString(row.right_id),
      }
    case 'move':
      return {
        op: 'move',
        clip_id: requiredString(row, 'clip_id'),
        start_s: requiredNumber(row, 'start_s'),
        track: row.track === undefined ? undefined : requiredTrack(row.track),
      }
    case 'remove':
      return { op: 'remove', clip_id: requiredString(row, 'clip_id') }
    case 'set_volume':
      return {
        op: 'set_volume',
        clip_id: requiredString(row, 'clip_id'),
        volume: requiredNumber(row, 'volume'),
      }
    case 'update_text':
      return {
        op: 'update_text',
        clip_id: requiredString(row, 'clip_id'),
        content: optionalString(row.content),
        font_size: optionalNumber(row.font_size),
        color: optionalString(row.color),
        x: optionalNumber(row.x),
        y: optionalNumber(row.y),
      }
    default:
      throw new Error(`Op ${index} has an unknown type.`)
  }
}

function requiredTrack(value: unknown): 'V1' | 'V2' | 'A1' | 'T1' {
  if (typeof value !== 'string' || !TRACKS.has(value)) throw new Error('Track must be V1, V2, A1, or T1.')
  return value as 'V1' | 'V2' | 'A1' | 'T1'
}

function requiredString(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${key} is required.`)
  return value
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('Expected text.')
  return value
}

function requiredNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} must be a number.`)
  return value
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Expected a number.')
  return value
}
