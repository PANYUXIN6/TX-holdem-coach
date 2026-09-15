import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MutationObserver, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, useRoutes } from 'react-router'
import {
  StatisticsResponseSchema,
  SessionManagementListResponseSchema,
} from '@tx-holdem-coach/contracts'
import { Page } from '../src/Pages.js'
import { Shell } from '../src/Shell.js'
import { routes } from '../src/navigation.js'
import { createQueryClient } from '../src/query/client.js'
import { sessionsSearch, statisticsSearch } from '../src/api/search.js'
import { createSessionRuntime } from '../src/session-sync/runtime.js'
import { SessionRuntimeProvider } from '../src/session-sync/react.js'
import { OverlayUiProvider } from '../src/ui/react.js'
import { managementItem } from './home-transport.js'
import { ids } from './fixtures.js'
import '../src/styles.css'

const requests: string[] = []
let failure = false,
  empty = false,
  large = false,
  hold = false,
  even = false
const held: (() => void)[] = []
const zero = { numerator: 0, denominator: 0, percentage: null }
const emptyMetrics = {
  handCount: 0,
  distinctHandCount: 0,
  handNetChange: 0,
  vpip: zero,
  pfr: zero,
  threeBet: zero,
  wtsd: zero,
  wsd: zero,
}
const client = createQueryClient()
const runtime = createSessionRuntime(client)
window.fetch = async (input, init) => {
  const url = new URL(
    input instanceof Request ? input.url : String(input),
    location.origin,
  )
  requests.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`)
  if (init?.method === 'DELETE') {
    empty = true
    return Response.json(
      url.pathname === '/api/data'
        ? { deletedSessionCount: 1, invalidatedRunCount: 0 }
        : { deletedSessionId: ids.session, invalidatedRunCount: 0 },
    )
  }
  if (url.pathname === '/api/statistics') {
    const query = statisticsSearch.decode(url.search)
    const metrics = empty
      ? emptyMetrics
      : {
          ...emptyMetrics,
          handCount: query.subject === 'ai' ? 5 : 3,
          distinctHandCount: query.subject === 'ai' ? 1 : 3,
          handNetChange: large ? Number.MAX_SAFE_INTEGER : 120,
          vpip: {
            numerator: 0,
            denominator: query.subject === 'ai' ? 5 : 3,
            percentage: 0,
          },
          pfr: {
            numerator: 1,
            denominator: query.subject === 'ai' ? 5 : 3,
            percentage: query.subject === 'ai' ? 20 : 33.33,
          },
          threeBet: { numerator: 1, denominator: 3, percentage: 33.33 },
        }
    const data = StatisticsResponseSchema.parse(
      query.scope === 'hands'
        ? {
            scope: 'hands',
            query,
            timeBasis: 'handStartedAt',
            totals: metrics,
            byPosition:
              query.groupBy === 'position'
                ? [
                    'UTG',
                    'UTG+1',
                    'MP',
                    'LJ',
                    'HJ',
                    'CO',
                    'BTN',
                    'SB',
                    'BB',
                  ].map((position) => ({
                    position,
                    metrics: empty
                      ? emptyMetrics
                      : position === 'BTN'
                        ? {
                            ...metrics,
                            handCount: 3,
                            handNetChange: 120,
                            vpip: {
                              numerator: 0,
                              denominator: 3,
                              percentage: 0,
                            },
                            pfr: {
                              numerator: 1,
                              denominator: 3,
                              percentage: 33.33,
                            },
                          }
                        : position === 'BB' && query.subject === 'ai'
                          ? {
                              ...emptyMetrics,
                              handCount: 2,
                              distinctHandCount: 1,
                              vpip: {
                                numerator: 0,
                                denominator: 2,
                                percentage: 0,
                              },
                              pfr: {
                                numerator: 0,
                                denominator: 2,
                                percentage: 0,
                              },
                            }
                          : emptyMetrics,
                  }))
                : [],
          }
        : {
            scope: 'sessions',
            query,
            timeBasis: 'sessionEndedAt',
            totals: {
              sessionCount: empty ? 0 : 1,
              participantSessionCount: empty
                ? 0
                : query.subject === 'ai'
                  ? 5
                  : 1,
              finalChips: empty ? 0 : even ? 3000 : 2700,
              cumulativeBuyIn: empty ? 0 : 3000,
              sessionNetChange: empty || even ? 0 : -300,
            },
          },
    )
    const fail = failure
    if (hold) await new Promise<void>((resolve) => held.push(resolve))
    return fail
      ? Response.json(
          { code: 'SERVICE_UNAVAILABLE', message: '受控失败' },
          { status: 503 },
        )
      : Response.json(data)
  }
  if (url.pathname === '/api/sessions/active')
    return Response.json({ snapshot: null })
  if (url.pathname === '/api/sessions') {
    const page = sessionsSearch.decode(url.search)
    const item = managementItem('active')
    item.roster = item.roster.map((p) =>
      p.kind === 'ai'
        ? {
            ...p,
            displayName: '同名历史人物',
            configSnapshotKey: (p.seatNumber === 1 ? 'a' : 'b').repeat(64),
          }
        : p,
    )
    return Response.json(
      SessionManagementListResponseSchema.parse({
        query: page.query,
        timeBasis: 'sessionCreatedAt',
        items: empty ? [] : [item],
        nextCursor: page.cursor ? null : 'next-options',
      }),
    )
  }
  return Response.json(
    { code: 'RESOURCE_NOT_FOUND', message: '受控未找到' },
    { status: 404 },
  )
}
if (location.pathname.startsWith('/test/'))
  history.replaceState(null, '', '/statistics')
function Application() {
  return useRoutes([
    {
      element: <Shell />,
      children: routes.map((route) => ({
        ...route,
        element: <Page id={route.id} />,
      })),
    },
  ])
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <SessionRuntimeProvider runtime={runtime}>
        <OverlayUiProvider>
          <BrowserRouter>
            <Application />
          </BrowserRouter>
        </OverlayUiProvider>
      </SessionRuntimeProvider>
    </QueryClientProvider>
  </StrictMode>,
)
Object.assign(window, {
  statisticsFixture: {
    requests,
    even: () => {
      even = true
    },
    failure: (value: boolean) => {
      failure = value
    },
    empty: (value: boolean) => {
      empty = value
    },
    large: () => {
      large = true
    },
    hold: (value: boolean) => {
      hold = value
    },
    release: () => {
      held.splice(0).forEach((done) => done())
    },
    remove: () =>
      new MutationObserver(client, runtime.mutations.deleteSession()).mutate({
        sessionId: ids.session,
        body: { confirmation: '永久删除本场' },
      }),
    clear: () =>
      new MutationObserver(client, runtime.mutations.clearData()).mutate({
        confirmation: '永久清空全部数据',
      }),
  },
})
