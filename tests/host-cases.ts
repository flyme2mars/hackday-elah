import { TimelineEngine, playbackStore, selectionStore, resolveTimeline } from '@elah/editor'
import { applyOps, getTimeline } from '../src/host/applyOps.ts'
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
  return 'Titles, rollback, undo/redo, crossfades, shortcuts and upload fallback passed'
}
