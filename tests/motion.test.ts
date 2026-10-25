import assert from 'node:assert/strict'
import test from 'node:test'
import { projectAtFrame, sampleTrack, type HostMotion } from '../src/host/motion.ts'

test('linear sample holds outside the keys and blends between them', () => {
  const keys = [
    { t: 0, value: 30 },
    { t: 1.5, value: 45 },
    { t: 3, value: 60 },
  ]
  assert.equal(sampleTrack(keys, -1), 30)
  assert.equal(sampleTrack(keys, 0), 30)
  assert.equal(sampleTrack(keys, 0.75), 37.5)
  assert.equal(sampleTrack(keys, 1.5), 45)
  assert.equal(sampleTrack(keys, 2.25), 52.5)
  assert.equal(sampleTrack(keys, 3), 60)
  assert.equal(sampleTrack(keys, 9), 60)
})

test('projectAtFrame samples each property without writing the source clip', () => {
  const motion: HostMotion = {
    rotation: [
      { t: 0, value: 30 },
      { t: 1, value: 60 },
    ],
    scale: [
      { t: 0, value: 1 },
      { t: 1, value: 2 },
    ],
    x: [
      { t: 0, value: 0.5 },
      { t: 1, value: 0.2 },
    ],
    y: [
      { t: 0, value: 0.5 },
      { t: 1, value: 0.8 },
    ],
    opacity: [
      { t: 0, value: 1 },
      { t: 1, value: 0 },
    ],
  }
  const clip = {
    startFrame: 0,
    opacity: 1,
    transform: { x: 0.5, y: 0.5, scale: 3, rotation: 0, anchor: { x: 0.5, y: 0.5 } },
    hostMotion: motion,
  }
  const project = { fps: 30, clips: { v1: [clip] } }
  const start = projectAtFrame(0, project)
  const mid = projectAtFrame(15, project)
  const end = projectAtFrame(30, project)
  const later = projectAtFrame(90, project)

  assert.notEqual(start, project)
  assert.equal(project.clips.v1[0], clip)
  assert.equal(clip.transform.scale, 3)
  const startClip = start.clips.v1[0]
  assert.ok(startClip)
  assert.ok(Math.abs((startClip.transform?.rotation ?? 0) - (30 * Math.PI) / 180) < 1e-9)
  assert.equal(startClip.transform?.scale, 1)
  assert.equal(startClip.opacity, 1)

  const midClip = mid.clips.v1[0]
  assert.ok(midClip)
  assert.ok(Math.abs((midClip.transform?.rotation ?? 0) - (45 * Math.PI) / 180) < 1e-9)
  assert.equal(midClip.transform?.scale, 1.5)
  assert.equal(midClip.transform?.x, 0.35)
  assert.equal(midClip.transform?.y, 0.65)
  assert.equal(midClip.opacity, 0.5)
  assert.equal(clip.transform.rotation, 0)
  assert.equal(clip.opacity, 1)

  const endClip = end.clips.v1[0]
  assert.ok(Math.abs((endClip?.transform?.rotation ?? 0) - (60 * Math.PI) / 180) < 1e-9)
  assert.equal(endClip?.transform?.scale, 2)
  assert.equal(endClip?.opacity, 0)

  const held = later.clips.v1[0]
  assert.equal(held?.transform?.scale, 2)
  assert.equal(held?.opacity, 0)
})

test('a clip with no motion keeps the same project object', () => {
  const project = {
    fps: 30,
    clips: { v1: [{ startFrame: 0, transform: { x: 0.2, y: 0.7, scale: 3, rotation: 1 } }] },
  }
  assert.equal(projectAtFrame(10, project), project)
})
