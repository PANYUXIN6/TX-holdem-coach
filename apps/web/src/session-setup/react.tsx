import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useReducer,
  useState,
  type ReactNode,
} from 'react'
import {
  hashKey,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
  type QueryKey,
} from '@tanstack/react-query'
import { useLocation } from 'react-router'
import { parseRosterSource, paths } from '../navigation.js'
import { queries } from '../query/options.js'
import { useSessionRuntime } from '../session-sync/react.js'
import {
  catalogMatches,
  initialDraft,
  previewMatches,
  readReady,
  setupReducer,
} from './model.js'

// QueryObserver 的挂载计数不会随 resetQueries 清零；记录本流程内的重置，
// 让重置后的成功读取重新取得推进资格，仍拒绝仅有挂载前缓存的结果。
function useSetupQuery<T, K extends QueryKey>(
  options: UseQueryOptions<T, Error, T, K>,
) {
  const client = useQueryClient()
  const [wasResetSinceMount, setWasResetSinceMount] = useState(false)
  const queryHash = hashKey(options.queryKey)
  useLayoutEffect(
    () =>
      client.getQueryCache().subscribe((event) => {
        if (
          event.type === 'updated' &&
          event.query.queryHash === queryHash &&
          event.action.type === 'setState' &&
          event.query.state.data === undefined
        ) {
          setWasResetSinceMount(true)
        }
      }),
    [client, queryHash],
  )
  const query = useQuery(options)
  return { ...query, wasResetSinceMount }
}

function useSetupState(source: 'current' | 'latestEnded') {
  const [draft, dispatch] = useReducer(setupReducer, undefined, initialDraft)
  const runtime = useSessionRuntime()
  const client = useQueryClient()
  const catalog = useSetupQuery({
    ...queries.personas(),
    enabled: source === 'current',
    refetchOnMount: 'always',
  })
  const preview = useSetupQuery({
    ...queries.rosterPreview(),
    refetchOnMount: 'always',
  })
  const active = useSetupQuery({
    ...runtime.activeOptions(),
    refetchOnMount: 'always',
  })
  const location = useLocation()
  useEffect(
    () =>
      client.getQueryCache().subscribe((event) => {
        if (
          event.type === 'updated' &&
          event.action.type === 'setState' &&
          event.query.queryKey[0] === 'sessions' &&
          event.query.queryKey[1] === 'roster-preview' &&
          event.query.state.data === undefined
        )
          dispatch({ type: 'clearHistory' })
      }),
    [client],
  )
  useEffect(() => {
    if (
      source === 'latestEnded' &&
      location.pathname === paths.newSession &&
      draft.preview === null &&
      !draft.requiresAcceptance &&
      readReady(preview) &&
      preview.data
    )
      dispatch({ type: 'accept', preview: preview.data })
  }, [
    source,
    location.pathname,
    draft.preview,
    draft.requiresAcceptance,
    preview.data,
    preview.isSuccess,
    preview.fetchStatus,
    preview.isFetchedAfterMount,
    preview.isFetched,
    preview.wasResetSinceMount,
  ])
  const sourceReady =
    source === 'current'
      ? readReady(catalog) && catalogMatches(draft, catalog.data?.personas)
      : readReady(preview) && previewMatches(draft.preview, preview.data)
  const canContinue = sourceReady && readReady(active) && active.data === null
  return { source, draft, dispatch, catalog, preview, active, canContinue }
}
const SetupContext = createContext<ReturnType<typeof useSetupState> | null>(
  null,
)
function SetupProvider({
  source,
  children,
}: {
  source: 'current' | 'latestEnded'
  children: ReactNode
}) {
  const state = useSetupState(source)
  return <SetupContext value={state}>{children}</SetupContext>
}
export function SetupScope({ children }: { children: ReactNode }) {
  const location = useLocation()
  const source = parseRosterSource(location.search)
  return (location.pathname === paths.newSession ||
    location.pathname === paths.confirm) &&
    source !== 'invalid' ? (
    <SetupProvider key={source} source={source}>
      {children}
    </SetupProvider>
  ) : (
    children
  )
}
export function useSetup() {
  const state = useContext(SetupContext)
  if (!state) throw new Error('组桌流程尚未初始化')
  return state
}
export function SetupErrorReset() {
  const state = useContext(SetupContext)
  const dispatch = state?.dispatch
  useLayoutEffect(() => {
    dispatch?.({ type: 'reset' })
  }, [dispatch])
  return null
}
