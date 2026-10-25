import assert from 'node:assert/strict'
import test from 'node:test'
import type { LibraryAsset } from '../src/host/library.ts'
import {
  PROJECT_SCHEMA,
  PROJECT_STORAGE_KEY,
  buildSnapshot,
  dropClipsWithSrc,
  droppedMediaNote,
  isDurableSrc,
  parseSnapshot,
  prepareRestore,
  retargetClips,
  stageOf,
} from '../src/host/projectSnapshot.ts'
import {
  clearStoredSnapshot,
  readStoredSnapshot,
  writeStoredSnapshot,
  type KeyValueStore,
} from '../src/host/projectStorage.ts'

function memoryStore(): KeyValueStore & { dump(): Map<string, string> } {
  const values = new Map<string, string>()
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => {
      values.set(key, value)
    },
    remove: (key) => {
      values.delete(key)
    },
    dump: () => values,
  }
}

function projectFixture() {
  return {
    id: 'p',
    fps: 30,
    version: 1,
    stage: { width: 1920, height: 1080 },
    tracks: [
      { id: 'v', name: 'V1', kind: 'video' },
      { id: 't', name: 'T1', kind: 'elements' },
    ],
    clips: {
      v: [
        {
          id: 'flower',
          type: 'video',
          name: 'Flower',
          src: 'https://editor.example/samples/flower.mp4',
          hostMotion: { rotation: [{ t: 0, value: 0 }, { t: 2, value: 90 }] },
          transform: { rotation: 0, scale: 1, x: 0.5, y: 0.5 },
        },
        {
          id: 'local',
          type: 'video',
          name: 'Clip',
          src: 'blob:https://editor.example/clip',
        },
      ],
      t: [
        {
          id: 'title',
          type: 'text',
          name: 'Title',
          content: 'Frame Flow',
        },
      ],
    },
    transitions: [
      { id: 'fade', fromClipId: 'flower', toClipId: 'local', durationFrames: 14 },
      { id: 'keep', fromClipId: 'flower', toClipId: 'flower', durationFrames: 8 },
    ],
  }
}

test('http and site paths survive a refresh, blob and data urls do not', () => {
  assert.equal(isDurableSrc('https://editor.example/flower.mp4'), true)
  assert.equal(isDurableSrc('http://127.0.0.1:43123/samples/flower.mp4'), true)
  assert.equal(isDurableSrc('/samples/flower.mp4'), true)
  assert.equal(isDurableSrc('blob:http://127.0.0.1/uuid'), false)
  assert.equal(isDurableSrc('data:image/png;base64,aaaa'), false)
  assert.equal(isDurableSrc(''), false)
})

test('schema mismatches and broken json are dropped', () => {
  const store = memoryStore()
  store.set(PROJECT_STORAGE_KEY, JSON.stringify({ schema: 99, project: { clips: {} } }))
  assert.equal(readStoredSnapshot(store), null)
  assert.equal(store.get(PROJECT_STORAGE_KEY), null)
  assert.equal(parseSnapshot('not json'), null)
  assert.equal(parseSnapshot(JSON.stringify({ schema: PROJECT_SCHEMA })), null)
})

test('save, reload, and clear keep the edit and then forget it', () => {
  const library: LibraryAsset[] = [
    {
      vaultId: 'flower.mp4',
      name: 'Flower',
      kind: 'video',
      durationSec: 5,
      src: 'https://editor.example/samples/flower.mp4',
      thumb: 'data:image/png;base64,aaaa',
    },
    {
      vaultId: 'upload/clip.mp4',
      name: 'Clip',
      kind: 'video',
      durationSec: 2,
      src: 'blob:https://editor.example/clip',
      thumb: 'blob:https://editor.example/thumb',
    },
  ]
  const snapshot = buildSnapshot({
    name: '  Cut  ',
    playheadFrame: 30.4,
    library,
    clipVaults: { flower: 'flower.mp4', local: 'upload/clip.mp4' },
    project: projectFixture(),
  })
  assert.equal(snapshot.name, 'Cut')
  assert.equal(snapshot.playheadFrame, 30)
  assert.equal(snapshot.library[0]?.thumb, null)
  assert.equal(snapshot.library[0]?.durable, true)
  assert.equal(snapshot.library[1]?.durable, false)
  const motion = (
    snapshot.project as { clips: { v: { hostMotion?: { rotation: { value: number }[] } }[] } }
  ).clips.v[0]?.hostMotion
  assert.equal(motion?.rotation[1]?.value, 90)

  const store = memoryStore()
  assert.equal(writeStoredSnapshot(store, snapshot), true)
  const loaded = readStoredSnapshot(store)
  assert.deepEqual(loaded, snapshot)
  assert.deepEqual(stageOf(loaded), { width: 1920, height: 1080 })
  clearStoredSnapshot(store)
  assert.equal(readStoredSnapshot(store), null)
})

