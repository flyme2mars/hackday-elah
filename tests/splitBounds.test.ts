import assert from 'node:assert/strict'
import test from 'node:test'
import { TimelineEngine } from '@elah/editor'
import { applyListedOps } from '../src/host/applyOps.ts'

function engineWithClip(startFrame: number, durationFrames: number) {
  const engine = new TimelineEngine({ fps: 30, initialTracks: [{ name: 'V1', kind: 'video' }] })
  const track = engine.getProject().tracks[0]
  const clip = engine.addClip({
    type: 'video',
    trackId: track.id,
    src: '/samples/flower.mp4',
    startFrame,
    durationFrames,
  })
  return { engine, trackId: track.id, clipId: clip.id }
}

test('split at 0s on a clip that starts at 0 cuts inside the clip', () => {
  const { engine, trackId, clipId } = engineWithClip(0, 90)
  applyListedOps(engine, [{ op: 'split', clip_id: clipId, at_s: 0 }], new Map(), 'Split')
  const clips = engine.getClipsOnTrack(trackId)
  assert.equal(clips.length, 2)
  assert.equal(clips[0].id, clipId)
  assert.equal(clips[0].startFrame, 0)
  assert.ok(clips[0].durationFrames >= 1)
  assert.ok(clips[0].durationFrames < 90)
  assert.equal(clips[1].startFrame, clips[0].startFrame + clips[0].durationFrames)
})

test('split at 0s maps into a clip that does not start at timeline 0', () => {
  const { engine, trackId, clipId } = engineWithClip(120, 90)
  applyListedOps(engine, [{ op: 'split', clip_id: clipId, at_s: 0 }], new Map(), 'Split')
  const clips = engine.getClipsOnTrack(trackId)
  assert.equal(clips.length, 2)
  assert.ok(clips[0].startFrame >= 120)
  assert.ok(clips[1].startFrame > clips[0].startFrame)
  assert.ok(clips[1].startFrame < 210)
  assert.equal(clips[0].durationFrames + clips[1].durationFrames, 90)
})

test('split at the clip start and at the exact end both leave two halves', () => {
  const start = engineWithClip(120, 90)
  applyListedOps(start.engine, [{ op: 'split', clip_id: start.clipId, at_s: 4 }], new Map(), 'Split')
  const fromStart = start.engine.getClipsOnTrack(start.trackId)
  assert.equal(fromStart.length, 2)
  assert.equal(fromStart[0].durationFrames + fromStart[1].durationFrames, 90)

  const end = engineWithClip(0, 90)
  applyListedOps(end.engine, [{ op: 'split', clip_id: end.clipId, at_s: 3 }], new Map(), 'Split')
  const fromEnd = end.engine.getClipsOnTrack(end.trackId)
  assert.equal(fromEnd.length, 2)
  assert.ok(fromEnd[0].durationFrames >= 1)
  assert.ok(fromEnd[1].durationFrames >= 1)
  assert.equal(fromEnd[0].durationFrames + fromEnd[1].durationFrames, 90)
})

test('split at 0s then remove the right half keeps the left', () => {
  const { engine, trackId, clipId } = engineWithClip(120, 90)
  applyListedOps(
    engine,
    [
      { op: 'split', clip_id: clipId, at_s: 0, right_id: 'right-half' },
      { op: 'remove', clip_id: 'right-half' },
    ],
    new Map(),
    'Cut',
  )
  const clips = engine.getClipsOnTrack(trackId)
  assert.equal(clips.length, 1)
  assert.equal(clips[0].id, clipId)
  assert.ok(clips[0].durationFrames >= 1)
  assert.ok(clips[0].durationFrames < 90)
})

test('a split far outside the clip names the clip range', () => {
  const { engine, clipId } = engineWithClip(120, 90)
  assert.throws(
    () => applyListedOps(engine, [{ op: 'split', clip_id: clipId, at_s: 20 }], new Map(), 'Split'),
    /outside clip/,
  )
})
