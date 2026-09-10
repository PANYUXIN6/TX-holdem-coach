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
  return (
    <BrowserRouter>
      <ApplicationRoutes />
    </BrowserRouter>
  )
}
