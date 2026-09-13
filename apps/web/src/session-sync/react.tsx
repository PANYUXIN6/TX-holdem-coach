import {
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { useQuery } from '@tanstack/react-query'
import { matchRoutes, useLocation } from 'react-router'
import { SessionPathParamsSchema } from '@tx-holdem-coach/contracts'
import { routes } from '../navigation.js'
import { sessionId } from '../api/client.js'
import type { SessionRuntime } from './runtime.js'
const RuntimeContext = createContext<SessionRuntime | null>(null)
export function SessionRuntimeProvider({
  runtime,
  children,
}: {
  runtime: SessionRuntime
  children: ReactNode
}) {
  useEffect(() => {
    const visibility = () => runtime.visibility(document.hidden)
    const online = () => runtime.online()
    const focus = () => {
      if (!document.hidden) runtime.focus()
    }
    visibility()
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('online', online)
    window.addEventListener('focus', focus)
    return () => {
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('online', online)
      window.removeEventListener('focus', focus)
    }
  }, [runtime])
  return <RuntimeContext value={runtime}>{children}</RuntimeContext>
}
export function useSessionRuntime() {
  const runtime = useContext(RuntimeContext)
  if (!runtime) throw new Error('SessionRuntimeProvider missing')
  return runtime
}
/** M7 订阅唯一快照；enabled 仅控制自动读取，连接租用由路由桥接持有。 */
export function useSession(
  input: string,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const runtime = useSessionRuntime()
  const id = sessionId(input)
  const query = useQuery({ ...runtime.sessionOptions(id), enabled })
  const status = useSyncExternalStore(
    (listener) => runtime.subscribe(id, listener),
    () => runtime.getStatus(id),
  )
  const submitting = useSyncExternalStore(
    (listener) => runtime.subscribe(id, listener),
    () => runtime.isSubmitting(id),
  )
  const syncError = useSyncExternalStore(
    (listener) => runtime.subscribe(id, listener),
    () => runtime.getError(id),
  )
  return {
    ...query,
    status,
    submitting,
    syncError,
    canSubmit: status === 'ready' && !submitting,
    runtime,
  }
}
function SessionLease({ id }: { id: string }) {
  const runtime = useSessionRuntime()
  useEffect(() => runtime.acquire(id), [runtime, id])
  useSession(id)
  return null
}
/** 由页面错误边界拥有租用，失败卸载时同样释放连接。 */
export function SessionRouteBridge() {
  const location = useLocation()
  const route = matchRoutes(routes, location)?.at(-1)
  if (!route || !['table', 'currentHand', 'agents'].includes(route.route.id))
    return null
  const parsed = SessionPathParamsSchema.safeParse(route.params)
  return parsed.success ? (
    <SessionLease id={parsed.data.sessionId.toLowerCase()} />
  ) : null
}
