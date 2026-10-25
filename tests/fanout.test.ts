import assert from 'node:assert/strict'
import test from 'node:test'
import { droppedLibraryAsset } from '../src/host/dropPlace.ts'
import { opsForSplitParents } from '../src/host/splitFollow.ts'

const bed = {
  vaultId: 'bed.m4a',
  name: 'Bed',
  kind: 'audio' as const,
  durationSec: 8,
  src: '/samples/bed.m4a',
}

test('a follow edit of a split parent aims at both engine ids', () => {
  const pairs = new Map([['c1', { leftId: 'left', rightId: 'right' }]])
  assert.deepEqual(
    opsForSplitParents({ op: 'set_transform', clip_id: 'c1', rotation: 30 }, pairs),
    [
      { op: 'set_transform', clip_id: 'left', rotation: 30 },
      { op: 'set_transform', clip_id: 'right', rotation: 30 },
    ],
  )
})

test('an edit before any split stays on the parent', () => {
  assert.deepEqual(
    opsForSplitParents({ op: 'set_transform', clip_id: 'c1', rotation: 30 }, new Map()),
    [{ op: 'set_transform', clip_id: 'c1', rotation: 30 }],
  )
})

test('remove of the split parent hits both halves', () => {
  const pairs = new Map([['c1', { leftId: 'left', rightId: 'right' }]])
  assert.deepEqual(
    opsForSplitParents({ op: 'remove', clip_id: 'c1' }, pairs),
    [
      { op: 'remove', clip_id: 'left' },
      { op: 'remove', clip_id: 'right' },
    ],
  )
})

test('remove of the right alias leaves the left half', () => {
  const pairs = new Map([['c1', { leftId: 'left', rightId: 'right' }]])
  assert.deepEqual(
    opsForSplitParents({ op: 'remove', clip_id: 'right' }, pairs),
    [{ op: 'remove', clip_id: 'right' }],
  )
})

test('naming only the right half does not rotate the left half', () => {
  const pairs = new Map([['c1', { leftId: 'left', rightId: 'right' }]])
  assert.deepEqual(
    opsForSplitParents({ op: 'set_transform', clip_id: 'right', rotation: 40 }, pairs),
    [{ op: 'set_transform', clip_id: 'right', rotation: 40 }],
  )
})

test('a drag lands only when a new clip carries that asset id', () => {
  const pending = { asset: bed, clipIds: new Set(['old']) }
  assert.equal(droppedLibraryAsset(undefined, 'elah', []), null)
  assert.equal(droppedLibraryAsset(pending, 'elah', [{ id: 'old', assetId: 'elah' }]), null)
  assert.equal(droppedLibraryAsset(pending, 'elah', [{ id: 'new', assetId: 'other' }]), null)
  assert.equal(
    droppedLibraryAsset(pending, 'elah', [
      { id: 'old', assetId: 'elah' },
      { id: 'new', assetId: 'elah' },
    ])?.vaultId,
    'bed.m4a',
  )
})
