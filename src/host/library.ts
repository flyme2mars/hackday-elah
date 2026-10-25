export type LibraryKind = 'video' | 'audio' | 'image'

export interface LibraryAsset {
  vaultId: string
  name: string
  kind: LibraryKind
  durationSec: number | null
  src: string
  thumb?: string | null
}

const assets = new Map<string, LibraryAsset>()
const srcIndex = new Map<string, string>()

export function registerAssets(items: readonly LibraryAsset[]): void {
  for (const item of items) {
    if (!item.vaultId || !item.src) continue
    const src = absoluteSrc(item.src)
    const stored: LibraryAsset = { ...item, src }
    assets.set(item.vaultId, stored)
    for (const key of srcKeys(src)) srcIndex.set(key, item.vaultId)
  }
}

export function getLibraryAsset(vaultId: string): LibraryAsset | undefined {
  return assets.get(vaultId)
}

export function listLibraryAssets(): LibraryAsset[] {
  return [...assets.values()]
}

export function vaultIdForSrc(src: string | undefined): string | null {
  if (!src) return null
  for (const key of srcKeys(src)) {
    const vaultId = srcIndex.get(key)
    if (vaultId) return vaultId
  }
  return null
}

export function absoluteSrc(src: string): string {
  return new URL(src, window.location.origin).href
}

function srcKeys(src: string): string[] {
  try {
    const url = new URL(src, window.location.origin)
    return [url.href, `${url.pathname}${url.search}`]
  } catch {
    return [src]
  }
}
