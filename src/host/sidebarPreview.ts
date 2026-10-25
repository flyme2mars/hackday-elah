import type { LibraryKind } from './library.ts'

export type SidebarPreviewScope = 'library' | 'search'

export type SidebarPreviewKind = 'audio' | 'video'

/** The one sidebar preview. `playing` lives here so pause cannot exist without a card. */
export interface SidebarPreview {
  cardId: string
  vaultId: string
  kind: SidebarPreviewKind
  src: string
  playing: boolean
}

export type SidebarPreviewAction =
  | {
      type: 'toggle'
      cardId: string
      vaultId: string
      kind: SidebarPreviewKind
      src: string
    }
  | { type: 'stop' }
  | { type: 'release'; cardId: string }

export function previewCardId(scope: SidebarPreviewScope, vaultId: string): string {
  return `${scope}:${vaultId}`
}

export function playableKind(kind: LibraryKind): SidebarPreviewKind | null {
  if (kind === 'audio' || kind === 'video') return kind
  return null
}

/** Transport already owns the exact names Play and Pause. Keep those free. */
export function previewControlLabel(name: string, playing: boolean): string {
  return `${playing ? 'Pause' : 'Play'} ${name}`
}

export function reduceSidebarPreview(
  state: SidebarPreview | null,
  action: SidebarPreviewAction,
): SidebarPreview | null {
  if (action.type === 'stop') return null
  if (action.type === 'release') return state?.cardId === action.cardId ? null : state
  if (!action.src) return state
  if (state?.cardId === action.cardId) {
    return {
      cardId: action.cardId,
      vaultId: action.vaultId,
      kind: action.kind,
      src: action.src,
      playing: !state.playing,
    }
  }
  return {
    cardId: action.cardId,
    vaultId: action.vaultId,
    kind: action.kind,
    src: action.src,
    playing: true,
  }
}
