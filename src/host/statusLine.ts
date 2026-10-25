const STATUS_LIMIT = 180

export const EXPORT_UNSUPPORTED =
  'This browser cannot export MP4. Chromium 108 or newer with WebCodecs is required.'
export const EXPORT_EMPTY = 'The timeline is empty.'

const EXPORT_ENCODER =
  'Export failed. The encoder rejected AVC or AAC. Use desktop Chromium 108 or newer.'

export function clipStatus(text: string, limit = STATUS_LIMIT): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat || flat === '[object Object]') return ''
  if (flat.length <= limit) return flat
  return `${flat.slice(0, limit - 1).trimEnd()}…`
}

export function errorText(error: unknown): { name: string; message: string } {
  if (typeof error === 'string') return { name: '', message: clipStatus(error) }
  if (error instanceof Error) return { name: error.name, message: clipStatus(error.message) }
  if (error && typeof error === 'object') {
    const record = error as { name?: unknown; message?: unknown }
    const name = typeof record.name === 'string' ? record.name : ''
    const message = typeof record.message === 'string' ? clipStatus(record.message) : ''
    if (name || message) return { name, message }
  }
  return { name: '', message: clipStatus(String(error)) }
}

export function isTimeoutError(error: unknown): boolean {
  const { name, message } = errorText(error)
  if (name === 'TimeoutError' || name === 'AbortError') return true
  return /signal timed out|operation was aborted|aborted due to timeout/i.test(message)
}

/** A failed fetch. Timeouts are separate: the worker may still be up. */
export function isFetchFailure(error: unknown): boolean {
  if (isTimeoutError(error)) return false
  const { name, message } = errorText(error)
  if (name === 'TypeError' && /fetch|network|load failed/i.test(message)) return true
  return /failed to fetch|networkerror|econnrefused/i.test(message)
}

export function exportErrorLine(error: unknown): string {
  const { name, message } = errorText(error)
  if (message.startsWith('This browser cannot export') || message === EXPORT_EMPTY) return message
  if (message.startsWith('Export failed')) return message
  if (isEncoderFailure(name, message)) {
    if (!message || message.length > 100) return EXPORT_ENCODER
    return clipStatus(`Export failed: ${message}`)
  }
  if (!message) return 'Export failed. The encoder returned no detail.'
  return clipStatus(`Export failed: ${message}`)
}

function isEncoderFailure(name: string, message: string): boolean {
  if (name === 'NotSupportedError' || name === 'EncodingError' || name === 'OperationError') return true
  return /aac|avc|codec|encoder|webcodecs|not supported|unsupported/i.test(`${name} ${message}`)
}

export function commandStatusLine(result: {
  note: string
  planner: string
  ops: readonly unknown[]
  hits: readonly unknown[]
}): string {
  const note = clipStatus(result.note)
  if (result.planner === 'offline') {
    if (!note) return 'Planner not loaded. No edits were applied.'
    if (!/planner not loaded/i.test(note)) return clipStatus(`Planner not loaded. ${note}`)
    return note
  }
  if (note) return note
  if (result.ops.length > 0 || result.hits.length > 0) return 'Done'
  return 'No edits.'
}

export function failureStatusLine(error: unknown, timeoutMessage: string): string {
  if (isTimeoutError(error)) return timeoutMessage
  if (isFetchFailure(error)) return 'Sense worker is not running.'
  const { message } = errorText(error)
  return message || 'Command failed.'
}
