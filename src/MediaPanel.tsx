import { memo, useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactNode } from 'react'
import {
  Plus,
  Film,
  AudioLines,
  Image as ImageIcon,
  FolderOpen,
  Pause,
  Play,
} from 'lucide-react'
import type { LibraryAsset, LibraryKind } from './host/library.ts'
import {
  playableKind,
  previewCardId,
  previewControlLabel,
  reduceSidebarPreview,
  type SidebarPreview,
  type SidebarPreviewKind,
  type SidebarPreviewScope,
} from './host/sidebarPreview.ts'

const KINDS: { kind: LibraryKind; label: string }[] = [
  { kind: 'video', label: 'Video' },
  { kind: 'audio', label: 'Audio' },
  { kind: 'image', label: 'Image' },
]

/** One row past the scrollport, so the next cards are ready without loading the list. */
const NEAR_ROOT_MARGIN = '120px 0px'

interface MediaPanelProps {
  library: readonly LibraryAsset[]
  results: readonly LibraryAsset[] | null
  readyIds: ReadonlyMap<string, string>
  onPlace: (asset: LibraryAsset) => void
  onPrepare: (asset: LibraryAsset) => void
  onDragAsset: (data: DataTransfer, asset: LibraryAsset, assetId: string) => void
  onDragAssetEnd: (assetId: string) => void
  onUpload: (files: File[]) => void
}

export default memo(function MediaPanel({
  library,
  results,
  readyIds,
  onPlace,
  onPrepare,
  onDragAsset,
  onDragAssetEnd,
  onUpload,
}: MediaPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [preview, dispatch] = useReducer(reduceSidebarPreview, null)
  const hits = results && results.length > 0 ? results : null
  const togglePreview = useCallback((item: LibraryAsset, scope: SidebarPreviewScope) => {
    const kind = playableKind(item.kind)
    if (!kind || !item.src) return
    dispatch({
      type: 'toggle',
      cardId: previewCardId(scope, item.vaultId),
      vaultId: item.vaultId,
      kind,
      src: item.src,
    })
  }, [])
  const stopPreview = useCallback(() => {
    dispatch({ type: 'stop' })
  }, [])
  const releasePreview = useCallback((cardId: string) => {
    dispatch({ type: 'release', cardId })
  }, [])

  useEffect(() => {
    if (!preview) return
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.repeat) return
      dispatch({ type: 'stop' })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [preview])

  return (
    <aside className="media" aria-label="Media">
      <div className="media-head">
        <div className="media-title">
          <h1>Media</h1>
          <span className="item-count">{library.length}</span>
          <FolderOpen size={14} aria-hidden="true" />
        </div>
        <button
          type="button"
          className="btn upload-btn"
          onClick={() => inputRef.current?.click()}
        >
          <Plus size={15} /> Import media
        </button>
        <input
          ref={inputRef}
          className="upload-input"
          type="file"
          multiple
          accept="video/*,audio/*,image/*,.mp4,.mov,.webm,.mkv,.m4v,.m4a,.mp3,.wav,.aac,.flac,.ogg,.jpg,.jpeg,.png,.webp,.gif"
          onChange={(event) => {
            const selected = Array.from(event.target.files ?? [])
            event.target.value = ''
            if (selected.length > 0) onUpload(selected)
          }}
        />
      </div>
      <div className="media-body">
        <ScrollingAssets
          className="media-library"
          label="Library"
          scope="library"
          heading={
            <h2>
              Library <span>All assets</span>
            </h2>
          }
          items={library}
          empty={
            library.length === 0 ? (
              <div className="media-empty">
                <FolderOpen size={25} strokeWidth={1} />
                <p>Your library is empty</p>
                <span>Import video, audio or images.</span>
              </div>
            ) : null
          }
          readyIds={readyIds}
          preview={preview}
          onTogglePreview={togglePreview}
          onStopPreview={stopPreview}
          onReleasePreview={releasePreview}
          onPlace={onPlace}
          onPrepare={onPrepare}
          onDragAsset={onDragAsset}
          onDragAssetEnd={onDragAssetEnd}
        />
        {results !== null && (
          <ScrollingAssets
            className="media-search"
            label="Search"
            scope="search"
            heading={
              <h2>
                Search <span>{hits?.length ?? 0} results</span>
              </h2>
            }
            items={hits ?? []}
            empty={hits ? null : <p className="quiet">No matches in the library.</p>}
            readyIds={readyIds}
            preview={preview}
            onTogglePreview={togglePreview}
            onStopPreview={stopPreview}
            onReleasePreview={releasePreview}
            onPlace={onPlace}
            onPrepare={onPrepare}
            onDragAsset={onDragAsset}
            onDragAssetEnd={onDragAssetEnd}
          />
        )}
      </div>
    </aside>
  )
})

