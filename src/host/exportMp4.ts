import { lazyExportVideo, playbackStore, type TimelineEngine } from '@elah/editor'

export function canExportMp4(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof OffscreenCanvas !== 'undefined'
}

export async function exportMp4(
  engine: TimelineEngine,
  options: {
    signal?: AbortSignal
    onProgress?: (percent: number) => void
  } = {},
): Promise<void> {
  if (!canExportMp4()) {
    throw new Error('This browser cannot export MP4. Chromium 108 or newer with WebCodecs is required.')
  }
  if (engine.getTotalFrames() < 1) {
    throw new Error('The timeline is empty.')
  }

  playbackStore.getState().pause()
  const blob = await lazyExportVideo(engine.getProject(), {
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

  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'edit.mp4'
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
