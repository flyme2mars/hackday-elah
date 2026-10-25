export const MOTION_PROPERTIES = ['rotation', 'scale', 'x', 'y', 'opacity'] as const

export type MotionProperty = (typeof MOTION_PROPERTIES)[number]

export interface MotionKey {
  t: number
  value: number
}

export type HostMotion = Partial<Record<MotionProperty, MotionKey[]>>

export interface MotionTransform {
  x: number
  y: number
  scale: number
  rotation: number
  anchor?: { x: number; y: number }
  scaleX?: number
  scaleY?: number
}

interface MotionClip {
  startFrame: number
  opacity?: number
  transform?: MotionTransform
  hostMotion?: unknown
}

export interface MotionProject {
  fps: number
  clips: Record<string, MotionClip[]>
}

const DEG_TO_RAD = Math.PI / 180

export function readHostMotion(clip: object): HostMotion | null {
  const raw = (clip as { hostMotion?: unknown }).hostMotion
  if (!raw || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>
  const motion: HostMotion = {}
  for (const property of MOTION_PROPERTIES) {
    const keys = readKeys(source[property])
    if (keys) motion[property] = keys
  }
  return MOTION_PROPERTIES.some((property) => motion[property]) ? motion : null
}

export function writeTrack(motion: HostMotion | null, property: MotionProperty, keys: readonly MotionKey[]): HostMotion {
  return {
    ...motion,
    [property]: keys
      .map((key) => ({ t: key.t, value: key.value }))
      .sort((left, right) => left.t - right.t),
  }
}

export function assertMotionKeys(property: MotionProperty, keys: readonly MotionKey[]): void {
  if (keys.length < 2) throw new Error('Motion needs at least two keys.')
  for (const key of keys) {
    if (!Number.isFinite(key.t) || key.t < 0) throw new Error('Motion times must be non-negative.')
    if (!Number.isFinite(key.value)) throw new Error('Motion values must be numbers.')
    if (property === 'scale' && key.value <= 0) throw new Error('scale must be positive.')
    if ((property === 'x' || property === 'y' || property === 'opacity') && (key.value < 0 || key.value > 1)) {
      throw new Error(`${property} must be between 0 and 1.`)
    }
  }
}

export function clearedMotionPatch(
  clip: object,
  properties: readonly MotionProperty[],
): { hostMotion: HostMotion | null } | null {
  let motion = readHostMotion(clip)
  let changed = false
  for (const property of properties) {
    const result = clearTrack(motion, property)
    motion = result.motion
    changed = changed || result.changed
  }
  if (!changed) return null
  return { hostMotion: motion }
}

export function clearTrack(
  motion: HostMotion | null,
  property: MotionProperty,
): { motion: HostMotion | null; changed: boolean } {
  if (!motion?.[property]) return { motion, changed: false }
  const next: HostMotion = { ...motion }
  delete next[property]
  const empty = MOTION_PROPERTIES.every((item) => !next[item])
  return { motion: empty ? null : next, changed: true }
}

export function motionForSnapshot(
  clip: object,
): Partial<Record<MotionProperty, { t_s: number; value: number }[]>> | undefined {
  const motion = readHostMotion(clip)
  if (!motion) return undefined
  const snapshot: Partial<Record<MotionProperty, { t_s: number; value: number }[]>> = {}
  for (const property of MOTION_PROPERTIES) {
    const keys = motion[property]
    if (!keys) continue
    snapshot[property] = keys.map((key) => ({ t_s: key.t, value: key.value }))
  }
  return snapshot
}

export function sampleTrack(keys: readonly MotionKey[], time: number): number {
  const first = keys[0]
  const last = keys[keys.length - 1]
  if (!first || !last) return 0
  if (time <= first.t) return first.value
  if (time >= last.t) return last.value
  for (let index = 1; index < keys.length; index += 1) {
    const right = keys[index]
    if (!right || time > right.t) continue
    const left = keys[index - 1]
    if (!left) return right.value
    const span = right.t - left.t
    if (span <= 0) return right.value
    const portion = (time - left.t) / span
    return left.value + (right.value - left.value) * portion
  }
  return last.value
}

export function projectAtFrame<T extends MotionProject>(frame: number, project: T): T {
  if (!(project.fps > 0)) return project
  let clips: Record<string, MotionClip[]> | null = null
  for (const [trackId, list] of Object.entries(project.clips)) {
    let nextList: MotionClip[] | null = null
    for (let index = 0; index < list.length; index += 1) {
      const clip = list[index]
      if (!clip) continue
      const sampled = sampleClip(clip, frame, project.fps)
      if (sampled === clip) continue
      nextList ??= list.slice()
      nextList[index] = sampled
    }
    if (!nextList) continue
    clips ??= { ...project.clips }
    clips[trackId] = nextList
  }
  if (!clips) return project
  return { ...project, clips: clips as T['clips'] }
}

function sampleClip(clip: MotionClip, frame: number, fps: number): MotionClip {
  const motion = readHostMotion(clip)
  if (!motion) return clip
  const time = (frame - clip.startFrame) / fps
  let transform = clip.transform
  let opacity = clip.opacity
  let spatial = false
  let changed = false
  const nextTransform = transform ? { ...transform, anchor: transform.anchor ? { ...transform.anchor } : transform.anchor } : baseTransform()

  if (motion.rotation) {
    nextTransform.rotation = sampleTrack(motion.rotation, time) * DEG_TO_RAD
    spatial = true
    changed = true
  }
  if (motion.scale) {
    nextTransform.scale = sampleTrack(motion.scale, time)
    spatial = true
    changed = true
  }
  if (motion.x) {
    nextTransform.x = sampleTrack(motion.x, time)
    spatial = true
    changed = true
  }
  if (motion.y) {
    nextTransform.y = sampleTrack(motion.y, time)
    spatial = true
    changed = true
  }
  if (motion.opacity) {
    opacity = sampleTrack(motion.opacity, time)
    changed = true
  }
  if (!changed) return clip
  return {
    ...clip,
    ...(spatial ? { transform: nextTransform } : {}),
    ...(motion.opacity ? { opacity } : {}),
  }
}

function baseTransform(): MotionTransform {
  return { x: 0.5, y: 0.5, scale: 1, rotation: 0, anchor: { x: 0.5, y: 0.5 } }
}

function readKeys(value: unknown): MotionKey[] | null {
  if (!Array.isArray(value) || value.length < 2) return null
  const keys: MotionKey[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') return null
    const row = item as { t?: unknown; value?: unknown }
    if (typeof row.t !== 'number' || typeof row.value !== 'number') return null
    if (!Number.isFinite(row.t) || !Number.isFinite(row.value)) return null
    keys.push({ t: row.t, value: row.value })
  }
  keys.sort((left, right) => left.t - right.t)
  return keys
}
