interface CommandBarProps {
  value: string
  busy: boolean
  status: string
  onChange: (value: string) => void
  onSubmit: () => void
}

export default function CommandBar({ value, busy, status, onChange, onSubmit }: CommandBarProps) {
  return (
    <form
      className="command"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <div className="command-row">
        <textarea
          className="command-input"
          rows={2}
          value={value}
          placeholder="Ask for an edit"
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
        <button type="submit" className="btn btn-primary" disabled={busy || value.trim() === ''}>
          Send
        </button>
      </div>
      <p className="status" role="status">
        {status}
      </p>
    </form>
  )
}
