import { useRef } from 'react'
import {
  Plus,
  Film,
  AudioLines,
  Image as ImageIcon,
  FolderOpen,
} from 'lucide-react'
import type { LibraryAsset, LibraryKind } from './host/library.ts'
import { writeMediaDrag } from './host/media.ts'

const KINDS: { kind: LibraryKind; label: string }[] = [
  { kind: 'video', label: 'Video' },
  { kind: 'audio', label: 'Audio' },
  { kind: 'image', label: 'Image' },
]

interface MediaPanelProps {
  library: readonly LibraryAsset[]
  results: readonly LibraryAsset[] | null
  readyIds: ReadonlyMap<string, string>
  onPlace: (asset: LibraryAsset) => void
  onPrepare: (asset: LibraryAsset) => void
  onUpload: (files: File[]) => void
}

export default function MediaPanel({
  library,
  results,
  readyIds,
  onPlace,
  onPrepare,
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
        <section className="media-library" aria-label="Library">
          <h2>
            Library <span>All assets</span>
          </h2>
          {library.length === 0 && (
            <div className="media-empty">
              <FolderOpen size={25} strokeWidth={1} />
              <p>Your library is empty</p>
              <span>Import video, audio or images.</span>
            </div>
          )}
          <KindSections
            items={library}
            readyIds={readyIds}
            onPlace={onPlace}
            onPrepare={onPrepare}
          />
        </section>
        {results !== null && (
          <section className="media-search" aria-label="Search">
            <h2>
              Search <span>{hits?.length ?? 0} results</span>
            </h2>
            {hits ? (
              <KindSections
                items={hits}
                readyIds={readyIds}
                onPlace={onPlace}
                onPrepare={onPrepare}
              />
            ) : (
              <p className="quiet">No matches in the library.</p>
            )}
          </section>
        )}
      </div>
    </aside>
  )
}

function KindSections({
  items,
  readyIds,
  onPlace,
  onPrepare,
}: {
  items: readonly LibraryAsset[]
  readyIds: ReadonlyMap<string, string>
  onPlace: (asset: LibraryAsset) => void
  onPrepare: (asset: LibraryAsset) => void
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
                <button
                  key={item.vaultId}
                  type="button"
                  className="hit"
                  draggable={readyIds.has(item.vaultId)}
                  onPointerDown={() => onPrepare(item)}
                  onClick={() => onPlace(item)}
                  onDragStart={(event) => {
                    const assetId = readyIds.get(item.vaultId)
                    if (!assetId) {
                      event.preventDefault()
                      return
                    }
                    writeMediaDrag(event.dataTransfer, item, assetId)
                  }}
                >
                  <Thumb item={item} />
                  <span className="hit-copy">
                    <span className="hit-name" title={item.name}>
                      {item.name}
                    </span>
                    {item.durationSec !== null && (
                      <span className="hit-meta">
                        {formatDuration(item.durationSec)}
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )
      })}
    </>
  )
}

function Thumb({ item }: { item: LibraryAsset }) {
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
  if (item.kind === 'image') {
    return (
      <span className="thumb">
        <img src={item.src} alt="" />
      </span>
    )
  }
  return (
    <span className="thumb thumb-audio" aria-hidden="true">
      <AudioLines size={30} strokeWidth={1} />
    </span>
  )
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(total / 60)
  const remain = total % 60
  return `${minutes}:${remain.toString().padStart(2, '0')}`
}
