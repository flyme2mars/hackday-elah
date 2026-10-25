import { ArrowUp, Command, Loader2, Mic, MicOff, Square } from 'lucide-react'

export type VoiceControl =
  | { state: 'unavailable' }
  | { state: 'idle'; onStart: () => void }
  | { state: 'listening'; onStop: () => void }
  | { state: 'denied'; onRetry: () => void }

interface CommandBarProps {
  value: string
  busy: boolean
  status: string
  onChange: (value: string) => void
  onSubmit: () => void
  voice: VoiceControl
}

export default function CommandBar({
  value,
  busy,
  status,
  onChange,
  onSubmit,
  voice,
}: CommandBarProps) {
  const listening = voice.state === 'listening'
  const denied = voice.state === 'denied'
  const commandStatus = status.trim()
  const listeningStatus =
    commandStatus && commandStatus !== 'Ready' && !commandStatus.startsWith('Listening')
      ? commandStatus
      : 'Listening… Speak your command.'
  const voiceLabel = listening
    ? 'Stop listening'
    : denied
      ? 'Microphone access denied. Retry voice input'
      : voice.state === 'unavailable'
        ? 'Voice input unavailable'
        : 'Start voice input'
  const voiceStatus = listening
    ? listeningStatus
    : denied
      ? 'Microphone access is blocked. Allow it in your browser settings, then retry.'
      : voice.state === 'unavailable'
        ? 'Speech recognition is not available in this browser.'
        : ''

  function onVoice() {
    switch (voice.state) {
      case 'idle':
        voice.onStart()
        return
      case 'listening':
        voice.onStop()
        return
      case 'denied':
        voice.onRetry()
        return
      case 'unavailable':
        return
      default: {
        const exhaustive: never = voice
        return exhaustive
      }
    }
  }

  return (
    <form
      className="command"
      aria-busy={busy}
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <div className="command-row">
        <span className="command-symbol" aria-hidden="true">
          {busy ? (
            <Loader2 size={17} className="spin" />
          ) : (
            <Command size={17} />
          )}
        </span>
        <textarea
          className="command-input"
          rows={1}
          value={value}
          placeholder="Describe your edit…"
          aria-label="Agent command"
          disabled={busy}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              onSubmit()
            }
          }}
        />
        <button
          type="button"
          className="mic-button"
          data-state={voice.state}
          aria-label={voiceLabel}
          title={voiceLabel}
          aria-pressed={listening}
          disabled={voice.state === 'unavailable' || (busy && !listening)}
          onClick={onVoice}
        >
          {listening ? (
            <Square size={12} fill="currentColor" />
          ) : denied ? (
            <MicOff size={16} />
          ) : (
            <Mic size={16} />
          )}
          {listening && (
            <span className="mic-listening-dot" aria-hidden="true" />
          )}
        </button>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={busy || value.trim() === ''}
        >
          <ArrowUp size={17} />
          <span className="sr-only">Send</span>
        </button>
      </div>
      <div className="command-footer">
        <p className="status" role="status">
          {busy ? status || 'Ready' : voiceStatus || status || 'Ready'}
        </p>
        <span className="command-hint">
          Enter to apply <span>·</span> Shift + Enter for a new line
        </span>
      </div>
    </form>
  )
}
