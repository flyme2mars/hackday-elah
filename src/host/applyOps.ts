import {
  type Clip,
  type TimelineEngine,
  type Transform,
} from '@elah/editor'
import { importLibraryMedia } from './media.ts'
import { getLibraryAsset, vaultIdForSrc } from './library.ts'
import { clearedMotionPatch, motionForSnapshot, type HostMotion } from './motion.ts'
import { measureClipForRotation, setClipMotion, setClipTransform, wrapDegrees } from './rotate.ts'
import { opsForSplitParents, type SplitPair } from './splitFollow.ts'
import {
  frameCountToSeconds,
  secondsToFrameCount,
  type ApplyResult,
  type Op,
  type TimelineSnapshot,
  type TrackAlias,
} from './types.ts'

const TRACK_KIND: Record<TrackAlias, 'video' | 'audio' | 'elements'> = {
  V1: 'video',
  V2: 'video',
  A1: 'audio',
  T1: 'elements',
}

interface ResolvedAsset {
  vaultId: string
  id: string
  src: string
  name: string
  durationSec: number
  kind: 'video' | 'audio'
  width?: number
  height?: number
}

interface ClipBinding {
  id: string
  trackId: string
}

type ClipSize = { width: number; height: number }

const EMPTY_ROTATION_SIZES: ReadonlyMap<string, ClipSize> = new Map()

const aliases = new Map<string, ClipBinding>()
const vaultByClipId = new Map<string, string>()

export class ApplyOpsError extends Error {
  readonly opIndex: number
  readonly opName: string

  constructor(opIndex: number, opName: string, message: string) {
    super(`Op ${opIndex} (${opName}): ${message}`)
    this.name = 'ApplyOpsError'
    this.opIndex = opIndex
    this.opName = opName
  }
}

export class MediaUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MediaUnavailableError'
  }
}

export async function applyOps(
  engine: TimelineEngine,
  ops: readonly Op[],
  label: string,
): Promise<ApplyResult> {
  if (ops.length === 0) {
    throw new Error('applyOps needs at least one op')
  }
  const assets = await resolveAssets(ops)
  const rotationSizes = await measureRotationSizes(engine, ops)
  applyListedOps(engine, ops, assets, label, rotationSizes)
  return { label, opCount: ops.length, snapshot: getTimeline(engine) }
}

/** Sync half of applyOps. `label` set means this call opens the batch. */
export function applyListedOps(
  engine: TimelineEngine,
  ops: readonly Op[],
  assets: ReadonlyMap<string, ResolvedAsset>,
  label?: string,
  rotationSizes: ReadonlyMap<string, ClipSize> = EMPTY_ROTATION_SIZES,
): void {
  const splitPairs = new Map<string, SplitPair>()
  const run = () => {
    ops.forEach((op, index) => {
      try {
        for (const target of opsForSplitParents(op, splitPairs)) {
          applyOne(engine, target, assets, rotationSizes, splitPairs)
        }
      } catch (error) {
        if (error instanceof ApplyOpsError) throw error
        const message = error instanceof Error ? error.message : String(error)
        throw new ApplyOpsError(index, op.op, message)
      }
    })
  }

  if (label === undefined) {
    run()
    return
  }
  engine.batch(run, label)
}

export function getTimeline(engine: TimelineEngine): TimelineSnapshot {
  const project = engine.getProject()
  const fps = project.fps
  const aliasByTrackId = new Map<string, TrackAlias>()
  for (const alias of Object.keys(TRACK_KIND) as TrackAlias[]) {
    const track = project.tracks.find((item) => item.name === alias)
    if (track) aliasByTrackId.set(track.id, alias)
  }

  return {
    fps,
    stage: { width: project.stage.width, height: project.stage.height },
    duration_s: frameCountToSeconds(engine.getTotalFrames(), fps),
    can_undo: engine.canUndo(),
    can_redo: engine.canRedo(),
    tracks: project.tracks.map((track) => ({
      alias: aliasByTrackId.get(track.id) ?? null,
      id: track.id,
      name: track.name,
      kind: track.kind,
      clips: (project.clips[track.id] ?? [])
        .slice()
        .sort((a, b) => a.startFrame - b.startFrame)
        .map((clip) => clipSnapshot(clip, fps)),
    })),
  }
}

