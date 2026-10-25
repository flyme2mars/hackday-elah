export const FPS = 30

export const TRACK_ALIASES = ['V1', 'V2', 'A1', 'T1'] as const
export type TrackAlias = (typeof TRACK_ALIASES)[number]

/**
 * Seconds-based ops. The host converts every time with Math.round(seconds * fps)
 * before it calls TimelineEngine. `clip_id` is a host alias, not an engine id.
 */
export type Op =
  | { op: 'crossfade'; from_clip_id: string; to_clip_id: string; duration_s?: number }
  | { op: 'set_stage'; width: number; height: number }
  | {
      op: 'add_clip'
      vault_id: string
      track: TrackAlias
      start_s: number
      duration_s?: number
      in_s?: number
      name?: string
      clip_id?: string
    }
  | {
      op: 'add_text'
      content: string
      start_s: number
      duration_s: number
      track?: TrackAlias
      clip_id?: string
      name?: string
      x?: number
      y?: number
      font_size?: number
      color?: string
      background?: string
      background_opacity?: number
    }
  | {
      op: 'trim'
      clip_id: string
      start_s?: number
      duration_s?: number
      in_s?: number
    }
  | {
      op: 'split'
      clip_id: string
      at_s: number
      left_id?: string
      right_id?: string
    }
  | {
      op: 'move'
      clip_id: string
      start_s: number
      track?: TrackAlias
    }
  | { op: 'remove'; clip_id: string }
  | { op: 'set_volume'; clip_id: string; volume: number }
  | { op: 'set_transform'; clip_id: string; rotation: number }
  | {
      op: 'update_text'
      clip_id: string
      content?: string
      start_s?: number
      duration_s?: number
      font_size?: number
      color?: string
      x?: number
      y?: number
      background?: string
      background_opacity?: number
    }

export interface TimelineClipSnapshot {
  id: string
  alias: string | null
  type: string
  name: string
  start_s: number
  duration_s: number
  in_s: number
  volume: number | null
  rotation_deg: number
  content?: string
  vault_id?: string
}

export interface TimelineTrackSnapshot {
  alias: TrackAlias | null
  id: string
  name: string
  kind: string
  clips: TimelineClipSnapshot[]
}

export interface TimelineSnapshot {
  fps: number
  stage: { width: number; height: number }
  duration_s: number
  can_undo: boolean
  can_redo: boolean
  tracks: TimelineTrackSnapshot[]
}

export interface ApplyResult {
  label: string
  opCount: number
  snapshot: TimelineSnapshot
}

/** Math.round(seconds * fps), clamped at 0. Same formula as elah's secondsToFrames. */
export function secondsToFrameCount(seconds: number, fps: number): number {
  if (!Number.isFinite(seconds)) {
    throw new Error(`Expected a finite number of seconds, received ${String(seconds)}`)
  }
  return Math.max(0, Math.round(seconds * fps))
}

export function frameCountToSeconds(frames: number, fps: number): number {
  if (fps <= 0) return 0
  return Math.round((frames / fps) * 1000) / 1000
}
