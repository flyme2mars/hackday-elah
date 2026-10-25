import { TimelineEngine, playbackStore, selectionStore, resolveTimeline } from '@elah/editor'
import { applyOps, getTimeline, selectedPlannerClipIds } from '../src/host/applyOps.ts'
import { commandStatusLine } from '../src/host/statusLine.ts'
import { coerceOps, findSimilar } from '../src/sense/client.ts'
import { timelineShortcut } from '../src/host/shortcuts.ts'

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

export async function runHostCases() {
  const engine = new TimelineEngine({ fps: 30, initialTracks: [
    { name: 'V1', kind: 'video' }, { name: 'T1', kind: 'elements' },
  ] })
  const t1 = engine.getProject().tracks.find((t) => t.name === 'T1')!
  const v1 = engine.getProject().tracks.find((t) => t.name === 'V1')!
  await applyOps(engine, coerceOps([
    { op: 'add_text', clip_id: 'title1', content: 'Hello', start_s: 0, duration_s: 2 },
    { op: 'update_text', clip_id: 'title1', background: '#000', background_opacity: 0.5 },
  ]), 'Add title')
  let title = engine.getClipsOnTrack(t1.id)[0]
  check(title.content === 'Hello' && title.durationFrames === 60, 'Title creation')
  check(resolveTimeline(0, engine.getProject()).texts[0].content === 'Hello', 'Title visible in resolved scene')
  check(resolveTimeline(60, engine.getProject()).texts.length === 0, 'Title respects duration')
  check(engine.undo() && engine.getClipsOnTrack(t1.id).length === 0 && !engine.canUndo(), 'One undo for entire batch')
  engine.redo()
  await applyOps(engine, coerceOps([{ op: 'update_text', clip_id: 'title1', content: 'Welcome', start_s: 1, duration_s: 3, x: 0.25, background_opacity: 0 }]), 'Update title')
  title = engine.getClipsOnTrack(t1.id)[0]
  check(title.content === 'Welcome' && title.startFrame === 30 && title.durationFrames === 90 && title.backgroundOpacity === 0, 'Title update survives client parsing')
  const beforeFailure = engine.getProject()
  try {
    await applyOps(engine, [{ op: 'update_text', clip_id: 'title1', content: 'Bad' }, { op: 'update_text', clip_id: 'missing', content: 'Fail' }], 'Fail')
    throw new Error('Expected missing clip to reject')
  } catch (error) {
    check(String(error).includes('Unknown clip'), 'Expected op error')
  }
  check(engine.getProject() === beforeFailure, 'Batch rolls back on failure')
  await applyOps(engine, [{ op: 'remove', clip_id: 'title1' }], 'Remove title')
  check(engine.getClipsOnTrack(t1.id).length === 0, 'Title removed')
  engine.undo()
  check(engine.getClipsOnTrack(t1.id).length === 1, 'Title removal undo')

  const a = engine.addClip({ type: 'video', trackId: v1.id, src: '/samples/flower.mp4', startFrame: 0, durationFrames: 60 })
  const b = engine.addClip({ type: 'video', trackId: v1.id, src: '/samples/bunny.mp4', startFrame: 60, durationFrames: 60 })
  check(resolveTimeline(60, engine.getProject()).transitions.length === 0, 'Default hard cut')
  const fade = { op: 'crossfade', from_clip_id: a.id, to_clip_id: b.id } as const
  await applyOps(engine, coerceOps([fade]), 'Fade')
  const transition = engine.getProject().transitions[0]
  check(transition.kind === 'fade' && transition.durationFrames === 14 && transition.startFrame === 53, 'Native crossfade frames')
  check(resolveTimeline(60, engine.getProject()).transitions[0].t === 0.5, 'Crossfade midpoint')
  check(a.startFrame === 0 && b.startFrame === 60, 'Crossfade preserves clip timing')
  engine.undo()
  check(engine.getProject().transitions.length === 0, 'Crossfade undo')
  engine.redo()
  await applyOps(engine, [fade], 'Replace fade')
  check(engine.getProject().transitions.length === 1, 'No duplicate crossfades')
  for (const invalid of [{ ...fade, from_clip_id: b.id, to_clip_id: a.id }, { ...fade, duration_s: 100 }]) {
    const before = engine.getProject()
    let rejected = false
    try { await applyOps(engine, [invalid], 'Invalid fade') } catch { rejected = true }
    check(rejected && engine.getProject() === before, 'Invalid crossfade rollback')
  }

  const rotated = coerceOps([{ op: 'set_transform', clip_id: a.id, rotation: 180 }])
  check(rotated[0]?.op === 'set_transform' && rotated[0].rotation === 180, 'set_transform parses degrees')
  await applyOps(engine, rotated, 'Rotate 180')
  const upsideDown = engine.findClip(a.id)
  check(upsideDown !== undefined, 'rotated clip stays on the timeline')
  check(Math.abs((upsideDown.clip.transform?.rotation ?? 0) - Math.PI) < 1e-6, '180 degrees is pi radians')
  const reported = getTimeline(engine).tracks.flatMap((track) => track.clips).find((clip) => clip.id === a.id)
  check(reported?.rotation_deg === 180, 'snapshot reports 180 degrees')
  check(engine.undo(), 'rotate undo')
  check(Math.abs(engine.findClip(a.id)?.clip.transform?.rotation ?? 0) < 1e-6, 'one undo restores the angle')
  check(engine.getProject().transitions.length === 1, 'rotate undo leaves the crossfade')
  engine.redo()
  await applyOps(engine, coerceOps([{ op: 'set_transform', clip_id: a.id, rotation: -35 }]), 'Rotate free')
  const free = engine.findClip(a.id)?.clip.transform?.rotation ?? 99
  check(Math.abs(free - (-35 * Math.PI / 180)) < 1e-6, 'free angle is radians')
  check(getTimeline(engine).tracks.flatMap((track) => track.clips).find((clip) => clip.id === a.id)?.rotation_deg === -35, 'snapshot reports the free angle')
  const zoomed = coerceOps([{ op: 'set_transform', clip_id: a.id, scale: 2 }])
  check(zoomed[0]?.op === 'set_transform' && zoomed[0].scale === 2 && zoomed[0].rotation === undefined, 'zoom parses scale without rotation')
  await applyOps(engine, zoomed, 'Zoom in')
  check(engine.findClip(a.id)?.clip.transform?.scale === 2, 'zoom in sets scale to 2')
  check(Math.abs((engine.findClip(a.id)?.clip.transform?.rotation ?? 0) - (-35 * Math.PI / 180)) < 1e-6, 'zoom keeps the free angle')
  await applyOps(engine, coerceOps([{ op: 'set_transform', clip_id: a.id, scale: 3 }]), 'Zoom in more')
  check(engine.findClip(a.id)?.clip.transform?.scale === 3, 'a second zoom changes scale')
  const reportedZoom = getTimeline(engine).tracks.flatMap((track) => track.clips).find((clip) => clip.id === a.id)
  check(reportedZoom?.scale === 3, 'snapshot reports scale')
  await applyOps(engine, coerceOps([{ op: 'set_transform', clip_id: a.id, rotation: 90 }]), 'Rotate after zoom')
  const kept = engine.findClip(a.id)?.clip.transform
  check(kept?.scale === 3, 'a later rotate keeps the zoom')
  check(Math.abs((kept?.rotation ?? 0) - Math.PI / 2) < 1e-6, 'the later rotate still turns the clip')
  await applyOps(engine, coerceOps([{ op: 'set_transform', clip_id: a.id, x: 0.25, y: 0.8 }]), 'Place clip')
  const placed = engine.findClip(a.id)?.clip.transform
  check(placed?.x === 0.25 && placed?.y === 0.8 && placed?.scale === 3, 'position keeps the zoom')
  await applyOps(engine, coerceOps([{ op: 'set_transform', clip_id: a.id, rotation: 180, scale: 2 }]), 'Turn and zoom')
  const turned = engine.findClip(a.id)?.clip.transform
  check(Math.abs((turned?.rotation ?? 0) - Math.PI) < 1e-6 && turned?.scale === 2, 'rotation and scale apply together')
  check(engine.undo(), 'transform undo')
  check(engine.findClip(a.id)?.clip.transform?.scale === 3, 'undo restores the previous scale')
  let scaleRejected = false
  try {
    coerceOps([{ op: 'set_transform', clip_id: a.id, scale: 0 }])
  } catch (error) {
    scaleRejected = true
    check(String(error).includes('scale must be positive'), 'zero scale is rejected')
  }
  check(scaleRejected, 'zero scale does not apply')
  const beforeMissing = engine.getProject()
  let rotateRejected = false
  try {
    await applyOps(engine, coerceOps([{ op: 'set_transform', clip_id: 'missing', rotation: 90 }]), 'Bad rotate')
  } catch (error) {
    rotateRejected = true
    check(String(error).includes('Unknown clip'), 'missing rotate names the clip')
    check(!String(error).includes('clip menu'), 'rotate is applied by the host')
  }
  check(rotateRejected && engine.getProject() === beforeMissing, 'failed rotate rolls back')
  const zoomMotion = coerceOps([{ op: 'set_motion', clip_id: a.id, property: 'zoom', from: 1, to: 2, duration_s: 1 }])
  check(zoomMotion[0]?.op === 'set_motion' && zoomMotion[0].property === 'scale', 'zoom is a scale motion')
  check(zoomMotion[0]?.op === 'set_motion' && zoomMotion[0].keys[1]?.value === 2, 'from and to become keys')
  let badMotion = false
  try {
    coerceOps([{ op: 'set_motion', clip_id: a.id, property: 'scale', from: 1, to: 0, duration_s: 1 }])
  } catch (error) {
    badMotion = true
    check(String(error).includes('scale must be positive'), 'motion scale stays positive')
  }
  check(badMotion, 'a bad motion does not apply')
  await applyOps(engine, coerceOps([{ op: 'set_motion', clip_id: a.id, property: 'rotation', from: 30, to: 60, duration_s: 1 }]), 'Rotate motion')
  const spinning = engine.findClip(a.id)?.clip
  check(spinning?.transform?.scale === 3, 'rotation motion keeps the explicit zoom')
  check(Math.abs((spinning?.transform?.rotation ?? 0) - (30 * Math.PI / 180)) < 1e-6, 'the first rotation key is the resting pose')
  const reportedMotion = getTimeline(engine).tracks.flatMap((track) => track.clips).find((clip) => clip.id === a.id)
  check(reportedMotion?.motion?.rotation?.[1]?.value === 60, 'snapshot keeps the rotation keys')
  const midScene = resolveTimeline(15, engine.getProject())
  const midVideo = midScene.videos.find((video) => video.id === a.id)
  check(Math.abs((midVideo?.transform?.rotation ?? 0) - (45 * Math.PI / 180)) < 1e-6, 'preview samples the rotation halfway')
  check(midVideo?.transform?.scale === 3, 'sampled rotation leaves the zoom alone')
  check(Math.abs((engine.findClip(a.id)?.clip.transform?.rotation ?? 0) - (30 * Math.PI / 180)) < 1e-6, 'sampling does not write the clip')
  const heldScene = resolveTimeline(45, engine.getProject())
  const heldVideo = heldScene.videos.find((video) => video.id === a.id)
  check(Math.abs((heldVideo?.transform?.rotation ?? 0) - (60 * Math.PI / 180)) < 1e-6, 'rotation holds after the last key')
  await applyOps(engine, coerceOps([
    { op: 'set_motion', clip_id: a.id, property: 'x', from: 0.2, to: 0.8, duration_s: 1 },
    { op: 'set_motion', clip_id: a.id, property: 'opacity', keys: [{ t_s: 0, value: 1 }, { t_s: 1, value: 0 }] },
  ]), 'Pan and fade')
  const mixed = resolveTimeline(15, engine.getProject()).videos.find((video) => video.id === a.id)
  check(Math.abs((mixed?.transform?.x ?? 0) - 0.5) < 1e-6, 'pan samples halfway')
  check(Math.abs((mixed?.opacity ?? 1) - 0.5) < 1e-6, 'opacity samples halfway')
  check(mixed?.transform?.scale === 3, 'pan and fade keep the zoom')
  await applyOps(engine, coerceOps([{ op: 'set_transform', clip_id: a.id, rotation: 180 }]), 'Static rotate clears motion')
  const cleared = engine.findClip(a.id)?.clip
  check(cleared?.transform?.scale === 3, 'a later rotate still keeps the zoom')
  check(Math.abs((cleared?.transform?.rotation ?? 0) - Math.PI) < 1e-6, 'static rotate replaces the angle')
  const afterStatic = getTimeline(engine).tracks.flatMap((track) => track.clips).find((clip) => clip.id === a.id)
  check(afterStatic?.motion?.rotation === undefined, 'static rotate clears rotation keys')
  check(afterStatic?.motion?.x?.[1]?.value === 0.8, 'static rotate leaves the pan')
  await applyOps(engine, coerceOps([{ op: 'set_transform', clip_id: a.id, scale: 3 }]), 'Static zoom clears scale motion')
  check(engine.findClip(a.id)?.clip.transform?.scale === 3, 'static zoom writes scale')
  check(getTimeline(engine).tracks.flatMap((track) => track.clips).find((clip) => clip.id === a.id)?.motion?.x, 'zoom leaves the pan')
  const selectionIds = selectedPlannerClipIds({
    fps: 30,
    stage: { width: 1080, height: 1920 },
    duration_s: 1,
    can_undo: false,
    can_redo: false,
    tracks: [{
      alias: 'V1',
      id: 'track',
      name: 'V1',
      kind: 'video',
      clips: [{
        id: 'engine-id',
        alias: 'c1',
        type: 'video',
        name: 'A',
        start_s: 0,
        duration_s: 1,
        in_s: 0,
        volume: 1,
        rotation_deg: 0,
        scale: 1,
        x: 0.5,
        y: 0.5,
      }],
    }],
  }, ['engine-id', 'engine-id'])
  check(selectionIds.length === 1 && selectionIds[0] === 'c1', 'selection uses the alias the planner sees')
  check(commandStatusLine({
    note: 'duration_s must be a number.',
    planner: 'do',
    ops: [],
    hits: [{ id: 'leak' }],
  }) === 'duration_s must be a number.', 'a failed edit status is the error')

  const section = document.createElement('section')
  section.className = 'timeline-pane'
  document.body.append(section)
  const key = (value: string, options: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key: value, cancelable: true, ...options })
    Object.defineProperty(event, 'target', { value: section })
    timelineShortcut(engine, event)
    return event
  }
  playbackStore.getState().setCurrentFrame(0)
  key('ArrowRight')
  check(playbackStore.getState().currentFrame === 1, 'Arrow nudge exactly once')
  key('l', { shiftKey: true })
  check(playbackStore.getState().currentFrame === 31, 'One second nudge')
  key('j')
  check(playbackStore.getState().currentFrame === 30, 'J nudge')
  playbackStore.getState().setCurrentFrame(0)
  key('ArrowLeft')
  check(playbackStore.getState().currentFrame === 0, 'Lower bound')
  playbackStore.getState().setCurrentFrame(engine.getTotalFrames() - 1)
  key('ArrowRight')
  check(playbackStore.getState().currentFrame === engine.getTotalFrames() - 1, 'Upper bound')
  key(' ')
  check(playbackStore.getState().isPlaying, 'Space plays')
  key(' ', { repeat: true })
  check(playbackStore.getState().isPlaying, 'Held Space does not toggle again')
  key(' ')
  check(!playbackStore.getState().isPlaying, 'Space pauses')
  selectionStore.getState().selectClip(b.id)
  key('Delete')
  check(!engine.findClip(b.id), 'Delete selected clip')
  engine.undo()
  check(engine.findClip(b.id), 'Delete undo')
  section.remove()

  const result = await findSimilar('upload/example.mp4', getTimeline(engine), [])
  check(result.note.includes('unavailable') && result.hits.length === 0, 'Upload fallback is explicit without a worker')
  return 'Titles, rollback, undo/redo, rotate, zoom, motion, crossfades, shortcuts and upload fallback passed'
}