async function resolveAssets(ops: readonly Op[]): Promise<Map<string, ResolvedAsset>> {
  const ids = new Set<string>()
  for (const op of ops) {
    if (op.op === 'add_clip') ids.add(op.vault_id)
  }

  const resolved = new Map<string, ResolvedAsset>()
  for (const vaultId of ids) {
    const spec = getLibraryAsset(vaultId)
    if (!spec) {
      throw new Error(`Unknown vault_id "${vaultId}". It is not in the current library.`)
    }
    if (spec.kind === 'image') {
      throw new Error(`vault_id "${vaultId}" is an image. add_clip accepts video and audio.`)
    }
    try {
      const asset = await importLibraryMedia(spec)
      if (!Number.isFinite(asset.durationSec) || asset.durationSec <= 0) {
        throw new MediaUnavailableError(`Imported ${spec.name} but the browser reported no duration.`)
      }
      resolved.set(vaultId, {
        vaultId,
        id: asset.id,
        src: asset.src,
        name: asset.name,
        durationSec: asset.durationSec,
        kind: spec.kind,
        width: asset.width,
        height: asset.height,
      })
    } catch (error) {
      if (error instanceof MediaUnavailableError) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new MediaUnavailableError(`Could not import ${spec.name}: ${message}`)
    }
  }
  return resolved
}

async function measureRotationSizes(engine: TimelineEngine, ops: readonly Op[]): Promise<Map<string, ClipSize>> {
  const sizes = new Map<string, ClipSize>()
  for (const op of ops) {
    if (op.op !== 'set_transform') continue
    let clipId = op.clip_id
    try {
      clipId = resolveClip(engine, op.clip_id).id
    } catch {
      continue
    }
    if (sizes.has(clipId)) continue
    const measured = await measureClipForRotation(engine, clipId)
    if (measured) sizes.set(clipId, measured)
  }
  return sizes
}

function sizeForSplitHalf(
  clipId: string,
  rotationSizes: ReadonlyMap<string, ClipSize>,
  splitPairs: ReadonlyMap<string, SplitPair>,
): ClipSize | undefined {
  const direct = rotationSizes.get(clipId)
  if (direct) return direct
  for (const pair of splitPairs.values()) {
    if (pair.rightId === clipId) return rotationSizes.get(pair.leftId)
  }
  return undefined
}

