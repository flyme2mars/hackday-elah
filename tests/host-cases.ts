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

  const splitEngine = new TimelineEngine({ fps: 30, initialTracks: [{ name: 'V1', kind: 'video' }] })
  const splitTrack = splitEngine.getProject().tracks[0]
  const early = splitEngine.addClip({ type: 'video', trackId: splitTrack.id, src: '/samples/flower.mp4', startFrame: 0, durationFrames: 90 })
  await applyOps(splitEngine, [
    { op: 'set_transform', clip_id: early.id, rotation: 20 },
    { op: 'split', clip_id: early.id, at_s: 1.5 },
  ], 'Turn then cut')
  const earlyHalves = getTimeline(splitEngine).tracks[0].clips
  check(earlyHalves.length === 2 && earlyHalves.every((clip) => clip.rotation_deg === 20), 'A rotate before the split is copied onto both halves')

  const cut = splitEngine.addClip({ type: 'video', trackId: splitTrack.id, src: '/samples/bunny.mp4', startFrame: 120, durationFrames: 90 })
  await applyOps(splitEngine, [
    { op: 'split', clip_id: cut.id, at_s: 5.5 },
    { op: 'set_transform', clip_id: cut.id, rotation: 30 },
  ], 'Cut and turn both')
  const both = getTimeline(splitEngine).tracks[0].clips.filter((clip) => clip.start_s >= 4)
  check(both.length === 2 && both.every((clip) => clip.rotation_deg === 30), 'Split then rotate hits both halves')

  const spun = splitEngine.addClip({ type: 'video', trackId: splitTrack.id, src: '/samples/flower.mp4', startFrame: 240, durationFrames: 90 })
  await applyOps(splitEngine, [
    { op: 'split', clip_id: spun.id, at_s: 9.5 },
    { op: 'set_motion', clip_id: spun.id, property: 'rotation', keys: [{ t_s: 0, value: 30 }, { t_s: 1, value: 60 }] },
  ], 'Cut and spin both')
  const spunHalves = getTimeline(splitEngine).tracks[0].clips.filter((clip) => clip.start_s >= 8)
  check(
    spunHalves.length === 2 && spunHalves.every((clip) => clip.motion?.rotation?.[0]?.value === 30 && clip.motion?.rotation?.[1]?.value === 60),
    'Split then motion hits both halves',
  )

  const trimmed = splitEngine.addClip({ type: 'video', trackId: splitTrack.id, src: '/samples/bunny.mp4', startFrame: 360, durationFrames: 90 })
  await applyOps(splitEngine, [
    { op: 'split', clip_id: trimmed.id, at_s: 13.5 },
    { op: 'trim', clip_id: trimmed.id, duration_s: 0.5 },
  ], 'Cut and trim both')
  const short = getTimeline(splitEngine).tracks[0].clips.filter((clip) => clip.start_s >= 12 && clip.start_s < 16)
  check(short.length === 2 && short.every((clip) => clip.duration_s === 0.5), 'Split then trim hits both halves')

  const sided = splitEngine.addClip({ type: 'video', trackId: splitTrack.id, src: '/samples/flower.mp4', startFrame: 480, durationFrames: 90 })
  await applyOps(splitEngine, [
    { op: 'split', clip_id: sided.id, at_s: 17.5, right_id: 'right-half' },
    { op: 'set_transform', clip_id: 'right-half', rotation: 40 },
  ], 'Turn the right half')
  const sides = getTimeline(splitEngine).tracks[0].clips.filter((clip) => clip.start_s >= 16 && clip.start_s < 20)
  check(sides.length === 2, 'Right-only rotate leaves both halves on the track')
  const right = sides.find((clip) => clip.alias === 'right-half')
  const left = sides.find((clip) => clip.alias !== 'right-half')
  check(right?.rotation_deg === 40 && left?.rotation_deg === 0, 'An op that names only the right half leaves the left half')

  const doomed = splitEngine.addClip({ type: 'video', trackId: splitTrack.id, src: '/samples/bunny.mp4', startFrame: 600, durationFrames: 90 })
  await applyOps(splitEngine, [
    { op: 'split', clip_id: doomed.id, at_s: 21.5 },
    { op: 'remove', clip_id: doomed.id },
  ], 'Cut and remove both')
  check(getTimeline(splitEngine).tracks[0].clips.every((clip) => clip.start_s < 20), 'Split then remove drops both halves')

  const stillEngine = new TimelineEngine({ fps: 30, initialTracks: [{ name: 'V1', kind: 'video' }] })
  const stillTrack = stillEngine.getProject().tracks[0]
  const photo = stillEngine.addClip({ type: 'image', trackId: stillTrack.id, src: '/photo.png', name: 'Photo', startFrame: 0, durationFrames: 72 })
  check(photo.sourceDurationFrames === 72 && photo.durationFrames === 72, 'A placed still starts with a 72-frame source window')
  await applyOps(stillEngine, coerceOps([{ op: 'set_transform', clip_id: photo.id, scale: 2 }]), 'Zoom still')
  await applyOps(stillEngine, coerceOps([{ op: 'set_motion', clip_id: photo.id, property: 'rotation', from: 30, to: 90, duration_s: 2 }]), 'Rotate still for 2s')
  const spunStill = stillEngine.findClip(photo.id)?.clip
  check(spunStill?.durationFrames === 72 && spunStill.sourceDurationFrames === 72, 'A 2s spin fits inside the placed still')
  check(spunStill?.transform?.scale === 2, 'The 2s spin keeps the zoom')
  const spunKeys = getTimeline(stillEngine).tracks[0].clips[0]?.motion?.rotation
  check(spunKeys?.[0]?.value === 30 && spunKeys?.[1]?.t_s === 2 && spunKeys?.[1]?.value === 90, 'The 2s spin stores the endpoints')
  await applyOps(stillEngine, coerceOps([{ op: 'set_motion', clip_id: photo.id, property: 'rotation', from: 30, to: 90, duration_s: 8 }]), 'Extend rotation to 8s')
  const extended = stillEngine.findClip(photo.id)?.clip
  check(extended?.durationFrames === 240 && (extended?.sourceDurationFrames ?? 0) >= 240, 'The still stays up for the 8s rotation')
  check(extended?.transform?.scale === 2, 'Extending the rotation keeps the zoom')
  const extendedKeys = getTimeline(stillEngine).tracks[0].clips[0]?.motion?.rotation
  check(extendedKeys?.[0]?.value === 30 && extendedKeys?.[1]?.t_s === 8 && extendedKeys?.[1]?.value === 90, 'The rotation span is 8 seconds')
  const midStill = resolveTimeline(120, stillEngine.getProject()).images.find((image) => image.id === photo.id)
  check(Math.abs((midStill?.transform?.rotation ?? 0) - (60 * Math.PI / 180)) < 1e-6, 'The extended rotation is halfway at 4 seconds')
  check(Math.abs((stillEngine.findClip(photo.id)?.clip.transform?.rotation ?? 0) - (30 * Math.PI / 180)) < 1e-6, 'Sampling leaves the resting pose')
  check(stillEngine.undo(), 'Undo the 8s extension')
  const restored = stillEngine.findClip(photo.id)?.clip
  check(restored?.durationFrames === 72 && restored.sourceDurationFrames === 72, 'Undo restores the 72-frame still')
  const restoredKeys = getTimeline(stillEngine).tracks[0].clips[0]?.motion?.rotation
  check(restoredKeys?.[1]?.t_s === 2 && restoredKeys?.[1]?.value === 90 && restored?.transform?.scale === 2, 'Undo restores the 2s rotation')
  check(stillEngine.undo(), 'Undo the 2s rotation')
  check(getTimeline(stillEngine).tracks[0].clips[0]?.motion?.rotation === undefined, 'The undo stack restores the still before the spin')
  check(stillEngine.redo() && getTimeline(stillEngine).tracks[0].clips[0]?.motion?.rotation?.[1]?.t_s === 2, 'Redo restores the 2s spin')
  check(stillEngine.redo() && stillEngine.findClip(photo.id)?.clip.durationFrames === 240, 'Redo restores the 8s still')

  const historyPane = document.createElement('section')
  historyPane.className = 'timeline-pane'
  document.body.append(historyPane)
  const historyKey = (value: string, options: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key: value, cancelable: true, bubbles: true, ...options })
    Object.defineProperty(event, 'target', { value: historyPane })
    timelineShortcut(stillEngine, event)
    return event
  }
  const undone = historyKey('z', { ctrlKey: true })
  check(undone.defaultPrevented && stillEngine.findClip(photo.id)?.clip.durationFrames === 72, 'Ctrl+Z undoes the extension')
  const redone = historyKey('z', { metaKey: true, shiftKey: true })
  check(redone.defaultPrevented && stillEngine.findClip(photo.id)?.clip.durationFrames === 240, 'Cmd+Shift+Z redoes the extension')
  historyKey('z', { ctrlKey: true })
  const replayed = historyKey('y', { ctrlKey: true })
  check(replayed.defaultPrevented && stillEngine.findClip(photo.id)?.clip.durationFrames === 240, 'Ctrl+Y redoes the extension')
  historyPane.remove()

  const typing = document.createElement('textarea')
  typing.value = 'extend the rotation'
  const typed = new KeyboardEvent('keydown', { key: 'z', cancelable: true, ctrlKey: true })
  Object.defineProperty(typed, 'target', { value: typing })
  timelineShortcut(stillEngine, typed)
  check(!typed.defaultPrevented && stillEngine.findClip(photo.id)?.clip.durationFrames === 240, 'A filled command field keeps text undo')
  typing.value = ''
  const emptyUndo = new KeyboardEvent('keydown', { key: 'z', cancelable: true, metaKey: true })
  Object.defineProperty(emptyUndo, 'target', { value: typing })
  timelineShortcut(stillEngine, emptyUndo)
  check(emptyUndo.defaultPrevented && stillEngine.findClip(photo.id)?.clip.durationFrames === 72, 'An empty command field undoes the timeline')
  check(getTimeline(stillEngine).tracks[0].clips[0]?.motion?.rotation?.[1]?.t_s === 2, 'That undo restores the 2s rotation')

  const trimmedStill = stillEngine.addClip({ type: 'image', trackId: stillTrack.id, src: '/photo.png', name: 'Second', startFrame: 300, durationFrames: 72 })
  let stillTrimError = ''
  try {
    await applyOps(stillEngine, [{ op: 'trim', clip_id: trimmedStill.id, duration_s: 8 }], 'Lengthen still')
  } catch (error) {
    stillTrimError = String(error)
  }
  check(stillTrimError === '' && stillEngine.findClip(trimmedStill.id)?.clip.durationFrames === 240, `A still trim to 8s lengthens the timeline (${stillTrimError})`)
  check((stillEngine.findClip(trimmedStill.id)?.clip.sourceDurationFrames ?? 0) >= 240, 'The still source window grows with the trim')
  check(!stillTrimError.includes('source window'), 'A still trim does not report a source window')

  const limited = stillEngine.addClip({ type: 'video', trackId: stillTrack.id, src: '/samples/flower.mp4', name: 'Short', startFrame: 600, durationFrames: 72 })
  const beforeLimit = stillEngine.getProject()
  let videoTrimError = ''
  try {
    await applyOps(stillEngine, [{ op: 'trim', clip_id: limited.id, duration_s: 8 }], 'Lengthen video')
  } catch (error) {
    videoTrimError = String(error)
  }
  check(videoTrimError.includes('source window') && stillEngine.getProject() === beforeLimit, 'A video trim still stops at the file')
  await applyOps(stillEngine, coerceOps([{ op: 'set_motion', clip_id: limited.id, property: 'rotation', from: 0, to: 20, duration_s: 8 }]), 'Spin a short video')
  check(stillEngine.findClip(limited.id)?.clip.durationFrames === 72, 'Motion on a short video does not pass the file')
  check(getTimeline(stillEngine).tracks[0].clips.find((clip) => clip.id === limited.id)?.motion?.rotation?.[1]?.t_s === 8, 'The short video still stores the 8s keys')

  const roomy = stillEngine.addClip({ type: 'video', trackId: stillTrack.id, src: '/samples/bunny.mp4', name: 'Roomy', startFrame: 900, durationFrames: 60 })
  stillEngine.updateClip(roomy.id, stillTrack.id, { sourceDurationFrames: 600 })
  await applyOps(stillEngine, coerceOps([{ op: 'set_motion', clip_id: roomy.id, property: 'rotation', from: 10, to: 40, duration_s: 2 }]), 'Spin inside the file')
  check(stillEngine.findClip(roomy.id)?.clip.durationFrames === 60, 'A 2s spin leaves a longer source alone')
  await applyOps(stillEngine, coerceOps([{ op: 'set_motion', clip_id: roomy.id, property: 'rotation', from: 10, to: 40, duration_s: 8 }]), 'Extend inside the file')
  check(stillEngine.findClip(roomy.id)?.clip.durationFrames === 240, 'A video out-point grows when the file allows it')
  check(stillEngine.findClip(roomy.id)?.clip.sourceDurationFrames === 600, 'Extending motion does not invent video media')
  check(stillEngine.undo() && stillEngine.findClip(roomy.id)?.clip.durationFrames === 60, 'Undo restores the video out-point')

  const titleEngine = new TimelineEngine({ fps: 30, initialTracks: [
    { name: 'V1', kind: 'video' },
    { name: 'T1', kind: 'elements' },
  ] })
  await applyOps(titleEngine, coerceOps([
    { op: 'add_text', clip_id: 'text_hello_world', content: 'Hello World', track: 'T1', start_s: 0, duration_s: 2 },
    { op: 'set_motion', clip_id: 'text_hello_world', property: 'rotation', from: 0, to: 360, duration_s: 10 },
  ]), 'Spin the title')
  const titleClips = getTimeline(titleEngine).tracks.find((track) => track.alias === 'T1')?.clips ?? []
  check(titleClips.length === 1, 'Hello World is one text clip')
  const hello = titleClips[0]
  check(hello?.content === 'Hello World' && hello.start_s === 0 && hello.alias === 'text_hello_world', 'Hello World sits at the start under its alias')
  check((hello?.duration_s ?? 0) >= 10, 'The title lasts for the ten second rotation')
  check(hello?.motion?.rotation?.[0]?.value === 0 && hello?.motion?.rotation?.[1]?.t_s === 10 && hello?.motion?.rotation?.[1]?.value === 360, 'The title rotation runs for ten seconds')
  const midTitle = resolveTimeline(150, titleEngine.getProject()).texts.find((text) => text.content === 'Hello World')
  check(midTitle !== undefined, 'The title is on screen five seconds in')
  check(Math.abs((midTitle?.transform?.rotation ?? 0) - Math.PI) < 1e-6, 'The title is halfway through a full turn at five seconds')

  return 'Titles, rollback, undo/redo, rotate, zoom, motion, still extend, crossfades, shortcuts, split fan-out and upload fallback passed'
}
