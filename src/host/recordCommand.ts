/** Push-to-talk limits. Parakeet transcribes the finished clip once. */

export const DICTATION_MAX_MS = 18_000
export const DICTATION_TRAILING_SILENCE_MS = 1_400
export const DICTATION_LEADING_SILENCE_MS = 3_000

const RECORDER_MIMES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
] as const

export function preferredAudioMime(supported: (mime: string) => boolean): string {
  for (const mime of RECORDER_MIMES) {
    if (supported(mime)) return mime
  }
  return ''
}

export function mediaRecorderAvailable(): boolean {
  if (typeof window === 'undefined') return false
  if (!window.isSecureContext) return false
  if (typeof MediaRecorder === 'undefined') return false
  const devices = navigator.mediaDevices
  return typeof devices?.getUserMedia === 'function'
}

/**
 * Stop a take on trailing silence after speech, on leading silence, or at the cap.
 * `silentMs` is time since the last loud frame. It equals elapsed time until speech starts.
 */
export function recordingStop(
  sample: {
    readonly elapsedMs: number
    readonly silentMs: number
    readonly heardSpeech: boolean
  },
  silence = true,
): 'silence' | 'max' | null {
  if (sample.elapsedMs >= DICTATION_MAX_MS) return 'max'
  if (!silence) return null
  if (sample.heardSpeech && sample.silentMs >= DICTATION_TRAILING_SILENCE_MS) return 'silence'
  if (!sample.heardSpeech && sample.silentMs >= DICTATION_LEADING_SILENCE_MS) return 'silence'
  return null
}
