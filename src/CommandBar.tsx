import { ArrowUp, Command, Loader2 } from 'lucide-react'

interface CommandBarProps {
  value: string
  busy: boolean
  status: string
  onChange: (value: string) => void
  onSubmit: () => void
}

export default function CommandBar({
  value,
  busy,
  status,
  onChange,
  onSubmit,
}: CommandBarProps) {
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
          {status || 'Ready'}
        </p>
        <span className="command-hint">
          Enter to apply <span>·</span> Shift + Enter for a new line
        </span>
      </div>
    </form>
  )
}