function ScrollingAssets({
  className,
  label,
  scope,
  heading,
  items,
  empty,
  readyIds,
  preview,
  onTogglePreview,
  onStopPreview,
  onReleasePreview,
  onPlace,
  onPrepare,
  onDragAsset,
  onDragAssetEnd,
}: {
  className: string
  label: string
  scope: SidebarPreviewScope
  heading: ReactNode
  items: readonly LibraryAsset[]
  empty: ReactNode
  readyIds: ReadonlyMap<string, string>
  preview: SidebarPreview | null
  onTogglePreview: (asset: LibraryAsset, scope: SidebarPreviewScope) => void
  onStopPreview: () => void
  onReleasePreview: (cardId: string) => void
  onPlace: (asset: LibraryAsset) => void
  onPrepare: (asset: LibraryAsset) => void
  onDragAsset: (data: DataTransfer, asset: LibraryAsset, assetId: string) => void
  onDragAssetEnd: (assetId: string) => void
}) {
  const { rootRef, nearIds, watch } = useVisibleCards()
  return (
    <section ref={rootRef} className={className} aria-label={label}>
      {heading}
      {empty}
      <KindSections
        items={items}
        scope={scope}
        nearIds={nearIds}
        watch={watch}
        readyIds={readyIds}
        preview={preview}
        onTogglePreview={onTogglePreview}
        onStopPreview={onStopPreview}
        onReleasePreview={onReleasePreview}
        onPlace={onPlace}
        onPrepare={onPrepare}
        onDragAsset={onDragAsset}
        onDragAssetEnd={onDragAssetEnd}
      />
    </section>
  )
}

function useVisibleCards() {
  const rootRef = useRef<HTMLElement>(null)
  const nodesRef = useRef(new Map<string, HTMLElement>())
  const observerRef = useRef<IntersectionObserver | null>(null)
  const [nearIds, setNearIds] = useState<ReadonlySet<string>>(() => new Set())

  useEffect(() => {
    const root = rootRef.current
    if (!root || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        setNearIds((current) => {
          const next = new Set(current)
          let changed = false
          for (const entry of entries) {
            const id = entry.target.getAttribute('data-vault-id')
            if (!id) continue
            if (entry.isIntersecting) {
              if (!next.has(id)) {
                next.add(id)
                changed = true
              }
            } else if (next.delete(id)) {
              changed = true
            }
          }
          return changed ? next : current
        })
      },
      { root, rootMargin: NEAR_ROOT_MARGIN },
    )
    observerRef.current = observer
    for (const node of nodesRef.current.values()) observer.observe(node)
    return () => {
      observer.disconnect()
      observerRef.current = null
    }
  }, [])

  const watch = useCallback((vaultId: string, node: HTMLElement) => {
    const previous = nodesRef.current.get(vaultId)
    if (previous && previous !== node) observerRef.current?.unobserve(previous)
    nodesRef.current.set(vaultId, node)
    node.setAttribute('data-vault-id', vaultId)
    observerRef.current?.observe(node)
    return () => {
      if (nodesRef.current.get(vaultId) === node) nodesRef.current.delete(vaultId)
      observerRef.current?.unobserve(node)
    }
  }, [])

  return { rootRef, nearIds, watch }
}

