import {
  Component,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  EditorProvider,
  Preview,
  Timeline,
  createDefaultDemuxerFactory,
  framesToTimecode,
  playbackStore,
  selectionStore,
  usePlaybackStore,
  useSelectionStore,
  useTimelineEngine,
  useTracksStore,
  type InitialTrackConfig,
  type TimelineRef,
} from '@elah/editor'
import {
  Scissors,
  ArrowUpRight,
  Play,
  Pause,
  Undo2,
  Redo2,
  Maximize2,
  Minus,
  Plus,
  X,
  SlidersHorizontal,
  Search,
  RotateCcw,
} from 'lucide-react'
import FloatingPanel, { type PanelAnchor } from './FloatingPanel.tsx'
import TransitionPanel from './TransitionPanel.tsx'
import { getSelectedClipIds } from './host/selection.ts'
import { usePreviewOverlayBounds } from './host/usePreviewOverlayBounds.ts'
import CommandBar from './CommandBar.tsx'
import MediaPanel from './MediaPanel.tsx'
import {
  applyOps,
  getTimeline,
  reconcileClipVaults,
  selectedPlannerClipIds,
  vaultIdForClip,
} from './host/applyOps.ts'
import { canExportMp4, exportErrorLine, exportMp4 } from './host/exportMp4.ts'
import { clipStatus } from './host/statusLine.ts'
import {
  listLibraryAssets,
  mergeLibraryAssets,
  type LibraryAsset,
} from './host/library.ts'
import { ensureImported, importLocalFiles } from './host/media.ts'
import { placeAsset } from './host/place.ts'
import {
  clipRotationDegrees,
  commitClipRotation,
  measureClipForRotation,
  setClipRotation,
  setClipTransform,
  wrapDegrees,
} from './host/rotate.ts'
import { timelineShortcut } from './host/shortcuts.ts'
import { FPS } from './host/types.ts'
import {
  commandErrorLine,
  commandStatusLine,
  findSimilar,
  runCommand,
  similarErrorLine,
} from './sense/client.ts'

const demuxerFactory = createDefaultDemuxerFactory()

const INITIAL_TRACKS: InitialTrackConfig[] = [
  { kind: 'video', name: 'V1', protected: true },
  { kind: 'video', name: 'V2', protected: true },
  { kind: 'audio', name: 'A1', protected: true },
  { kind: 'elements', name: 'T1', protected: true },
]

const debug =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('debug') === '1'

export default function App() {
  return (
    <EditorProvider
      fps={FPS}
      stage={{ width: 1080, height: 1920 }}
      defaultTrackHeight={48}
      initialTracks={INITIAL_TRACKS}
    >
      <EditorShell />
    </EditorProvider>
  )
}

