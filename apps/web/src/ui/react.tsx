import { confirmationTargetMatches } from './confirmation.js'
import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  type ReactNode,
} from 'react'
import { useStore } from 'zustand'
import { useQueryClient } from '@tanstack/react-query'
import { matchRoutes, useLocation } from 'react-router'
import {
  SessionPathParamsSchema,
  type PublicSessionSnapshot,
} from '@tx-holdem-coach/contracts'
import { routes } from '../navigation.js'
import { runId } from '../api/client.js'
import { keys } from '../query/keys.js'
import { useSessionRuntime } from '../session-sync/react.js'
import { createTableScope, type TableScope } from './table-adapter.js'
import {
  createDebugUiStore,
  createOverlayUiStore,
  type TableUiState,
  type TableAnimationState,
  type DebugUiState,
  type OverlayUiState,
} from './stores.js'
const TableContext = createContext<TableScope | null>(null)
const DebugContext = createContext<ReturnType<
  typeof createDebugUiStore
> | null>(null)
const OverlayContext = createContext<ReturnType<
  typeof createOverlayUiStore
> | null>(null)
const PageScopeContext = createContext<string | null>(null)
export function useTableScope() {
  const scope = useContext(TableContext)
  if (!scope) throw new Error('TableUiProvider missing')
  return scope
}
export function useTableUi<T>(selector: (state: TableUiState) => T) {
  return useStore(useTableScope().table, selector)
}
export function useTableAnimation<T>(
  selector: (state: TableAnimationState) => T,
) {
  return useStore(useTableScope().animation, selector)
}
export function useDebugStore() {
  const store = useContext(DebugContext)
  if (!store) throw new Error('DebugUiProvider missing')
  return store
}
export function useDebugUi<T>(selector: (state: DebugUiState) => T) {
  return useStore(useDebugStore(), selector)
}
export function useOverlayStore() {
  const store = useContext(OverlayContext)
  if (!store) throw new Error('OverlayUiProvider missing')
  return store
}
export function useOverlayUi<T>(selector: (state: OverlayUiState) => T) {
  return useStore(useOverlayStore(), selector)
}
export function usePageScope() {
  const scope = useContext(PageScopeContext)
  if (!scope) throw new Error('PageUiProvider missing')
  return scope
}
export function OverlayUiProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createOverlayUiStore)
  const client = useQueryClient()
  const runtime = useSessionRuntime()
  useLayoutEffect(() => {
    const check = () => {
      const active = store.getState().active
      if (!active || active.kind === 'clearData') return
      const current = client.getQueryData<PublicSessionSnapshot>(
        keys.session(active.sessionId),
      )
      if (
        !confirmationTargetMatches(active, current) ||
        runtime.getStatus(active.sessionId) === 'missing'
      )
        store.getState().close(active.instanceId)
    }
    const offQuery = client.getQueryCache().subscribe(check)
    const offStore = store.subscribe(check)
    const offOperations = runtime.subscribeOperations(check)
    return () => {
      offQuery()
      offStore()
      offOperations()
      const active = store.getState().active
      if (active) store.getState().close(active.instanceId)
    }
  }, [client, runtime, store])
  return <OverlayContext value={store}>{children}</OverlayContext>
}
export function TableUiProvider({
  id,
  children,
}: {
  id: string
  children: ReactNode
}) {
  const client = useQueryClient()
  const runtime = useSessionRuntime()
  const [scope] = useState(() => createTableScope(id, client, runtime))
  useLayoutEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const environment = () => scope.environment(document.hidden, media.matches)
    environment()
    const release = scope.mount()
    document.addEventListener('visibilitychange', environment)
    media.addEventListener('change', environment)
    return () => {
      document.removeEventListener('visibilitychange', environment)
      media.removeEventListener('change', environment)
      release()
    }
  }, [scope])
  return <TableContext value={scope}>{children}</TableContext>
}
export function DebugUiProvider({
  id,
  children,
}: {
  id: string
  children: ReactNode
}) {
  const [store] = useState(createDebugUiStore)
  const client = useQueryClient()
  useLayoutEffect(() => {
    const off = client.getQueryCache().subscribe((event) => {
      if (
        event.query.queryKey[0] !== 'agent-runs' ||
        event.query.queryKey[1] !== id
      )
        return
      if (
        event.query.queryKey[2] === 'detail' &&
        (event.type === 'removed' || !event.query.state.data)
      )
        store.getState().reset()
      else if (event.type === 'removed') store.getState().select(null)
    })
    return () => {
      off()
      store.getState().reset()
    }
  }, [client, id, store])
  return <DebugContext value={store}>{children}</DebugContext>
}
/** 与 pathname 页面错误边界同寿命；所有页面都有弹窗来源，只有领域路由创建领域 Store。 */
export function PageUiProvider({ children }: { children: ReactNode }) {
  const [scope] = useState(() => crypto.randomUUID())
  const overlay = useOverlayStore()
  const location = useLocation()
  useLayoutEffect(
    () => () => overlay.getState().closeOwned(scope),
    [overlay, scope],
  )
  const route = matchRoutes(routes, location)?.at(-1)
  let content = children
  if (route?.route.id === 'table') {
    const parsed = SessionPathParamsSchema.safeParse(route.params)
    if (parsed.success)
      content = (
        <TableUiProvider id={parsed.data.sessionId.toLowerCase()}>
          {children}
        </TableUiProvider>
      )
  } else if (route?.route.id === 'run') {
    try {
      content = (
        <DebugUiProvider id={runId(route.params.runId!)}>
          {children}
        </DebugUiProvider>
      )
    } catch {
      /* Page owns invalid route display. */
    }
  }
  return <PageScopeContext value={scope}>{content}</PageScopeContext>
}