test('a refresh without upload bytes drops that clip and keeps vault media, text, and motion', () => {
  const snapshot = buildSnapshot({
    name: 'Untitled',
    playheadFrame: 12,
    library: [
      {
        vaultId: 'flower.mp4',
        name: 'Flower',
        kind: 'video',
        durationSec: 5,
        src: 'https://editor.example/samples/flower.mp4',
      },
      {
        vaultId: 'upload/clip.mp4',
        name: 'Clip',
        kind: 'video',
        durationSec: 2,
        src: 'blob:https://editor.example/clip',
      },
    ],
    clipVaults: { flower: 'flower.mp4', local: 'upload/clip.mp4' },
    project: projectFixture(),
  })
  const prepared = prepareRestore(snapshot, new Set())
  assert.ok(prepared)
  const clips = prepared.project as {
    clips: Record<string, { id: string; hostMotion?: unknown }[]>
    transitions: { id: string }[]
  }
  assert.deepEqual(
    Object.values(clips.clips).flat().map((clip) => clip.id),
    ['flower', 'title'],
  )
  assert.equal(clips.clips.v[0]?.hostMotion !== undefined, true)
  assert.deepEqual(clips.transitions.map((item) => item.id), ['keep'])
  assert.deepEqual(prepared.durable.map((item) => item.vaultId), ['flower.mp4'])
  assert.equal(prepared.rewrites.length, 0)
  assert.deepEqual(prepared.droppedNames, ['Clip'])
  assert.equal(droppedMediaNote(prepared.droppedNames), 'Could not restore Clip.')
})

test('stored upload bytes keep the clip and can be pointed at a new blob url', () => {
  const snapshot = buildSnapshot({
    name: 'Untitled',
    playheadFrame: 0,
    library: [
      {
        vaultId: 'upload/dot.png',
        name: 'dot.png',
        kind: 'image',
        durationSec: null,
        src: 'blob:https://editor.example/old',
      },
    ],
    clipVaults: { still: 'upload/dot.png' },
    project: {
      clips: {
        v: [{ id: 'still', type: 'image', name: 'dot.png', src: 'blob:https://editor.example/old' }],
      },
      transitions: [],
    },
  })
  const prepared = prepareRestore(snapshot, new Set(['upload/dot.png']))
  assert.ok(prepared)
  assert.equal(prepared.droppedNames.length, 0)
  assert.deepEqual(prepared.rewrites[0]?.clipIds, ['still'])
  retargetClips(prepared.project, prepared.rewrites[0]?.clipIds ?? [], 'blob:https://editor.example/new', 'asset-2')
  const clip = (prepared.project as { clips: { v: { src: string; assetId: string }[] } }).clips.v[0]
  assert.equal(clip?.src, 'blob:https://editor.example/new')
  assert.equal(clip?.assetId, 'asset-2')
})

test('a failed vault url drops only the clips that used it', () => {
  const project = {
    clips: {
      v: [
        { id: 'flower', type: 'video', name: 'Flower', src: 'https://editor.example/flower.mp4' },
        { id: 'bunny', type: 'video', name: 'Bunny', src: 'https://editor.example/bunny.mp4' },
      ],
    },
    transitions: [{ fromClipId: 'flower', toClipId: 'bunny' }],
  }
  const names = dropClipsWithSrc(project, ['https://editor.example/bunny.mp4'])
  assert.deepEqual(names, ['Bunny'])
  const clips = project.clips.v.map((clip) => clip.id)
  assert.deepEqual(clips, ['flower'])
  assert.equal(project.transitions.length, 0)
})