function EditorShell() {
  const engine = useTimelineEngine()
  const timelineRef = useRef<TimelineRef>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  usePreviewOverlayBounds(previewRef)
  const clips = useTracksStore((state) => state.clips)
  const [library, setLibrary] = useState<LibraryAsset[]>([])
  const [results, setResults] = useState<LibraryAsset[] | null>(null)
  const [readyIds, setReadyIds] = useState<Map<string, string>>(() => new Map())
  const readyRef = useRef<Map<string, string>>(new Map())
  const [command, setCommand] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [menu, setMenu] = useState<{
    anchor: PanelAnchor
    clipId: string
  } | null>(null)
  const [transitionMenu, setTransitionMenu] = useState<{
    anchor: PanelAnchor
    fromId: string
    toId: string
  } | null>(null)
  useSelectionStore((state) => state.selectedClipIds)
  const totalFrames = useTracksStore((state) => state.totalFrames)
  const selectedIds = getSelectedClipIds(engine)
  const selectedCount = selectedIds.length
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => timelineShortcut(engine, event)
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [engine])
  useEffect(() => {
    reconcileClipVaults(engine)
  }, [clips, engine])

  useEffect(() => {
    if (status !== 'Done') return
    const timer = window.setTimeout(() => setStatus(''), 2000)
    return () => window.clearTimeout(timer)
  }, [status])

  useEffect(() => {
    let cancel = false
    const queue = results ? [...library, ...results] : library
    for (const item of queue) {
      if (readyRef.current.has(item.vaultId)) continue
      void ensureImported(item)
        .then((assetId) => {
          if (cancel) return
          readyRef.current.set(item.vaultId, assetId)
          setReadyIds(new Map(readyRef.current))
        })
        .catch(() => {
          // Drag waits until the file imports. Click reports the error itself.
        })
    }
    return () => {
      cancel = true
    }
  }, [library, results])

  async function onUpload(files: readonly File[]) {
    closeMenu()
    setBusy(true)
    try {
      const added = await importLocalFiles(files)
      if (added.length === 0) {
        setStatus('Nothing new to add.')
        return
      }
      setLibrary((current) => {
        const ids = new Set(added.map((item) => item.vaultId))
        return [...added, ...current.filter((item) => !ids.has(item.vaultId))]
      })
      setStatus('Done')
    } catch (error) {
      setStatus(oneLine(error))
    } finally {
      setBusy(false)
    }
  }

  function fitTimeline() {
    requestAnimationFrame(() => timelineRef.current?.fitToWindow())
  }

  async function onPlace(asset: LibraryAsset) {
    closeMenu()
    setBusy(true)
    try {
      await placeAsset(engine, asset)
      setLibrary((current) => mergeLibraryAssets(current, [asset]))
      fitTimeline()
      setStatus('Done')
    } catch (error) {
      setStatus(oneLine(error))
    } finally {
      setBusy(false)
    }
  }

  async function onSubmit() {
    const text = command.trim()
    if (!text || busy) return
    closeMenu()
    setBusy(true)
    setStatus('Searching…')
    try {
      const before = getTimeline(engine)
      const selected = selectedPlannerClipIds(before, getSelectedClipIds(engine))
      const result = await runCommand(text, before, listLibraryAssets(), selected)
      if (result.ops.length > 0) {
        setStatus('Editing…')
        await applyOps(engine, result.ops, result.opsLabel)
        const hitsById = new Map(result.hits.map((hit) => [hit.vaultId, hit]))
        const placed: LibraryAsset[] = []
        for (const op of result.ops) {
          if (op.op !== 'add_clip') continue
          const hit = hitsById.get(op.vault_id)
          if (hit) placed.push(hit)
        }
        if (placed.length > 0) {
          setLibrary((current) => mergeLibraryAssets(current, placed))
        }
        fitTimeline()
      }
      setResults(result.hits.length > 0 ? result.hits : null)
      setCommand('')
      const removedTitle = result.ops.some(
        (op) =>
          op.op === 'remove' &&
          before.tracks.some((track) =>
            track.clips.some(
              (clip) =>
                clip.type === 'text' &&
                (clip.id === op.clip_id || clip.alias === op.clip_id),
            ),
          ),
      )
      const titleStatus = result.ops.some((op) => op.op === 'add_text')
        ? 'Title added.'
        : result.ops.some((op) => op.op === 'update_text')
          ? 'Title updated.'
          : removedTitle
            ? 'Title removed.'
            : ''
      setStatus(
        commandStatusLine({
          ...result,
          note: [titleStatus, result.note].filter(Boolean).join(' '),
        }),
      )
    } catch (error) {
      setResults(null)
      setStatus(commandErrorLine(error))
    } finally {
      setBusy(false)
    }
  }

  async function onFindSimilar(clipId: string) {
    closeMenu()
    reconcileClipVaults(engine)
    const vaultId = vaultIdForClip(engine, clipId)
    if (!vaultId) {
      setStatus('This clip has no library id.')
      return
    }
    setBusy(true)
    setStatus('Searching…')
    try {
      const result = await findSimilar(
        vaultId,
        getTimeline(engine),
        listLibraryAssets(),
      )
      setResults(result.hits)
      setStatus(clipStatus(result.note) || 'Done')
    } catch (error) {
      setStatus(similarErrorLine(error))
    } finally {
      setBusy(false)
    }
  }

  const rotationSize = useRef<{ width: number; height: number } | undefined>(
    undefined,
  )

  function closeMenu() {
    commitClipRotation(engine)
    setMenu(null)
    setTransitionMenu(null)
  }

  function onPreviewRotation(clipId: string, degrees: number) {
    try {
      setClipRotation(
        engine,
        clipId,
        { absoluteDegrees: degrees },
        rotationSize.current,
        { preview: true },
      )
    } catch (error) {
      setStatus(oneLine(error))
    }
  }

  function onPreviewScale(clipId: string, scale: number) {
    try {
      setClipTransform(engine, clipId, { scale }, undefined, { preview: true })
    } catch (error) {
      setStatus(oneLine(error))
    }
  }

  function onTimelineContextMenu(event: ReactMouseEvent) {
    const target = event.target
    if (!(target instanceof Element)) return
    const block = target.closest('[data-clip-id]')
    if (!block) return
    event.preventDefault()
    event.stopPropagation()
    const clipId = block.getAttribute('data-clip-id')
    if (!clipId) return
    if (!selectionStore.getState().selectedClipIds.has(clipId))
      selectionStore.getState().selectClip(clipId)
    setTransitionMenu(null)
    rotationSize.current = undefined
    void measureClipForRotation(engine, clipId).then((size) => {
      rotationSize.current = size
    })
    setMenu({
      anchor: { x: event.clientX, y: event.clientY, element: block },
      clipId,
    })
  }

  function onSelectCapture(event: React.PointerEvent) {
    if (
      event.button !== 0 ||
      !(event.shiftKey || event.metaKey || event.ctrlKey)
    )
      return
    const target = event.target as Element
    const block = target.closest('[data-clip-id]')
    const id = block?.getAttribute('data-clip-id')
    if (!id) return
    event.preventDefault()
    event.stopPropagation()
    selectionStore.getState().toggleClipSelection(id)
  }

  function onTransitionClick(event: ReactMouseEvent) {
    const target = event.target as Element
    const trigger = target.closest<HTMLElement>(
      '[title="Add transition"], [title$="click to change"]',
    )
    if (!trigger) return
    const lane = trigger.closest('[data-track-id]')
    const trackId = lane?.getAttribute('data-track-id')
    if (!trackId) return
    event.preventDefault()
    event.stopPropagation()
    const cutX =
      trigger.getBoundingClientRect().left +
      trigger.getBoundingClientRect().width / 2
    const rowClips = engine
      .getClipsOnTrack(trackId)
      .slice()
      .sort((a, b) => a.startFrame - b.startFrame)
    const to = rowClips.find((clip) => {
      const block = [
        ...(lane?.querySelectorAll<HTMLElement>('[data-clip-id]') ?? []),
      ].find((node) => node.dataset.clipId === clip.id)
      return block && Math.abs(block.getBoundingClientRect().left - cutX) < 3
    })
    const from =
      to &&
      rowClips.find(
        (clip) => clip.startFrame + clip.durationFrames === to.startFrame,
      )
    if (!from || !to || from.type !== 'video' || to.type !== 'video') return
    closeMenu()
    setTransitionMenu({
      fromId: from.id,
      toId: to.id,
      anchor: {
        x: cutX,
        y: trigger.getBoundingClientRect().top,
        element: trigger,
      },
    })
  }

  return (
    <div
      className="elah-root shell"
      onKeyDown={(event) => {
        // Preserve native control keys before Elah's global timeline listener.
        if (
          event.target instanceof HTMLElement &&
          event.target.closest(
            'input, textarea, select, button, a, [contenteditable]',
          )
        ) {
          event.stopPropagation()
        }
      }}
    >
      <header className="app-bar">
        <div className="brand">
          <span className="brand-mark">
            <Scissors size={17} strokeWidth={1.5} />
          </span>
          <span>Frame Flow</span>
        </div>
        <div className="project-name">
          <span className="project-dot" />
          Untitled
        </div>
        <div className="app-actions">
          <span className="project-format">
            1080 × 1920 <span> / </span> 30 FPS
          </span>
          <ExportButton onStatus={setStatus} />
        </div>
      </header>
      <MediaPanel
        library={library}
        results={results}
        readyIds={readyIds}
        onPlace={(asset) => void onPlace(asset)}
        onPrepare={(asset) => void ensureImported(asset)}
        onUpload={(files) => void onUpload(files)}
      />
      <section className="stage" aria-label="Preview" tabIndex={0}>
        <header className="stage-bar">
          <h2>Preview</h2>
          <span className="stage-fit">
            Fit <span>·</span> 9:16
          </span>
        </header>
        <div ref={previewRef} className="stage-canvas">
          <PreviewBoundary>
            <Preview
              demuxerFactory={demuxerFactory}
              enableAudio
              style={{ width: '100%', height: '100%' }}
            />
          </PreviewBoundary>
          {totalFrames === 0 && (
            <div className="stage-empty">
              <span className="empty-frame">
                <Play size={24} strokeWidth={1} />
              </span>
              <h3>Your next cut starts here</h3>
              <p>Add media to the timeline to begin.</p>
            </div>
          )}
        </div>
        <div className="preview-transport">
          <span className="transport-format">SEQUENCE</span>
          <Transport />
          <span className="transport-format">
            {totalFrames > 0 ? `${(totalFrames / FPS).toFixed(1)}s` : '0.0s'}
          </span>
        </div>
      </section>
      <section
        className="timeline-pane"
        aria-label="Timeline"
        tabIndex={0}
        onContextMenuCapture={onTimelineContextMenu}
        onPointerDownCapture={onSelectCapture}
        onClickCapture={onTransitionClick}
        onDoubleClickCapture={(event) => {
          if (!(event.target as Element).closest('[data-clip-id]')) return
          onTimelineContextMenu(event)
        }}
      >
        <div className="timeline-toolbar">
          <div className="timeline-title">
            <h2>Timeline</h2>
            <span className="timeline-separator" />
            <span
              className="selection-summary"
              aria-live="polite"
              data-selection-ids={JSON.stringify([...selectedIds])}
            >
              {selectedCount > 0
                ? `${selectedCount} ${selectedCount === 1 ? 'clip' : 'clips'} selected`
                : `${FPS} fps`}
            </span>
            {selectedCount > 0 && (
              <button
                className="icon-btn"
                aria-label="Clear selection"
                onClick={() => selectionStore.getState().clearSelection()}
              >
                <X size={12} />
              </button>
            )}
          </div>
          <div className="timeline-tools">
            <HistoryButtons />
            <span className="timeline-separator" />
            <button
              className="icon-btn"
              aria-label="Zoom out"
              onClick={() =>
                timelineRef.current?.zoomAtAnchor(
                  playbackStore.getState().zoom / 1.3,
                )
              }
            >
              <Minus size={14} />
            </button>
            <button
              className="icon-btn"
              aria-label="Zoom in"
              onClick={() =>
                timelineRef.current?.zoomAtAnchor(
                  playbackStore.getState().zoom * 1.3,
                )
              }
            >
              <Plus size={14} />
            </button>
            <button
              className="icon-btn"
              aria-label="Fit timeline"
              onClick={fitTimeline}
            >
              <Maximize2 size={14} />
            </button>
          </div>
        </div>
        <div className="timeline-editor">
          <Timeline
            ref={timelineRef}
            fps={FPS}
            sidebarWidth={132}
            style={{ height: '100%' }}
            classNames={{ clip: 'studio-clip', root: 'studio-timeline' }}
          />
        </div>
        {menu && (
          <ClipMenu
            anchor={menu.anchor}
            name={engine.findClip(menu.clipId)?.clip.name ?? 'Clip'}
            degrees={clipRotationDegrees(engine, menu.clipId)}
            scale={engine.findClip(menu.clipId)?.clip.transform?.scale ?? 1}
            onClose={closeMenu}
            onFind={() => void onFindSimilar(menu.clipId)}
            onPreview={(degrees) => onPreviewRotation(menu.clipId, degrees)}
            onPreviewScale={(scale) => onPreviewScale(menu.clipId, scale)}
            onCommit={() => commitClipRotation(engine)}
          />
        )}
        {transitionMenu && (
          <TransitionPanel
            engine={engine}
            {...transitionMenu}
            onClose={() => setTransitionMenu(null)}
            onStatus={setStatus}
          />
        )}
      </section>
      <CommandBar
        value={command}
        busy={busy}
        status={status}
        onChange={setCommand}
        onSubmit={() => void onSubmit()}
      />
      {debug && <DebugSnapshot />}
    </div>
  )
}

