import { resolveTimeline as resolveElahTimeline } from 'host-motion-raw'
import { projectAtFrame, type MotionProject } from './motion.ts'

export function resolveTimeline(frame: number, project: MotionProject): unknown {
  return resolveElahTimeline(frame, projectAtFrame(frame, project))
}
