import { useState } from 'react'
import { X, Trash2, Blend } from 'lucide-react'
import { type TimelineEngine, useTransitionsStore } from '@elah/editor'
import FloatingPanel, { type PanelAnchor } from './FloatingPanel.tsx'

export default function TransitionPanel({
  engine,
  fromId,
  toId,
  anchor,
  onClose,
  onStatus,
}: {
  engine: TimelineEngine
  fromId: string
  toId: string
  anchor: PanelAnchor
  onClose: () => void
  onStatus: (status: string) => void
}) {
  const existing = useTransitionsStore((s) =>
    s.transitions.find((t) => t.fromClipId === fromId && t.toClipId === toId),
  )
  const fps = engine.getProject().fps
  const [seconds, setSeconds] = useState(
    String((existing?.durationFrames ?? 14) / fps),
  )
  function apply() {
    const a = engine.findClip(fromId)
    const b = engine.findClip(toId)
    const duration = Number(seconds)
    if (
      !a ||
      !b ||
      a.trackId !== b.trackId ||
      a.clip.type !== 'video' ||
      b.clip.type !== 'video' ||
      a.clip.startFrame + a.clip.durationFrames !== b.clip.startFrame
    ) {
      onStatus('Select two adjacent video clips on the same track.')
      return
    }
    if (engine.isTrackLocked(a.trackId) || a.clip.locked || b.clip.locked) {
      onStatus('The clips are locked.')
      return
    }
    const frames = Math.max(2, Math.round((duration * fps) / 2) * 2)
    if (
      !Number.isFinite(duration) ||
      duration <= 0 ||
      frames / 2 > Math.min(a.clip.durationFrames, b.clip.durationFrames)
    ) {
      onStatus('Choose a positive duration that fits both clips.')
      return
    }
    const start = b.clip.startFrame - frames / 2
    if (
      engine
        .getProject()
        .transitions.some(
          (t) =>
            t.id !== existing?.id &&
            t.trackId === a.trackId &&
            t.startFrame < start + frames &&
            t.startFrame + t.durationFrames > start,
        )
    ) {
      onStatus('This dissolve would overlap another transition.')
      return
    }
    engine.batch(() => {
      if (existing) engine.removeTransition(existing.id)
      engine.addTransition({
        fromClipId: fromId,
        toClipId: toId,
        trackId: a.trackId,
        kind: 'fade',
        durationFrames: frames,
        easing: 'linear',
      })
    }, 'Set dissolve')
    onStatus('Dissolve applied.')
    onClose()
  }
  return (
    <FloatingPanel anchor={anchor} label="Transition" onClose={onClose}>
      <div className="panel-heading">
        <span>
          <Blend size={14} /> Dissolve
        </span>
        <button
          className="icon-btn"
          aria-label="Close transition"
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </div>
      <div className="panel-body">
        <p className="panel-description">Blend the frames across this cut.</p>
        <label className="field-label" htmlFor="transition-duration">
          Duration <span>seconds</span>
        </label>
        <input
          id="transition-duration"
          className="number-field"
          type="number"
          min={2 / fps}
          step={1 / fps}
          value={seconds}
          onChange={(e) => setSeconds(e.target.value)}
        />
        <button className="btn btn-primary wide" onClick={apply}>
          Apply dissolve
        </button>
        {existing && (
          <button
            className="panel-action"
            onClick={() => {
              if (engine.isTrackLocked(existing.trackId)) {
                onStatus('The track is locked.')
                return
              }
              engine.removeTransition(existing.id)
              onClose()
            }}
          >
            <Trash2 size={14} /> Remove transition
          </button>
        )}
      </div>
    </FloatingPanel>
  )
}
