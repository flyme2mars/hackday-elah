import assert from 'node:assert/strict'
import test from 'node:test'
import {
  playableKind,
  previewCardId,
  previewControlLabel,
  reduceSidebarPreview,
  type SidebarPreviewAction,
} from '../src/host/sidebarPreview.ts'

const bed: SidebarPreviewAction = {
  type: 'toggle',
  cardId: previewCardId('search', 'bed.m4a'),
  vaultId: 'bed.m4a',
  kind: 'audio',
  src: '/samples/bed.m4a',
}

test('play starts that card, pause keeps it, and another card replaces it', () => {
  const playing = reduceSidebarPreview(null, bed)
  assert.deepEqual(playing, {
    cardId: 'search:bed.m4a',
    vaultId: 'bed.m4a',
    kind: 'audio',
    src: '/samples/bed.m4a',
    playing: true,
  })

  const paused = reduceSidebarPreview(playing, bed)
  assert.equal(paused?.cardId, 'search:bed.m4a')
  assert.equal(paused?.playing, false)

  const resumed = reduceSidebarPreview(paused, bed)
  assert.equal(resumed?.playing, true)

  const flower = reduceSidebarPreview(resumed, {
    type: 'toggle',
    cardId: previewCardId('search', 'flower.mp4'),
    vaultId: 'flower.mp4',
    kind: 'video',
    src: '/samples/flower.mp4',
  })
  assert.equal(flower?.cardId, 'search:flower.mp4')
  assert.equal(flower?.playing, true)
  assert.equal(flower?.kind, 'video')
})

test('library and search copies of one asset do not preview together', () => {
  const libraryId = previewCardId('library', 'bed.m4a')
  const searchId = previewCardId('search', 'bed.m4a')
  assert.notEqual(libraryId, searchId)
  const search = reduceSidebarPreview(null, bed)
  const library = reduceSidebarPreview(search, { ...bed, cardId: libraryId })
  assert.equal(library?.cardId, libraryId)
  assert.equal(library?.playing, true)
  assert.equal(reduceSidebarPreview(library, { type: 'release', cardId: searchId })?.cardId, libraryId)
  assert.equal(reduceSidebarPreview(library, { type: 'release', cardId: libraryId }), null)
})

test('stop clears playback and a missing source does not start it', () => {
  const playing = reduceSidebarPreview(null, bed)
  assert.equal(reduceSidebarPreview(playing, { type: 'stop' }), null)
  assert.equal(reduceSidebarPreview(null, { type: 'stop' }), null)
  assert.equal(
    reduceSidebarPreview(playing, { ...bed, cardId: 'search:empty', src: '' }),
    playing,
  )
})

test('images are not playable and preview labels leave the transport names alone', () => {
  assert.equal(playableKind('audio'), 'audio')
  assert.equal(playableKind('video'), 'video')
  assert.equal(playableKind('image'), null)
  assert.equal(previewControlLabel('Bed', false), 'Play Bed')
  assert.equal(previewControlLabel('Bed', true), 'Pause Bed')
  assert.notEqual(previewControlLabel('Bed', false), 'Play')
  assert.notEqual(previewControlLabel('Bed', true), 'Pause')
})