function KindSections({
  items,
  scope,
  nearIds,
  watch,
  readyIds,
  preview,
  onTogglePreview,
  onStopPreview,
  onReleasePreview,
  onPlace,
  onPrepare,
  onDragAsset,
  onDragAssetEnd,
}: {
  items: readonly LibraryAsset[]
  scope: SidebarPreviewScope
  nearIds: ReadonlySet<string>
  watch: (vaultId: string, node: HTMLElement) => () => void
  readyIds: ReadonlyMap<string, string>
  preview: SidebarPreview | null
  onTogglePreview: (asset: LibraryAsset, scope: SidebarPreviewScope) => void
  onStopPreview: () => void
  onReleasePreview: (cardId: string) => void
  onPlace: (asset: LibraryAsset) => void
  onPrepare: (asset: LibraryAsset) => void
  onDragAsset: (data: DataTransfer, asset: LibraryAsset, assetId: string) => void
  onDragAssetEnd: (assetId: string) => void
}) {
  return (
    <>
      {KINDS.map((entry) => {
        const visible = items.filter((item) => item.kind === entry.kind)
        if (visible.length === 0) return null
        return (
          <div key={entry.kind} className="kind-block">
            <h3>
              {entry.kind === 'video' ? (
                <Film size={12} />
              ) : entry.kind === 'audio' ? (
                <AudioLines size={12} />
              ) : (
                <ImageIcon size={12} />
              )}
              {entry.label}
              <span>{visible.length}</span>
            </h3>
            <div className="kind-row">
              {visible.map((item) => (
                <HitCard
                  key={item.vaultId}
                  item={item}
                  scope={scope}
                  near={nearIds.has(item.vaultId)}
                  watch={watch}
                  assetId={readyIds.get(item.vaultId)}
                  preview={preview}
                  onTogglePreview={onTogglePreview}
                  onStopPreview={onStopPreview}
                  onReleasePreview={onReleasePreview}
                  onPlace={onPlace}
                  onPrepare={onPrepare}
                  onDragAsset={onDragAsset}
                  onDragAssetEnd={onDragAssetEnd}
                />
              ))}
            </div>
          </div>
        )
      })}
    </>
  )
}

function HitCard({
  item,
  scope,
  near,
  watch,
  assetId,
  preview,
  onTogglePreview,
  onStopPreview,
  onReleasePreview,
  onPlace,
  onPrepare,
  onDragAsset,
  onDragAssetEnd,
}: {
  item: LibraryAsset
  scope: SidebarPreviewScope
  near: boolean
  watch: (vaultId: string, node: HTMLElement) => () => void
  assetId: string | undefined
  preview: SidebarPreview | null
  onTogglePreview: (asset: LibraryAsset, scope: SidebarPreviewScope) => void
  onStopPreview: () => void
  onReleasePreview: (cardId: string) => void
  onPlace: (asset: LibraryAsset) => void
  onPrepare: (asset: LibraryAsset) => void
  onDragAsset: (data: DataTransfer, asset: LibraryAsset, assetId: string) => void
  onDragAssetEnd: (assetId: string) => void
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const cardId = previewCardId(scope, item.vaultId)
  const selected = preview?.cardId === cardId ? preview : null
  const liveVideo = selected?.kind === 'video'
  const kind = playableKind(item.kind)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    return watch(item.vaultId, node)
  }, [item.vaultId, watch])
  useEffect(() => {
    if (near) onPrepare(item)
  }, [near, item, onPrepare])
  useEffect(() => {
    return () => onReleasePreview(cardId)
  }, [cardId, onReleasePreview])

  return (
    <div className="hit-wrap">
      <button
        ref={ref}
        type="button"
        className="hit"
        data-vault-id={item.vaultId}
        draggable={assetId !== undefined}
        onPointerDown={() => onPrepare(item)}
        onFocus={() => onPrepare(item)}
        onClick={() => onPlace(item)}
        onDragStart={(event) => {
          if (!assetId) {
            event.preventDefault()
            return
          }
          onDragAsset(event.dataTransfer, item, assetId)
        }}
        onDragEnd={() => {
          if (assetId) onDragAssetEnd(assetId)
        }}
      >
        <Thumb
          item={item}
          active={near && !liveVideo}
          overlay={
            selected ? (
              <CardPreview
                kind={selected.kind}
                src={selected.src}
                playing={selected.playing}
                onStop={onStopPreview}
              />
            ) : null
          }
        />
        <span className="hit-copy">
          <span className="hit-name" title={item.name}>
            {item.name}
          </span>
          {item.durationSec !== null && (
            <span className="hit-meta">{formatDuration(item.durationSec)}</span>
          )}
        </span>
      </button>
      {kind && (
        <button
          type="button"
          className="hit-play"
          aria-label={previewControlLabel(item.name, selected?.playing === true)}
          aria-pressed={selected?.playing === true}
          disabled={!item.src}
          data-state={selected ? (selected.playing ? 'playing' : 'paused') : undefined}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onTogglePreview(item, scope)
          }}
        >
          {selected?.playing ? (
            <Pause size={11} fill="currentColor" aria-hidden="true" />
          ) : (
            <Play size={11} fill="currentColor" aria-hidden="true" />
          )}
        </button>
      )}
    </div>
  )
}

