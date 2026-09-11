import { useState } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createQueryClient } from './query/client.js'
import { BrowserRouter, useRoutes } from 'react-router'
import { routes } from './navigation.js'
import { Page } from './Pages.js'
import { Shell } from './Shell.js'
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
  const [queryClient] = useState(createQueryClient)
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ApplicationRoutes />
      </BrowserRouter>
    </QueryClientProvider>
  )
}
