import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Plus,
  Film,
  AudioLines,
  Image as ImageIcon,
  FolderOpen,
} from 'lucide-react'
import type { LibraryAsset, LibraryKind } from './host/library.ts'

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
  const hits = results && results.length > 0 ? results : null

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
          onPlace={onPlace}
          onPrepare={onPrepare}
          onDragAsset={onDragAsset}
          onDragAssetEnd={onDragAssetEnd}
        />
        {results !== null && (
          <ScrollingAssets
            className="media-search"
            label="Search"
            heading={
              <h2>
                Search <span>{hits?.length ?? 0} results</span>
              </h2>
            }
            items={hits ?? []}
            empty={hits ? null : <p className="quiet">No matches in the library.</p>}
            readyIds={readyIds}
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
  heading,
  items,
  empty,
  readyIds,
  onPlace,
  onPrepare,
  onDragAsset,
  onDragAssetEnd,
}: {
  className: string
  label: string
  heading: ReactNode
  items: readonly LibraryAsset[]
  empty: ReactNode
  readyIds: ReadonlyMap<string, string>
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
        nearIds={nearIds}
        watch={watch}
        readyIds={readyIds}
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
  nearIds,
  watch,
  readyIds,
  onPlace,
  onPrepare,
  onDragAsset,
  onDragAssetEnd,
}: {
  items: readonly LibraryAsset[]
  nearIds: ReadonlySet<string>
  watch: (vaultId: string, node: HTMLElement) => () => void
  readyIds: ReadonlyMap<string, string>
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
                  near={nearIds.has(item.vaultId)}
                  watch={watch}
                  assetId={readyIds.get(item.vaultId)}
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
  near,
  watch,
  assetId,
  onPlace,
  onPrepare,
  onDragAsset,
  onDragAssetEnd,
}: {
  item: LibraryAsset
  near: boolean
  watch: (vaultId: string, node: HTMLElement) => () => void
  assetId: string | undefined
  onPlace: (asset: LibraryAsset) => void
  onPrepare: (asset: LibraryAsset) => void
  onDragAsset: (data: DataTransfer, asset: LibraryAsset, assetId: string) => void
  onDragAssetEnd: (assetId: string) => void
}) {
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    return watch(item.vaultId, node)
  }, [item.vaultId, watch])
  useEffect(() => {
    if (near) onPrepare(item)
  }, [near, item, onPrepare])

  return (
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
      <Thumb item={item} active={near} />
      <span className="hit-copy">
        <span className="hit-name" title={item.name}>
          {item.name}
        </span>
        {item.durationSec !== null && (
          <span className="hit-meta">{formatDuration(item.durationSec)}</span>
        )}
      </span>
    </button>
  )
}

function Thumb({ item, active }: { item: LibraryAsset; active: boolean }) {
  if (item.kind === 'audio') {
    return (
      <span className="thumb thumb-audio" aria-hidden="true">
        <AudioLines size={30} strokeWidth={1} />
      </span>
    )
  }
  if (!active) return <span className="thumb" aria-hidden="true" />
  if (item.thumb) {
    return (
      <span className="thumb">
        <img src={item.thumb} alt="" />
      </span>
    )
  }
  if (item.kind === 'video') {
    return (
      <span className="thumb">
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
      </span>
    )
  }
  return (
    <span className="thumb">
      <img src={item.src} alt="" />
    </span>
  )
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(total / 60)
  const remain = total % 60
  return `${minutes}:${remain.toString().padStart(2, '0')}`
}
