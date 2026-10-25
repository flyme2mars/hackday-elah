import {
  mediaLibraryStore,
  transformFromContainRect,
  type Clip,
  type TimelineEngine,
  type Transform,
} from '@elah/editor'
import {
  assertMotionKeys,
  clearedMotionPatch,
  readHostMotion,
  writeTrack,
  type MotionKey,
  type MotionProperty,
} from './motion.ts'
import { secondsToFrameCount } from './types.ts'

/** Elah applies `transform.rotation` with sin/cos and canvas `rotate`, so the unit is radians. */
const DEG_TO_RAD = Math.PI / 180

export interface TransformChange {
  /** Added to the current angle. Menu clicks use this. */
  deltaDegrees?: number
  /** Replaces the current angle. `set_transform` uses this. */
  absoluteDegrees?: number
  scale?: number
  x?: number
  y?: number
}

export type RotationChange = Pick<TransformChange, 'deltaDegrees' | 'absoluteDegrees'>

/** Wrapped degrees in (-180, 180], matching the radians elah stores. */
export function wrapDegrees(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0
  const next = wrapRadians(degrees * DEG_TO_RAD) / DEG_TO_RAD
  if (Math.abs(next) < 0.05) return 0
  if (Math.abs(next + 180) < 0.05) return 180
  return Math.round(next * 10) / 10
}

export function clipRotationDegrees(engine: TimelineEngine, clipId: string): number {
  const found = engine.findClip(clipId)
  return wrapDegrees((found?.clip.transform?.rotation ?? 0) / DEG_TO_RAD)
}

/**
 * Turn a clip in Preview. Video and image turns stay contain-fit and centered:
 * 180° keeps the upright scale, and 90° shrinks so the frame is not cropped.
 * `updateClip` is its own undo step outside a batch. Pass `preview` while a
 * slider is moving, then `commitClipRotation` once.
 */
export async function rotateClip(engine: TimelineEngine, clipId: string, deltaDegrees: number): Promise<void> {
  const found = engine.findClip(clipId)
  if (!found) throw new Error(`Unknown clip "${clipId}"`)
  // Measure even after the first turn so 90° can refit. A failed probe still rotates.
  let measured: { width: number; height: number } | undefined
  try {
    measured = await measureClip(found.clip)
  } catch {
    measured = undefined
  }
  setClipRotation(engine, clipId, { deltaDegrees }, measured)
}

export function setClipRotation(
  engine: TimelineEngine,
  clipId: string,
  change: RotationChange,
  measured?: { width: number; height: number },
  options?: { preview?: boolean },
): void {
  setClipTransform(engine, clipId, change, measured, options)
}

export function setClipTransform(
  engine: TimelineEngine,
  clipId: string,
  change: TransformChange,
  measured?: { width: number; height: number },
  options?: { preview?: boolean },
): void {
  const found = engine.findClip(clipId)
  if (!found) throw new Error(`Unknown clip "${clipId}"`)
  const clip = found.clip
  const prev = clip.transform
  const rotation = nextRotation(prev?.rotation ?? 0, change)
  const transform = buildTransform(engine, clip, rotation, change, measured ?? sizeFromLibrary(clip))
  const patch = { transform, ...(clearedMotionPatch(clip, touchedProperties(change)) ?? {}) } as Partial<Clip>
  if (options?.preview) {
    engine.previewClip(clip.id, found.trackId, patch)
    return
  }
  engine.updateClip(clip.id, found.trackId, patch)
}

