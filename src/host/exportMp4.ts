import { lazyExportVideo, playbackStore, type TimelineEngine } from '@elah/editor'
import { EXPORT_EMPTY, EXPORT_UNSUPPORTED, exportErrorLine } from './statusLine.ts'

export function canExportMp4(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof OffscreenCanvas !== 'undefined'
}

export { exportErrorLine } from './statusLine.ts'

export async function exportMp4(
  engine: TimelineEngine,
  options: {
    signal?: AbortSignal
    onProgress?: (percent: number) => void
  } = {},
): Promise<void> {
  if (!canExportMp4()) throw new Error(EXPORT_UNSUPPORTED)
  if (engine.getTotalFrames() < 1) throw new Error(EXPORT_EMPTY)

  playbackStore.getState().pause()
  let blob: Blob
  try {
    blob = await lazyExportVideo(engine.getProject(), {
      videoCodec: 'avc',
      audioCodec: 'aac',
      videoBitrate: 6_000_000,
      audioBitrate: 128_000,
      // Short edge. A 1080×1920 stage becomes 720×1280.
      outputHeight: 720,
      signal: options.signal,
      onProgress: ({ frame, totalFrames }) => {
        if (totalFrames <= 0) return
        options.onProgress?.(Math.round((frame / totalFrames) * 100))
      },
    })
  } catch (error) {
    throw new Error(exportErrorLine(error))
  }
  if (blob.size < 1) {
    throw new Error('Export failed. The encoder returned an empty file.')
  }

  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'edit.mp4'
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
