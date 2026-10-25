import { useTimelineEngine, useTracksStore, type Project } from '@elah/editor'
import { ChevronDown } from 'lucide-react'

const PRESETS = [
  { id: 'portrait', label: '9:16 · Portrait', width: 1080, height: 1920 },
  { id: 'landscape', label: '16:9 · Landscape', width: 1920, height: 1080 },
  { id: 'square', label: '1:1 · Square', width: 1080, height: 1080 },
  { id: 'social', label: '4:5 · Portrait', width: 1080, height: 1350 },
]

function aspectRatio({ width, height }: Project['stage']): string {
  let divisor = width
  let remainder = height
  while (remainder !== 0) {
    const next = divisor % remainder
    divisor = remainder
    remainder = next
  }
  return `${width / divisor}:${height / divisor}`
}

export function ProjectFormatReadout() {
  const stage = useTracksStore((state) => state.stage)
  const engine = useTimelineEngine()
  return (
    <span className="project-format">
      {stage.width} × {stage.height} <span> / </span> {engine.getProject().fps}{' '}
      FPS
    </span>
  )
}

export function ProjectAspectControl() {
  const engine = useTimelineEngine()
  const stage = useTracksStore((state) => state.stage)
  const preset = PRESETS.find(
    (item) => item.width === stage.width && item.height === stage.height,
  )
  return (
    <div className="stage-fit">
      <span>Fit</span>
      <span aria-hidden="true">·</span>
      <label className="aspect-control">
        <span className="sr-only">Project aspect ratio</span>
        <select
          value={preset?.id ?? 'current'}
          onChange={(event) => {
            const next = PRESETS.find(
              (item) => item.id === event.currentTarget.value,
            )
            if (next) engine.setStage(next.width, next.height)
          }}
        >
          {!preset && (
            <option value="current" disabled>
              {aspectRatio(stage)} · {stage.width} × {stage.height}
            </option>
          )}
          {PRESETS.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
        <ChevronDown size={11} aria-hidden="true" />
      </label>
    </div>
  )
}
