declare module 'host-motion-raw' {
  import type { MotionProject } from './motion.ts'

  export function resolveTimeline(frame: number, project: MotionProject): unknown
}
