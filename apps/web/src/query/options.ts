import { queryOptions, type QueryClient } from '@tanstack/react-query'
import type * as C from '@tx-holdem-coach/contracts'
import { api as defaultApi, handId, runId, type Api } from '../api/client.js'
import { ApiError } from '../api/errors.js'
import {
  callsSearch,
  historySearch,
  sessionsSearch,
  statisticsSearch,
} from '../api/search.js'
import { keys } from './keys.js'
import { readPolicy } from './client.js'

export function createQueries(api: Api = defaultApi) {
  const run = (id: string) =>
    queryOptions({
      ...readPolicy,
      queryKey: keys.run(id),
      queryFn: ({ signal }) => api.run(id, { signal }),
      meta: { resourceDetail: true },
    })
  return {
    rosterPreview: () =>
      queryOptions({
        ...readPolicy,
        staleTime: 0,
        queryKey: keys.rosterPreview(),
        queryFn: ({ signal }) => api.rosterPreview({ signal }),
      }),
    health: () =>
      queryOptions({
        ...readPolicy,
        queryKey: keys.health(),
        queryFn: ({ signal }) => api.health({ signal }),
      }),
    providers: () =>
      queryOptions({
        ...readPolicy,
        queryKey: keys.providers(),
        queryFn: ({ signal }) => api.providers({ signal }),
      }),
    agent: () =>
      queryOptions({
        ...readPolicy,
        queryKey: keys.agent(),
        queryFn: ({ signal }) => api.agentSettings({ signal }),
      }),
    personas: () =>
      queryOptions({
        ...readPolicy,
        queryKey: keys.personas(),
        staleTime: Infinity,
        queryFn: ({ signal }) => api.personas({ signal }),
      }),
    persona: (id: string) =>
      queryOptions({
        ...readPolicy,
        queryKey: keys.persona(id),
        staleTime: Infinity,
        queryFn: ({ signal }) => api.persona(id, { signal }),
        meta: { resourceDetail: true },
      }),
    sessions(input: C.SessionManagementPageRequest) {
      const page = sessionsSearch.normalize(input)
      return queryOptions({
        ...readPolicy,
        queryKey: keys.sessions(page),
        queryFn: ({ signal }) => api.sessions(page, { signal }),
      })
    },
    hands(input: C.HandHistoryPageRequest) {
      const page = historySearch.normalize(input)
      return queryOptions({
        ...readPolicy,
        queryKey: keys.hands(page),
        queryFn: ({ signal }) => api.hands(page, { signal }),
      })
    },
    hand(
      id: string,
      view: C.HandHistoryQuery['view'] = 'public',
      auditRequested = false,
    ) {
      // enabled 只控制请求，不能阻止 observer 读取已有缓存。
      if (view === 'auditReveal' && !auditRequested) throw new ApiError('input')
      const key = handId(id)
      return queryOptions({
        ...readPolicy,
        queryKey: keys.hand(key, view),
        queryFn: ({ signal }) => api.hand(key, { view }, { signal }),
        meta: { resourceDetail: true },
      })
    },
    statistics(input: C.StatisticsQuery) {
      const query = statisticsSearch.normalize(input)
      return queryOptions({
        ...readPolicy,
        queryKey: keys.statistics(query),
        queryFn: ({ signal }) => api.statistics(query, { signal }),
      })
    },
    handCalls(id: string, input: C.AgentCallPageRequest) {
      const key = handId(id)
      const page = callsSearch.normalize(input)
      return queryOptions({
        ...readPolicy,
        queryKey: keys.handCalls(key, page),
        queryFn: ({ signal }) => api.handCalls(key, page, { signal }),
        meta: { resourceDetail: true },
      })
    },
    run,
    // 必须先实际读取父资源；子页 meta 只保留认证关联 ID。
    async attempts(
      client: QueryClient,
      id: string,
      input: C.AgentCallPageRequest,
    ) {
      const key = runId(id)
      const page = callsSearch.normalize(input)
      const parent = await client.fetchQuery(run(key))
      return queryOptions({
        ...readPolicy,
        queryKey: keys.attempts(key, page),
        queryFn: ({ signal }) => api.attempts(key, page, { signal }),
        meta: {
          resourceDetail: true,
          sessionId: parent.sessionId,
          handId: parent.handId,
        },
      })
    },
    async capabilities(
      client: QueryClient,
      id: string,
      input: C.AgentCallPageRequest,
    ) {
      const key = runId(id)
      const page = callsSearch.normalize(input)
      const parent = await client.fetchQuery(run(key))
      return queryOptions({
        ...readPolicy,
        queryKey: keys.capabilities(key, page),
        queryFn: ({ signal }) => api.capabilities(key, page, { signal }),
        meta: {
          resourceDetail: true,
          sessionId: parent.sessionId,
          handId: parent.handId,
        },
      })
    },
  }
}
export const queries = createQueries()
