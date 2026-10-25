import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import CommandBar, { type VoiceControl } from '../src/CommandBar.tsx'
import '@elah/editor/styles.css'
import '../src/index.css'

export function VoiceHarness() {
  const [state, setState] = useState<VoiceControl['state']>('idle')
  const [busy, setBusy] = useState(false)
  const [value, setValue] = useState('')
  const [starts, setStarts] = useState(0)
  const [stops, setStops] = useState(0)
  const [submits, setSubmits] = useState(0)
  const [retries, setRetries] = useState(0)
  function start() {
    setStarts((n) => n + 1)
    setState('listening')
  }
  function stop() {
    setStops((n) => n + 1)
    setState('idle')
  }
  function retry() {
    setRetries((n) => n + 1)
    setState('idle')
  }
  const voice: VoiceControl =
    state === 'idle'
      ? { state, onStart: start }
      : state === 'listening'
        ? { state, onStop: stop }
        : state === 'denied'
          ? { state, onRetry: retry }
          : { state }
  return (
    <div
      className="elah-root"
      style={{ display: 'grid', minHeight: '100vh', padding: 20 }}
    >
      <div>
        <button onClick={() => setState('denied')}>
          Simulate permission denied
        </button>
        <button onClick={() => setState('unavailable')}>
          Disconnect speech control
        </button>
        <button onClick={() => setBusy((current) => !current)}>
          Toggle busy
        </button>
        <output>{JSON.stringify({ starts, stops, submits, retries })}</output>
      </div>
      <div>
        <CommandBar
          value={value}
          busy={busy}
          status="Ready"
          voice={voice}
          onChange={setValue}
          onSubmit={() => setSubmits((n) => n + 1)}
        />
      </div>
    </div>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<VoiceHarness />)
