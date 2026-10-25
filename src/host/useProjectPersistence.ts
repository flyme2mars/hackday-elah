import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { playbackStore, selectionStore, useTracksStore, type TimelineEngine } from '@elah/editor'
import { clearClipBindings } from './applyOps.ts'
import type { LibraryAsset } from './library.ts'
import { blankTimeline, collectProjectVaults, releaseMediaLibrary, restoreProject } from './projectRestore.ts'
import { buildSnapshot, libraryFromSnapshot, type ProjectSnapshot } from './projectSnapshot.ts'
import { browserKeyValue, clearProjectStorage, readStoredSnapshot, writeStoredSnapshot } from './projectStorage.ts'
import { clipStatus } from './statusLine.ts'

const SAVE_DELAY_MS = 300

export function readBootSnapshot(): ProjectSnapshot | null {
  return readStoredSnapshot(browserKeyValue())
}

export function useProjectPersistence(
  engine: TimelineEngine,
  boot: ProjectSnapshot | null,
  onStatus: (status: string) => void,
) {
  const [library, setLibraryState] = useState<LibraryAsset[]>(() => libraryFromSnapshot(boot))
  const [name, setName] = useState(boot?.name ?? 'Untitled')
  const [ready, setReady] = useState(false)
  const libraryRef = useRef(library)
  const nameRef = useRef(name)
  const holdRef = useRef(true)
  const sessionRef = useRef(0)
  const cancelSaveRef = useRef<() => void>(() => {})
  const quotaNoted = useRef(false)
  libraryRef.current = library
  nameRef.current = name

  const setLibrary = useCallback((value: LibraryAsset[] | ((current: LibraryAsset[]) => LibraryAsset[])) => {
    setLibraryState((current) => {
      const next = typeof value === 'function' ? value(current) : value
      libraryRef.current = next
      return next
    })
  }, [])

  const generation = useCallback(() => sessionRef.current, [])

  useEffect(() => {
    const session = sessionRef.current
    let cancel = false
    void (async () => {
      if (!boot) {
        if (cancel || sessionRef.current !== session) return
        holdRef.current = false
        setReady(true)
        return
      }
      const restored = await restoreProject(
        engine,
        boot,
        () => !cancel && sessionRef.current === session,
      )
      if (cancel || sessionRef.current !== session) return
      if (!restored) {
        blankTimeline(engine)
        releaseMediaLibrary()
        libraryRef.current = []
        setLibraryState([])
        await clearProjectStorage()
        if (cancel || sessionRef.current !== session) return
        onStatus('Saved project could not be opened.')
      } else {
        libraryRef.current = restored.library
        setLibraryState(restored.library)
        setName(restored.name)
        const playback = playbackStore.getState()
        playback.pause()
        playback.setCurrentFrame(restored.playheadFrame)
        if (restored.note) onStatus(clipStatus(restored.note))
      }
      holdRef.current = false
      setReady(true)
    })()
    return () => {
      cancel = true
    }
  }, [boot, engine, onStatus])

  useEffect(() => {
    if (!ready) return
    let timer = 0
    const write = () => {
      if (holdRef.current) return
      let snapshot: ProjectSnapshot
      try {
        snapshot = buildSnapshot({
          name: nameRef.current,
          playheadFrame: playbackStore.getState().currentFrame,
          library: libraryRef.current,
          clipVaults: collectProjectVaults(engine),
          project: engine.getProject(),
        })
      } catch {
        return
      }
      if (writeStoredSnapshot(browserKeyValue(), snapshot)) return
      if (quotaNoted.current) return
      quotaNoted.current = true
      onStatus('Could not save this project in this browser.')
    }
    const schedule = () => {
      if (holdRef.current) return
      window.clearTimeout(timer)
      timer = window.setTimeout(write, SAVE_DELAY_MS)
    }
    cancelSaveRef.current = () => {
      window.clearTimeout(timer)
      timer = 0
    }
    const unsubscribeTracks = useTracksStore.subscribe(schedule)
    const unsubscribePlayback = playbackStore.subscribe((state, prev) => {
      if (state.currentFrame === prev.currentFrame) return
      schedule()
    })
    const flush = () => {
      window.clearTimeout(timer)
      write()
    }
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onHide)
    schedule()
    return () => {
      window.clearTimeout(timer)
      unsubscribeTracks()
      unsubscribePlayback()
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onHide)
      cancelSaveRef.current = () => {}
    }
  }, [ready, library, name, engine, onStatus])

  const reset = useCallback(async () => {
    sessionRef.current += 1
    holdRef.current = true
    setReady(false)
    cancelSaveRef.current()
    releaseMediaLibrary()
    clearClipBindings()
    blankTimeline(engine)
    selectionStore.getState().clearSelection()
    const playback = playbackStore.getState()
    playback.pause()
    playback.setCurrentFrame(0)
    libraryRef.current = []
    nameRef.current = 'Untitled'
    setLibraryState([])
    setName('Untitled')
    await clearProjectStorage()
    holdRef.current = false
    setReady(true)
  }, [engine])

  return useMemo(
    () => ({ library, setLibrary, name, ready, generation, reset }),
    [library, setLibrary, name, ready, generation, reset],
  )
}