function Transport() {
  const isPlaying = usePlaybackStore((state) => state.isPlaying)
  const currentFrame = usePlaybackStore((state) => state.currentFrame)
  const toggle = usePlaybackStore((state) => state.togglePlayPause)
  const totalFrames = useTracksStore((state) => state.totalFrames)

  return (
    <div className="transport">
      <button type="button" className="btn" onClick={toggle}>
        {isPlaying ? (
          <Pause size={14} fill="currentColor" />
        ) : (
          <Play size={14} fill="currentColor" />
        )}
        <span className="sr-only">{isPlaying ? 'Pause' : 'Play'}</span>
      </button>
      <span className="timecode">
        {framesToTimecode(currentFrame, FPS)} /{' '}
        {framesToTimecode(Math.max(totalFrames, 1), FPS)}
      </span>
    </div>
  )
}

function HistoryButtons() {
  const engine = useTimelineEngine()
  const canUndo = useTracksStore((state) => state.canUndo)
  const canRedo = useTracksStore((state) => state.canRedo)

  function undo() {
    engine.undo()
    if (engine.getTotalFrames() === 0) {
      const playback = playbackStore.getState()
      playback.pause()
      playback.setCurrentFrame(0)
    }
  }

  return (
    <>
      <button
        type="button"
        className="icon-btn"
        aria-label="Undo"
        title="Undo"
        disabled={!canUndo}
        onClick={undo}
      >
        <Undo2 size={15} />
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label="Redo"
        title="Redo"
        disabled={!canRedo}
        onClick={() => engine.redo()}
      >
        <Redo2 size={15} />
      </button>
    </>
  )
}

