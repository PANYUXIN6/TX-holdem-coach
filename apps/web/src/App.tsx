import { OverlayUiProvider } from './ui/react.js'
import { useState } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createQueryClient } from './query/client.js'
import { BrowserRouter, useRoutes } from 'react-router'
import { routes } from './navigation.js'
import { Page } from './Pages.js'
import { Shell } from './Shell.js'
import { createSessionRuntime } from './session-sync/runtime.js'
import { SessionRuntimeProvider } from './session-sync/react.js'
import './styles.css'

const pageRoutes = [
  {
    element: <Shell />,
    children: routes.map((route) => ({
      ...route,
      element: <Page id={route.id} />,
    })),
  },
]

function ApplicationRoutes() {
  return useRoutes(pageRoutes)
}

export function App() {
  const [{ queryClient, runtime }] = useState(() => {
    const queryClient = createQueryClient()
    return { queryClient, runtime: createSessionRuntime(queryClient) }
  })
  return (
    <QueryClientProvider client={queryClient}>
      <SessionRuntimeProvider runtime={runtime}>
        <OverlayUiProvider>
          <BrowserRouter>
            <ApplicationRoutes />
          </BrowserRouter>
        </OverlayUiProvider>
      </SessionRuntimeProvider>
    </QueryClientProvider>
  )
}
