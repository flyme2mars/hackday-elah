import type { LibraryAsset } from './library.ts'
import { absoluteSrc } from './library.ts'

interface LocalFile {
  vaultId: string
  path: string
  kind: 'video' | 'audio'
  name: string
  durationSec: number
}

/**
 * Files in public/samples, used only when the vault catalog is empty.
 * Ids are the filenames. Display names stay separate from those ids.
 *
 * flower.mp4: MDN CC0 flower, center-cropped to 9:16.
 * bunny.mp4: Big Buck Bunny trailer, Blender Foundation, CC BY 3.0.
 * bed.m4a: audio extracted from bunny.mp4.
 */
const LOCAL_FILES: readonly LocalFile[] = [
  {
    vaultId: 'flower.mp4',
    path: '/samples/flower.mp4',
    kind: 'video',
    name: 'Flower',
    durationSec: 5.005,
  },
  {
    vaultId: 'bunny.mp4',
    path: '/samples/bunny.mp4',
    kind: 'video',
    name: 'Bunny',
    durationSec: 8,
  },
  {
    vaultId: 'bed.m4a',
    path: '/samples/bed.m4a',
    kind: 'audio',
    name: 'Bed',
    durationSec: 8,
  },
]

export function fallbackLibrary(): LibraryAsset[] {
  return LOCAL_FILES.map((file) => ({
    vaultId: file.vaultId,
    name: file.name,
    kind: file.kind,
    durationSec: file.durationSec,
    src: absoluteSrc(file.path),
  }))
}