function ExportButton({ onStatus }: { onStatus: (status: string) => void }) {
  const engine = useTimelineEngine()
  const [busy, setBusy] = useState(false)

  async function onExport() {
    setBusy(true)
    try {
      if (!canExportMp4() || engine.getTotalFrames() < 1) {
        await exportMp4(engine)
        return
      }
      onStatus('Exporting…')
      await exportMp4(engine, {
        onProgress: (percent) => onStatus(`Exporting ${percent}%`),
      })
      onStatus('Saved edit.mp4.')
    } catch (error) {
      onStatus(exportErrorLine(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      className="btn export-btn"
      disabled={busy}
      onClick={() => void onExport()}
    >
      {busy ? 'Exporting…' : 'Export'} <ArrowUpRight size={14} />
    </button>
  )
}

function ClipMenu({
  anchor,
  name,
  degrees,
  scale,
  onClose,
  onFind,
  onPreview,
  onPreviewScale,
  onCommit,
}: {
  anchor: PanelAnchor
  name: string
  degrees: number
  scale: number
  onClose: () => void
  onFind: () => void
  onPreview: (degrees: number) => void
  onPreviewScale: (scale: number) => void
  onCommit: () => void
}) {
  const [angle, setAngle] = useState(degrees)
  const [text, setText] = useState(formatDegrees(degrees))
  const [scaleText, setScaleText] = useState(formatScale(scale))
  const commitRef = useRef(onCommit)

  useEffect(() => {
    commitRef.current = onCommit
  })

  useEffect(() => {
    return () => commitRef.current()
  }, [])

  function preview(next: number) {
    const wrapped = wrapDegrees(next)
    setAngle(wrapped)
    setText(formatDegrees(wrapped))
    onPreview(wrapped)
  }

  function settleScale() {
    const parsed = Number(scaleText)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setScaleText(formatScale(scale))
      return
    }
    setScaleText(formatScale(parsed))
    onPreviewScale(parsed)
    onCommit()
  }

  function settle(next: number) {
    if (!Number.isFinite(next)) {
      setText(formatDegrees(angle))
      return
    }
    preview(next)
    onCommit()
  }

  return (
    <FloatingPanel anchor={anchor} label="Clip" onClose={onClose}>
      <div className="panel-heading">
        <span>
          <SlidersHorizontal size={14} />
          <span className="panel-clip-name">{name}</span>
        </span>
        <button
          className="icon-btn"
          aria-label="Close clip controls"
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </div>
      <div className="panel-section-label">TRANSFORM</div>
      <div className="clip-rotate">
        <div className="clip-rotate-head">
          <label htmlFor="clip-angle">
            <RotateCcw size={13} /> Rotation
          </label>
          <input
            id="clip-angle"
            type="number"
            inputMode="decimal"
            step={1}
            value={text}
            aria-label="Angle in degrees"
            onChange={(event) => {
              const value = event.target.value
              setText(value)
              const parsed = Number(value)
              if (value.trim() === '' || !Number.isFinite(parsed)) return
              setAngle(wrapDegrees(parsed))
              onPreview(parsed)
            }}
            onBlur={() => settle(Number(text))}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                settle(Number(text))
              }
            }}
          />
        </div>
        <input
          type="range"
          min={-180}
          max={180}
          step={1}
          value={angle}
          aria-label="Angle"
          onChange={(event) => preview(Number(event.target.value))}
          onPointerUp={() => onCommit()}
          onKeyUp={() => onCommit()}
          onBlur={() => onCommit()}
        />
        <div className="clip-nudges">
          {[-15, -5, -1, 1, 5, 15].map((delta) => (
            <button
              key={delta}
              type="button"
              onClick={() => settle(angle + delta)}
            >
              {delta > 0 ? `+${delta}` : delta}
            </button>
          ))}
        </div>
        <div className="clip-rotate-head">
          <label htmlFor="clip-scale">Scale</label>
          <input
            id="clip-scale"
            type="number"
            inputMode="decimal"
            min={0.01}
            step={0.1}
            value={scaleText}
            aria-label="Scale"
            onChange={(event) => {
              const value = event.target.value
              setScaleText(value)
              const parsed = Number(value)
              if (value.trim() === '' || !Number.isFinite(parsed) || parsed <= 0) return
              onPreviewScale(parsed)
            }}
            onBlur={() => settleScale()}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              settleScale()
            }}
          />
        </div>
      </div>
      <button
        type="button"
        className="panel-action find-similar"
        onClick={onFind}
      >
        <Search size={14} /> Find similar <ArrowUpRight size={13} />
      </button>
    </FloatingPanel>
  )
}

function formatDegrees(degrees: number): string {
  if (!Number.isFinite(degrees)) return '0'
  return String(Math.round(degrees * 10) / 10)
}

function formatScale(scale: number): string {
  if (!Number.isFinite(scale) || scale <= 0) return '1'
  return String(Math.round(scale * 100) / 100)
}

function DebugSnapshot() {
  const engine = useTimelineEngine()
  useTracksStore((state) => state.clips)
  useTracksStore((state) => state.tracks)
  return (
    <pre className="debug-json">
      {JSON.stringify(getTimeline(engine), null, 2)}
    </pre>
  )
}

function oneLine(error: unknown): string {
  return (
    clipStatus(error instanceof Error ? error.message : String(error)) ||
    'That failed.'
  )
}

class PreviewBoundary extends Component<
  { children: ReactNode },
  { message: string | null }
> {
  state = { message: null as string | null }

  static getDerivedStateFromError(error: Error) {
    return { message: error.message }
  }

  render() {
    if (this.state.message) {
      return (
        <div className="preview-error">
          <strong>Preview stopped.</strong>
          <p>{this.state.message}</p>
          <p>The timeline is still the project.</p>
        </div>
      )
    }
    return this.props.children
  }
}
