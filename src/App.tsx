import { Component, type MouseEvent as ReactMouseEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import {
  EditorProvider,
  Preview,
  Timeline,
  createDefaultDemuxerFactory,
  framesToTimecode,
  playbackStore,
  usePlaybackStore,
  useTimelineEngine,
  useTracksStore,
  type InitialTrackConfig,
  type TimelineRef,
} from '@elah/editor'
import CommandBar from './CommandBar.tsx'
import MediaPanel from './MediaPanel.tsx'
import { applyOps, getTimeline, reconcileClipVaults, vaultIdForClip } from './host/applyOps.ts'
import { canExportMp4, exportErrorLine, exportMp4 } from './host/exportMp4.ts'
import { clipStatus } from './host/statusLine.ts'
import { listLibraryAssets, registerAssets, type LibraryAsset } from './host/library.ts'
import { ensureImported, importLocalFiles } from './host/media.ts'
import { placeAsset } from './host/place.ts'
import {
  clipRotationDegrees,
  commitClipRotation,
  measureClipForRotation,
  setClipRotation,
  wrapDegrees,
} from './host/rotate.ts'
import { FPS } from './host/types.ts'
import { commandErrorLine, commandStatusLine, findSimilar, loadLibrary, runCommand, similarErrorLine } from './sense/client.ts'

const demuxerFactory = createDefaultDemuxerFactory()

const INITIAL_TRACKS: InitialTrackConfig[] = [
  { kind: 'video', name: 'V1', protected: true },
  { kind: 'video', name: 'V2', protected: true },
  { kind: 'audio', name: 'A1', protected: true },
  { kind: 'elements', name: 'T1', protected: true },
]

const debug =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('debug') === '1'

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
  const clips = useTracksStore((state) => state.clips)
  const [library, setLibrary] = useState<LibraryAsset[]>([])
  const [libraryReady, setLibraryReady] = useState(false)
  const [results, setResults] = useState<LibraryAsset[] | null>(null)
  const [readyIds, setReadyIds] = useState<Map<string, string>>(() => new Map())
  const readyRef = useRef<Map<string, string>>(new Map())
  const [command, setCommand] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; clipId: string } | null>(null)
  useEffect(() => {
    let live = true
    void loadLibrary().then((items) => {
      if (!live) return
      registerAssets(items)
      setLibrary(items)
      setLibraryReady(true)
    })
    return () => {
      live = false
    }
  }, [])

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
      const result = await runCommand(text, getTimeline(engine), listLibraryAssets())
      if (result.hits.length > 0) setResults(result.hits)
      if (result.ops.length > 0) {
        setStatus('Editing…')
        await applyOps(engine, result.ops, result.opsLabel)
        fitTimeline()
      }
      setCommand('')
      setStatus(commandStatusLine(result))
    } catch (error) {
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
      const result = await findSimilar(vaultId, getTimeline(engine), listLibraryAssets())
      setResults(result.hits)
      setStatus(clipStatus(result.note) || 'Done')
    } catch (error) {
      setStatus(similarErrorLine(error))
    } finally {
      setBusy(false)
    }
  }

  const rotationSize = useRef<{ width: number; height: number } | undefined>(undefined)

  function closeMenu() {
    commitClipRotation(engine)
    setMenu(null)
  }

  function onPreviewRotation(clipId: string, degrees: number) {
    try {
      setClipRotation(engine, clipId, { absoluteDegrees: degrees }, rotationSize.current, { preview: true })
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
    rotationSize.current = undefined
    void measureClipForRotation(engine, clipId).then((size) => {
      rotationSize.current = size
    })
    setMenu({ x: event.clientX, y: event.clientY, clipId })
  }

  return (
    <div className="elah-root shell">
      <MediaPanel
        library={library}
        results={results}
        libraryReady={libraryReady}
        readyIds={readyIds}
        onPlace={(asset) => void onPlace(asset)}
        onPrepare={(asset) => void ensureImported(asset)}
        onUpload={(files) => void onUpload(files)}
      />
      <section className="stage" aria-label="Preview">
        <header className="stage-bar">
          <Transport />
          <div className="stage-actions">
            <HistoryButtons />
            <ExportButton onStatus={setStatus} />
          </div>
        </header>
        <div className="stage-canvas">
          <PreviewBoundary>
            <Preview demuxerFactory={demuxerFactory} enableAudio style={{ width: '100%', height: '100%' }} />
          </PreviewBoundary>
        </div>
      </section>
      <section className="timeline-pane" aria-label="Timeline" onContextMenuCapture={onTimelineContextMenu}>
        <Timeline ref={timelineRef} fps={FPS} sidebarWidth={188} style={{ height: 248 }} />
        {menu && (
          <ClipMenu
            x={menu.x}
            y={menu.y}
            degrees={clipRotationDegrees(engine, menu.clipId)}
            onClose={closeMenu}
            onFind={() => void onFindSimilar(menu.clipId)}
            onPreview={(degrees) => onPreviewRotation(menu.clipId, degrees)}
            onCommit={() => commitClipRotation(engine)}
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
        {isPlaying ? 'Pause' : 'Play'}
      </button>
      <span className="timecode">
        {framesToTimecode(currentFrame, FPS)} / {framesToTimecode(Math.max(totalFrames, 1), FPS)}
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
      <button type="button" className="btn" disabled={!canUndo} onClick={undo}>
        Undo
      </button>
      <button type="button" className="btn" disabled={!canRedo} onClick={() => engine.redo()}>
        Redo
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
    <button type="button" className="btn" disabled={busy} onClick={() => void onExport()}>
      Export
    </button>
  )
}

function ClipMenu({
  x,
  y,
  degrees,
  onClose,
  onFind,
  onPreview,
  onCommit,
}: {
  x: number
  y: number
  degrees: number
  onClose: () => void
  onFind: () => void
  onPreview: (degrees: number) => void
  onCommit: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [angle, setAngle] = useState(degrees)
  const [text, setText] = useState(formatDegrees(degrees))
  const commitRef = useRef(onCommit)

  useEffect(() => {
    commitRef.current = onCommit
  })

  useEffect(() => {
    return () => commitRef.current()
  }, [])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    function onPointer(event: PointerEvent) {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onPointer)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onPointer)
    }
  }, [onClose])

  function preview(next: number) {
    const wrapped = wrapDegrees(next)
    setAngle(wrapped)
    setText(formatDegrees(wrapped))
    onPreview(wrapped)
  }

  function settle(next: number) {
    if (!Number.isFinite(next)) {
      setText(formatDegrees(angle))
      return
    }
    preview(next)
    onCommit()
  }

  const left = Math.min(Math.max(8, x), window.innerWidth - 248)
  const top = Math.min(Math.max(8, y), window.innerHeight - 228)

  return (
    <div
      ref={ref}
      className="clip-menu"
      style={{ left, top }}
      role="dialog"
      aria-label="Clip"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="clip-rotate">
        <div className="clip-rotate-head">
          <label htmlFor="clip-angle">Angle</label>
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
            <button key={delta} type="button" onClick={() => settle(angle + delta)}>
              {delta > 0 ? `+${delta}` : delta}
            </button>
          ))}
        </div>
      </div>
      <button type="button" className="find-similar" onClick={onFind}>
        Find similar
      </button>
    </div>
  )
}

function formatDegrees(degrees: number): string {
  if (!Number.isFinite(degrees)) return '0'
  return String(Math.round(degrees * 10) / 10)
}

function DebugSnapshot() {
  const engine = useTimelineEngine()
  useTracksStore((state) => state.clips)
  useTracksStore((state) => state.tracks)
  return <pre className="debug-json">{JSON.stringify(getTimeline(engine), null, 2)}</pre>
}

function oneLine(error: unknown): string {
  return clipStatus(error instanceof Error ? error.message : String(error)) || 'That failed.'
}

class PreviewBoundary extends Component<{ children: ReactNode }, { message: string | null }> {
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