function applyOne(
  engine: TimelineEngine,
  op: Op,
  assets: ReadonlyMap<string, ResolvedAsset>,
  rotationSizes: ReadonlyMap<string, ClipSize>,
  splitPairs: Map<string, SplitPair>,
): void {
  const fps = engine.getProject().fps

  switch (op.op) {
    case 'set_stage': {
      const width = Math.round(op.width)
      const height = Math.round(op.height)
      if (width < 2 || height < 2) {
        throw new Error('stage width and height must be at least 2')
      }
      engine.setStage(width, height)
      return
    }
    case 'add_clip': {
      const asset = assets.get(op.vault_id)
      if (!asset) throw new Error(`No imported asset for vault_id "${op.vault_id}"`)
      const trackId = resolveTrackId(engine, op.track)
      const track = engine.getTrack(trackId)
      if (!track) throw new Error(`Track ${op.track} disappeared`)
      if (track.kind === 'video' && asset.kind !== 'video') {
        throw new Error(`${op.track} is a video track. ${op.vault_id} is ${asset.kind}.`)
      }
      if (track.kind === 'audio' && asset.kind !== 'audio') {
        throw new Error(`${op.track} is an audio track. ${op.vault_id} is ${asset.kind}.`)
      }
      if (track.kind === 'elements') {
        throw new Error(`add_clip cannot target ${op.track} (${track.kind}). Use add_text.`)
      }

      const inFrame = secondsToFrameCount(op.in_s ?? 0, fps)
      const sourceFrames = Math.max(1, secondsToFrameCount(asset.durationSec, fps))
      const durationFrames =
        op.duration_s === undefined
          ? Math.max(1, sourceFrames - inFrame)
          : secondsToFrameCount(op.duration_s, fps)
      if (durationFrames < 1) throw new Error('duration must cover at least one frame')
      if (inFrame + durationFrames > sourceFrames) {
        throw new Error(
          `${op.vault_id} is ${asset.durationSec.toFixed(3)}s. in_s ${op.in_s ?? 0} plus the duration runs past the file.`,
        )
      }

      const clip = engine.addClip({
        type: track.kind === 'audio' ? 'audio' : 'video',
        trackId,
        src: asset.src,
        assetId: asset.id,
        name: op.name ?? asset.name,
        startFrame: secondsToFrameCount(op.start_s, fps),
        durationFrames,
      })
      // addClip always starts the source at frame 0 and sets source duration
      // equal to the timeline duration. The in-point is a follow-up update
      // inside the same batch.
      if (inFrame !== 0 || sourceFrames !== durationFrames) {
        engine.updateClip(clip.id, trackId, {
          sourceStartFrame: inFrame,
          sourceDurationFrames: sourceFrames,
        })
      }
      vaultByClipId.set(clip.id, op.vault_id)
      const alias = op.clip_id ?? clip.id
      remember(alias, { id: clip.id, trackId })
      return
    }
    case 'add_text': {
      validateTextFields(op, fps)
      if (op.content.trim() === '') throw new Error('add_text needs content')
      const trackAlias = op.track ?? 'T1'
      const trackId = resolveTrackId(engine, trackAlias)
      const track = engine.getTrack(trackId)
      if (track?.kind !== 'elements') {
        throw new Error(`add_text target ${trackAlias} is not an elements track`)
      }
      if (engine.isTrackLocked(trackId)) throw new Error('The title track is locked')
      const transform: Transform = {
        x: op.x ?? 0.5,
        y: op.y ?? 0.18,
        scale: 1,
        rotation: 0,
        anchor: { x: 0.5, y: 0.5 },
      }
      const clip = engine.addClip({
        type: 'text',
        trackId,
        name: op.name ?? op.content.slice(0, 42),
        startFrame: secondsToFrameCount(op.start_s, fps),
        durationFrames: Math.max(1, secondsToFrameCount(op.duration_s, fps)),
        text: {
          content: op.content,
          fontSize: op.font_size ?? 56,
          color: op.color ?? '#f4f4f4',
          fontWeight: 'bold',
          textAlign: 'center',
          fontFamily: 'Georgia, "Times New Roman", serif',
        },
        transform,
      })
      if (op.background) {
        engine.updateClip(clip.id, trackId, {
          backgroundColor: op.background,
          backgroundOpacity: op.background_opacity ?? 0.78,
          padding: 18,
          borderRadius: 10,
        })
      }
      remember(op.clip_id ?? clip.id, { id: clip.id, trackId })
      return
    }
    case 'trim': {
      const ref = resolveClip(engine, op.clip_id)
      const before = mustClip(engine, ref.id)
      // Duration-only trims keep the timeline start. Models often send start_s:0
      // from the prompt example; elah then clamps to the source head and would
      // look like a failure even when the length change applied.
      const startFrame =
        op.start_s === undefined || (op.duration_s !== undefined && op.start_s === 0 && before.startFrame > 0)
          ? before.startFrame
          : secondsToFrameCount(op.start_s, fps)
      const durationFrames =
        op.duration_s === undefined
          ? before.durationFrames
          : Math.max(1, secondsToFrameCount(op.duration_s, fps))
      engine.trimClip(ref.id, ref.trackId, startFrame, durationFrames)
      const after = mustClip(engine, ref.id)
      if (after.startFrame !== startFrame && op.duration_s === undefined) {
        throw new Error(
          `trim left the clip at frame ${after.startFrame} instead of ${startFrame}. The source in-point or a neighbour blocked it.`,
        )
      }
      if (op.duration_s !== undefined && after.durationFrames !== durationFrames) {
        throw new Error(
          `trim clamped the clip to ${after.durationFrames} frames. The source window is ${after.sourceDurationFrames} frames.`,
        )
      }
      if (op.in_s !== undefined) {
        engine.updateClip(ref.id, ref.trackId, {
          sourceStartFrame: secondsToFrameCount(op.in_s, fps),
        })
      }
      remember(op.clip_id, { id: ref.id, trackId: after.trackId })
      return
    }
    case 'split': {
      const ref = resolveClip(engine, op.clip_id)
      const atFrame = secondsToFrameCount(op.at_s, fps)
      const result = engine.splitClip(ref.id, ref.trackId, atFrame)
      if (!result) {
        throw new Error(`split at ${op.at_s}s falls outside clip "${op.clip_id}"`)
      }
      const [leftId, rightId] = result
      const vaultId = vaultByClipId.get(leftId)
      if (vaultId) vaultByClipId.set(rightId, vaultId)
      remember(op.clip_id, { id: leftId, trackId: ref.trackId })
      if (op.left_id) remember(op.left_id, { id: leftId, trackId: ref.trackId })
      if (op.right_id) remember(op.right_id, { id: rightId, trackId: ref.trackId })
      splitPairs.set(op.clip_id, { leftId, rightId })
      return
    }
    case 'move': {
      const ref = resolveClip(engine, op.clip_id)
      const toTrackId = op.track ? resolveTrackId(engine, op.track) : ref.trackId
      const startFrame = secondsToFrameCount(op.start_s, fps)
      engine.moveClip(ref.id, ref.trackId, toTrackId, startFrame)
      const found = engine.findClip(ref.id)
      if (!found || found.clip.startFrame !== startFrame || found.trackId !== toTrackId) {
        throw new Error(`move of "${op.clip_id}" was refused. A neighbour occupies that range, or the track is locked.`)
      }
      remember(op.clip_id, { id: ref.id, trackId: found.trackId })
      return
    }
    case 'remove': {
      const ref = resolveClip(engine, op.clip_id)
      engine.removeClip(ref.id, ref.trackId)
      if (engine.findClip(ref.id)) {
        throw new Error(`remove of "${op.clip_id}" was refused because the track is locked`)
      }
      forgetClip(ref.id)
      return
    }
    case 'set_volume': {
      if (!Number.isFinite(op.volume) || op.volume < 0 || op.volume > 1) {
        throw new Error('volume must be between 0 and 1')
      }
      const ref = resolveClip(engine, op.clip_id)
      engine.updateClip(ref.id, ref.trackId, { volume: op.volume })
      return
    }
    case 'set_motion': {
      const ref = resolveClip(engine, op.clip_id)
      setClipMotion(
        engine,
        ref.id,
        op.property,
        op.keys.map((key) => ({ t: key.t_s, value: key.value })),
      )
      const moved = engine.findClip(ref.id)
      if (!moved) throw new Error(`Clip ${ref.id} is not on the timeline`)
      remember(op.clip_id, { id: ref.id, trackId: moved.trackId })
      return
    }
    case 'set_transform': {
      const ref = resolveClip(engine, op.clip_id)
      setClipTransform(
        engine,
        ref.id,
        {
          ...(op.rotation !== undefined ? { absoluteDegrees: op.rotation } : {}),
          ...(op.scale !== undefined ? { scale: op.scale } : {}),
          ...(op.x !== undefined ? { x: op.x } : {}),
          ...(op.y !== undefined ? { y: op.y } : {}),
        },
        sizeForSplitHalf(ref.id, rotationSizes, splitPairs),
      )
      const turned = mustClip(engine, ref.id)
      remember(op.clip_id, { id: ref.id, trackId: turned.trackId })
      return
    }
    case 'update_text': {
      validateTextFields(op, fps)
      const ref = resolveClip(engine, op.clip_id)
      const clip = mustClip(engine, ref.id)
      if (clip.type !== 'text') {
        throw new Error(`"${op.clip_id}" is a ${clip.type} clip, not text`)
      }
      const patch: Partial<Clip> = {}
      let hostMotion: HostMotion | null | undefined
      if (engine.isTrackLocked(ref.trackId) || clip.locked) throw new Error('The title is locked')
      if (op.content !== undefined) patch.content = op.content
      if (op.start_s !== undefined) patch.startFrame = secondsToFrameCount(op.start_s, fps)
      if (op.duration_s !== undefined) {
        patch.durationFrames = secondsToFrameCount(op.duration_s, fps)
        patch.sourceDurationFrames = patch.durationFrames
      }
      if (op.font_size !== undefined) patch.fontSize = op.font_size
      if (op.color !== undefined) patch.color = op.color
      if (op.background !== undefined) {
        patch.backgroundColor = op.background
        patch.backgroundOpacity = op.background_opacity ?? clip.backgroundOpacity ?? 0.78
        patch.padding = clip.padding ?? 18
        patch.borderRadius = clip.borderRadius ?? 10
      }
      if (op.background_opacity !== undefined) patch.backgroundOpacity = op.background_opacity
      if (op.x !== undefined || op.y !== undefined) {
        const prev = clip.transform ?? {
          x: 0.5,
          y: 0.5,
          scale: 1,
          rotation: 0,
          anchor: { x: 0.5, y: 0.5 },
        }
        patch.transform = {
          ...prev,
          x: op.x ?? prev.x,
          y: op.y ?? prev.y,
        }
        const cleared = clearedMotionPatch(clip, [
          ...(op.x !== undefined ? (['x'] as const) : []),
          ...(op.y !== undefined ? (['y'] as const) : []),
        ])
        if (cleared) hostMotion = cleared.hostMotion
      }
      if (Object.keys(patch).length === 0) {
        throw new Error('update_text needs content, timing, or style')
      }
      engine.updateClip(
        ref.id,
        ref.trackId,
        (hostMotion === undefined ? patch : { ...patch, hostMotion }) as Partial<Clip>,
      )
      return
    }
    case 'crossfade': {
      const from = resolveClip(engine, op.from_clip_id)
      const to = resolveClip(engine, op.to_clip_id)
      const a = mustClip(engine, from.id)
      const b = mustClip(engine, to.id)
      if (a.type !== 'video' || b.type !== 'video' || from.trackId !== to.trackId || a.id === b.id) {
        throw new Error('crossfade needs two video clips on the same track')
      }
      if (a.startFrame + a.durationFrames !== b.startFrame) {
        throw new Error('crossfade needs adjacent clips in timeline order')
      }
      if (engine.isTrackLocked(from.trackId) || a.locked || b.locked) throw new Error('The clips are locked')
      const seconds = op.duration_s ?? 0.5
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('crossfade duration must be positive')
      // Elah centers transitions on the cut and rounds to an even frame count.
      const frames = secondsToFrameCount(seconds, fps)
      const durationFrames = Math.max(2, Math.floor(frames / 2) * 2)
      if (durationFrames / 2 > Math.min(a.durationFrames, b.durationFrames)) {
        throw new Error('crossfade is longer than the adjacent clips allow')
      }
      const existing = engine.getProject().transitions.filter((item) => item.fromClipId === a.id && item.toClipId === b.id)
      const startFrame = b.startFrame - durationFrames / 2
      if (engine.getProject().transitions.some((item) => item.trackId === from.trackId &&
        !existing.some((match) => match.id === item.id) &&
        item.startFrame < startFrame + durationFrames && item.startFrame + item.durationFrames > startFrame)) {
        throw new Error('crossfade overlaps another transition')
      }
      for (const item of existing) engine.removeTransition(item.id)
      const transition = engine.addTransition({
        fromClipId: a.id, toClipId: b.id, trackId: from.trackId,
        kind: 'fade', durationFrames, easing: 'linear',
      })
      if (!transition) throw new Error('crossfade could not be applied')
      return
    }
    default: {
      const unknown: never = op
      throw new Error(`Unknown op ${JSON.stringify(unknown)}`)
    }
  }
}

