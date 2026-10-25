import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// All three SDK stylesheets, in this order. Each package ships its own CSS,
// so dropping one leaves the timeline or the preview unstyled.
import '@elah/timeline/styles.css'
import '@elah/editor/styles.css'
import '@elah/editor/styles/tokens.css'
import './index.css'

import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