/** Straight-line motion on one property. The first key is also the resting pose. */
export function setClipMotion(
  engine: TimelineEngine,
  clipId: string,
  property: MotionProperty,
  keys: readonly MotionKey[],
): void {
  assertMotionKeys(property, keys)
  const found = engine.findClip(clipId)
  if (!found) throw new Error(`Unknown clip "${clipId}"`)
  const clip = found.clip
  const sorted = [...keys].sort((left, right) => left.t - right.t)
  const first = sorted[0]
  if (!first) throw new Error('Motion needs at least two keys.')
  const hostMotion = writeTrack(readHostMotion(clip), property, sorted)
  const patch: { hostMotion: typeof hostMotion; transform?: Transform; opacity?: number } = { hostMotion }
  if (property === 'opacity') {
    patch.opacity = first.value
  } else {
    const prev = clip.transform ?? { x: 0.5, y: 0.5, scale: 1, rotation: 0, anchor: { x: 0.5, y: 0.5 } }
    patch.transform = {
      ...prev,
      anchor: prev.anchor ?? { x: 0.5, y: 0.5 },
      ...(property === 'rotation' ? { rotation: first.value * DEG_TO_RAD } : { [property]: first.value }),
    }
  }
  const end = sorted[sorted.length - 1]
  engine.batch(() => {
    engine.updateClip(clip.id, found.trackId, patch as Partial<Clip>)
    if (end) lengthenClip(engine, clip.id, secondsToFrameCount(end.t, engine.getProject().fps))
  }, 'Animate clip')
}

/**
 * Images have no media file past the placed length. `trimClip` clamps them to
 * `sourceDurationFrames`, so a longer animation has to raise that window first.
 * Video and audio stay inside the file.
 */
export function widenImageSource(engine: TimelineEngine, clipId: string, durationFrames: number): void {
  const found = engine.findClip(clipId)
  if (!found || found.clip.type !== 'image') return
  const clip = found.clip
  if (durationFrames <= clip.durationFrames) return
  const speed = clip.speed && clip.speed > 0 ? clip.speed : 1
  const neededSource = Math.max(clip.sourceDurationFrames, Math.ceil(durationFrames * speed))
  if (neededSource <= clip.sourceDurationFrames) return
  engine.updateClip(clip.id, found.trackId, { sourceDurationFrames: neededSource })
}

export function lengthenClip(engine: TimelineEngine, clipId: string, durationFrames: number): void {
  const found = engine.findClip(clipId)
  if (!found || durationFrames <= found.clip.durationFrames) return
  widenImageSource(engine, clipId, durationFrames)
  const clip = engine.findClip(clipId)?.clip ?? found.clip
  engine.trimClip(clip.id, found.trackId, clip.startFrame, durationFrames)
}

function touchedProperties(change: TransformChange): MotionProperty[] {
  const properties: MotionProperty[] = []
  if (change.absoluteDegrees !== undefined || change.deltaDegrees !== undefined) properties.push('rotation')
  if (change.scale !== undefined) properties.push('scale')
  if (change.x !== undefined) properties.push('x')
  if (change.y !== undefined) properties.push('y')
  return properties
}

/** One undo step for a run of `setClipRotation(..., { preview: true })` calls. */
export function commitClipRotation(engine: TimelineEngine): void {
  engine.commitInteraction('Rotate clip')
}

export async function measureClipForRotation(
  engine: TimelineEngine,
  clipId: string,
): Promise<{ width: number; height: number } | undefined> {
  const found = engine.findClip(clipId)
  if (!found) return undefined
  try {
    return await measureClip(found.clip)
  } catch {
    return undefined
  }
}

function nextRotation(currentRadians: number, change: TransformChange): number {
  if (change.absoluteDegrees !== undefined) return wrapRadians(change.absoluteDegrees * DEG_TO_RAD)
  if (change.deltaDegrees === undefined) return currentRadians
  return wrapRadians(currentRadians + change.deltaDegrees * DEG_TO_RAD)
}

function placesClip(change: TransformChange): boolean {
  return change.scale !== undefined || change.x !== undefined || change.y !== undefined
}