function validateTextFields(op: Extract<Op, { op: 'add_text' | 'update_text' }>, fps: number): void {
  if (op.content !== undefined && !op.content.trim()) throw new Error('Text content must not be empty')
  if (op.start_s !== undefined && (!Number.isFinite(op.start_s) || op.start_s < 0)) {
    throw new Error('Text start must be non-negative')
  }
  if (op.duration_s !== undefined && (!Number.isFinite(op.duration_s) || op.duration_s <= 0 || secondsToFrameCount(op.duration_s, fps) < 1)) {
    throw new Error('Text duration must cover at least one frame')
  }
  if (op.font_size !== undefined && (!Number.isFinite(op.font_size) || op.font_size <= 0)) {
    throw new Error('font_size must be positive')
  }
  for (const value of [op.x, op.y, op.background_opacity]) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) {
      throw new Error('Text position and background opacity must be between 0 and 1')
    }
  }
}

function resolveTrackId(engine: TimelineEngine, alias: TrackAlias): string {
  const track = engine.getProject().tracks.find((item) => item.name === alias)
  if (!track) {
    throw new Error(`Track ${alias} is missing. Boot tracks are named V1, V2, A1, and T1.`)
  }
  if (track.kind !== TRACK_KIND[alias]) {
    throw new Error(`Track ${alias} has kind ${track.kind}. Expected ${TRACK_KIND[alias]}.`)
  }
  return track.id
}