function CardPreview({
  kind,
  src,
  playing,
  onStop,
}: {
  kind: SidebarPreviewKind
  src: string
  playing: boolean
  onStop: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const barRef = useRef<HTMLSpanElement>(null)
  const onStopRef = useRef(onStop)
  useEffect(() => {
    onStopRef.current = onStop
  }, [onStop])

  useLayoutEffect(() => {
    const media = videoRef.current ?? audioRef.current
    if (!media) return
    if (!playing) {
      media.pause()
      return
    }
    let cancel = false
    if (kind === 'video') media.muted = false
    const giveUp = (error: unknown) => {
      if (cancel) return
      if (error instanceof DOMException && error.name === 'AbortError') return
      onStopRef.current()
    }
    void media.play().catch((error: unknown) => {
      if (cancel) return
      if (error instanceof DOMException && error.name === 'AbortError') return
      if (
        kind === 'video' &&
        error instanceof DOMException &&
        error.name === 'NotAllowedError' &&
        !media.muted
      ) {
        media.muted = true
        void media.play().catch(giveUp)
        return
      }
      giveUp(error)
    })
    return () => {
      cancel = true
    }
  }, [playing, src, kind])

  function endIfBroken(media: HTMLMediaElement) {
    if (!media.isConnected) return
    if (media.error?.code === MediaError.MEDIA_ERR_ABORTED) return
    onStopRef.current()
  }

  function paint(media: HTMLMediaElement) {
    const bar = barRef.current
    if (!bar) return
    const duration = media.duration
    const ratio = Number.isFinite(duration) && duration > 0 ? media.currentTime / duration : 0
    bar.style.transform = `scaleX(${Math.min(1, Math.max(0, ratio))})`
  }

  return (
    <>
      {kind === 'video' ? (
        <video
          ref={videoRef}
          className="thumb-live"
          src={src}
          playsInline
          preload="auto"
          onTimeUpdate={(event) => paint(event.currentTarget)}
          onLoadedMetadata={(event) => paint(event.currentTarget)}
          onEnded={() => onStopRef.current()}
          onError={(event) => endIfBroken(event.currentTarget)}
        />
      ) : (
        <audio
          ref={audioRef}
          className="sidebar-preview-audio"
          src={src}
          preload="auto"
          onTimeUpdate={(event) => paint(event.currentTarget)}
          onLoadedMetadata={(event) => paint(event.currentTarget)}
          onEnded={() => onStopRef.current()}
          onError={(event) => endIfBroken(event.currentTarget)}
        />
      )}
      <span className="hit-progress" aria-hidden="true">
        <span ref={barRef} />
      </span>
    </>
  )
}

function Thumb({
  item,
  active,
  overlay,
}: {
  item: LibraryAsset
  active: boolean
  overlay?: ReactNode
}) {
  const audio = item.kind === 'audio'
  let face: ReactNode = null
  if (audio) {
    face = <AudioLines size={30} strokeWidth={1} />
  } else if (active && item.thumb) {
    face = <img src={item.thumb} alt="" />
  } else if (active && item.kind === 'video') {
    face = (
      <video
        src={item.src}
        muted
        playsInline
        preload="metadata"
        onLoadedMetadata={(event) => {
          const video = event.currentTarget
          if (video.currentTime === 0) video.currentTime = 0.2
        }}
      />
    )
  } else if (active) {
    face = <img src={item.src} alt="" />
  }
  return (
    <span className={audio ? 'thumb thumb-audio' : 'thumb'} aria-hidden={audio || !active ? true : undefined}>
      {face}
      {overlay}
    </span>
  )
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(total / 60)
  const remain = total % 60
  return `${minutes}:${remain.toString().padStart(2, '0')}`
}