function buildTransform(
  engine: TimelineEngine,
  clip: Clip,
  rotation: number,
  change: TransformChange,
  size: { width: number; height: number } | undefined,
): Transform {
  const stage = engine.getProject().stage
  const prev = clip.transform
  const canRefit =
    !placesClip(change) &&
    size !== undefined &&
    (clip.type === 'video' || clip.type === 'image') &&
    stage.width > 0 &&
    stage.height > 0
  if (canRefit && size && (prev === undefined || poseIsFitted(prev, size, stage.width, stage.height))) {
    // Start from contain-fit, then shrink so the rotated box still sits inside the stage.
    // 180° keeps the upright scale. 90° would otherwise crop a portrait frame.
    return containFit(size, rotation, stage.width, stage.height)
  }
  return {
    x: change.x ?? prev?.x ?? 0.5,
    y: change.y ?? prev?.y ?? 0.5,
    scale: change.scale ?? prev?.scale ?? 1,
    rotation,
    anchor: prev?.anchor ?? { x: 0.5, y: 0.5 },
  }
}

function containFit(
  size: { width: number; height: number },
  rotation: number,
  stageWidth: number,
  stageHeight: number,
): Transform {
  const fit = transformFromContainRect(size.width, size.height, stageWidth, stageHeight)
  const fittedWidth = size.width * fit.scale
  const fittedHeight = size.height * fit.scale
  return {
    x: fit.x,
    y: fit.y,
    scale: fit.scale * containScaleForRotation(fittedWidth, fittedHeight, rotation, stageWidth, stageHeight),
    rotation,
    anchor: { x: 0.5, y: 0.5 },
  }
}

function poseIsFitted(
  prev: Transform,
  size: { width: number; height: number },
  stageWidth: number,
  stageHeight: number,
): boolean {
  const fit = containFit(size, prev.rotation, stageWidth, stageHeight)
  return near(prev.x, fit.x) && near(prev.y, fit.y) && near(prev.scale, fit.scale)
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= 5e-4
}

/** Scale factor that keeps a rotated width×height rectangle inside the stage. */
function containScaleForRotation(
  width: number,
  height: number,
  rotation: number,
  stageWidth: number,
  stageHeight: number,
): number {
  const cos = Math.abs(Math.cos(rotation))
  const sin = Math.abs(Math.sin(rotation))
  const rotatedWidth = width * cos + height * sin
  const rotatedHeight = width * sin + height * cos
  if (rotatedWidth <= 0 || rotatedHeight <= 0) return 1
  return Math.min(stageWidth / rotatedWidth, stageHeight / rotatedHeight)
}

function sizeFromLibrary(clip: Clip): { width: number; height: number } | undefined {
  if (!clip.assetId) return undefined
  const asset = mediaLibraryStore.getState().getAsset(clip.assetId)
  if (!asset?.width || !asset.height || asset.width <= 0 || asset.height <= 0) return undefined
  return { width: asset.width, height: asset.height }
}

async function measureClip(clip: Clip): Promise<{ width: number; height: number } | undefined> {
  const known = sizeFromLibrary(clip)
  if (known) return known
  if (!clip.src || (clip.type !== 'video' && clip.type !== 'image')) return undefined
  return probeMediaSize(clip.src, clip.type)
}

function probeMediaSize(src: string, kind: 'video' | 'image'): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const el = document.createElement(kind === 'video' ? 'video' : 'img')
    let settled = false
    let timer = 0
    const finish = (width: number, height: number) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      el.remove()
      if (width > 0 && height > 0) resolve({ width, height })
      else reject(new Error('Could not read the clip size.'))
    }
    timer = window.setTimeout(() => finish(0, 0), 800)
    el.addEventListener('error', () => finish(0, 0))
    if (el instanceof HTMLVideoElement) {
      el.preload = 'metadata'
      el.muted = true
      el.addEventListener('loadedmetadata', () => finish(el.videoWidth, el.videoHeight))
    } else {
      el.addEventListener('load', () => finish(el.naturalWidth, el.naturalHeight))
    }
    el.src = src
  })
}

function wrapRadians(radians: number): number {
  const full = Math.PI * 2
  let wrapped = radians % full
  if (wrapped > Math.PI) wrapped -= full
  if (wrapped <= -Math.PI) wrapped += full
  if (Math.abs(wrapped) < 1e-10) return 0
  return wrapped
}