function resolveClip(engine: TimelineEngine, clipId: string): { id: string; trackId: string } {
  const binding = aliases.get(clipId)
  if (binding) {
    const found = engine.findClip(binding.id)
    if (found) return { id: found.clip.id, trackId: found.trackId }
  }
  const direct = engine.findClip(clipId)
  if (direct) return { id: direct.clip.id, trackId: direct.trackId }
  throw new Error(`Unknown clip "${clipId}"`)
}

function mustClip(engine: TimelineEngine, clipId: string): Clip {
  const found = engine.findClip(clipId)
  if (!found) throw new Error(`Clip ${clipId} is not on the timeline`)
  return found.clip
}

function remember(alias: string, binding: ClipBinding): void {
  aliases.set(alias, binding)
}

export function rememberClipVault(clipId: string, vaultId: string): void {
  if (!getLibraryAsset(vaultId)) return
  vaultByClipId.set(clipId, vaultId)
}

export function clearClipBindings(): void {
  aliases.clear()
  vaultByClipId.clear()
}

export function collectClipVaults(engine: TimelineEngine): Record<string, string> {
  reconcileClipVaults(engine)
  const vaults: Record<string, string> = {}
  for (const clips of Object.values(engine.getProject().clips)) {
    for (const clip of clips) {
      const vaultId = vaultIdForClip(engine, clip.id)
      if (vaultId) vaults[clip.id] = vaultId
    }
  }
  return vaults
}

