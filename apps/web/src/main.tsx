import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { ErrorBoundary, RootError } from './ErrorBoundary.js'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary fallback={() => <RootError />}>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