export function vaultIdForClip(engine: TimelineEngine, clipId: string): string | null {
  const bound = vaultByClipId.get(clipId)
  if (bound) return bound
  const found = engine.findClip(clipId)
  if (!found?.clip.src) return null
  const vaultId = vaultIdForSrc(found.clip.src)
  if (!vaultId) return null
  vaultByClipId.set(clipId, vaultId)
  return vaultId
}

export function reconcileClipVaults(engine: TimelineEngine): void {
  for (const clips of Object.values(engine.getProject().clips)) {
    for (const clip of clips) {
      if (vaultByClipId.has(clip.id) || !clip.src) continue
      const vaultId = vaultIdForSrc(clip.src)
      if (vaultId) vaultByClipId.set(clip.id, vaultId)
    }
  }
}

export function selectedPlannerClipIds(snapshot: TimelineSnapshot, engineIds: readonly string[]): string[] {
  const plannerId = new Map<string, string>()
  for (const track of snapshot.tracks) {
    for (const clip of track.clips) {
      plannerId.set(clip.id, clip.alias ?? clip.id)
    }
  }
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of engineIds) {
    const planner = plannerId.get(id) ?? id
    if (!planner || seen.has(planner)) continue
    seen.add(planner)
    out.push(planner)
  }
  return out
}

function forgetClip(clipId: string): void {
  for (const [alias, binding] of aliases) {
    if (binding.id === clipId) aliases.delete(alias)
  }
  vaultByClipId.delete(clipId)
}

function aliasFor(clipId: string): string | null {
  for (const [alias, binding] of aliases) {
    if (binding.id === clipId) return alias
  }
  return null
}

function clipSnapshot(clip: Clip, fps: number): TimelineSnapshot['tracks'][number]['clips'][number] {
  const vaultId = vaultByClipId.get(clip.id)
  const motion = motionForSnapshot(clip)
  return {
    id: clip.id,
    alias: aliasFor(clip.id),
    type: clip.type,
    name: clip.name,
    start_s: frameCountToSeconds(clip.startFrame, fps),
    duration_s: frameCountToSeconds(clip.durationFrames, fps),
    in_s: frameCountToSeconds(clip.sourceStartFrame, fps),
    volume: clip.volume ?? null,
    rotation_deg: wrapDegrees(((clip.transform?.rotation ?? 0) * 180) / Math.PI),
    scale: clip.transform?.scale ?? 1,
    x: clip.transform?.x ?? 0.5,
    y: clip.transform?.y ?? 0.5,
    ...(clip.type === 'text' ? { content: clip.content ?? '' } : {}),
    ...(vaultId ? { vault_id: vaultId } : {}),
    ...(motion ? { motion } : {}),
  }
}
