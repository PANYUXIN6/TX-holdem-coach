import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, useRoutes } from 'react-router'
import {
  PublicSessionSnapshotSchema,
  SessionManagementListResponseSchema,
  type ProviderSettingsResponse,
  type PlayerAgentSettings,
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
import { ids, publicSnapshot } from './fixtures.js'
import { uniquePlayers } from './ai-fixtures.js'
import { keys } from '../src/query/keys.js'
import { queries } from '../src/query/options.js'
import '../src/styles.css'
const aborted: string[] = []
const requests: string[] = [],
  bodies: unknown[] = []
let provider: ProviderSettingsResponse['deepSeek'] = {
  configured: true,
  canCreateSession: true,
  checkStatus: 'notChecked',
  lastCheckedAt: null,
  errorCode: null,
}
let settings: PlayerAgentSettings = {
  attemptTimeoutSeconds: 15,
  decisionDeadlineSeconds: 45,
}
let failure = '',
  afterWriteFailure = '',
  hold = '',
  deleted = false,
  empty = false,
  detailLifecycle = 'ended'
const held: (() => void)[] = []
const client = createQueryClient()
const runtime = createSessionRuntime(client)
const snapshot = uniquePlayers(
  PublicSessionSnapshotSchema.parse({
    ...publicSnapshot,
    lifecycleStatus: 'ended',
    pokerPhase: 'betweenHands',
    hand: null,
  }),
)
const sensitive = 'SENSITIVE_RAW_KEY_DATABASE_MODEL_ROUTE_BODY'
window.fetch = async (input, init) => {
  const url = new URL(
    input instanceof Request ? input.url : String(input),
    location.origin,
  )
  const method = init?.method ?? 'GET'
  requests.push(`${method} ${url.pathname}${url.search}`)
  const requestLabel = `${method} ${url.pathname}${url.search}`
  await Promise.resolve()
  if (init?.signal?.aborted) {
    aborted.push(requestLabel)
    throw new DOMException('Aborted', 'AbortError')
  }
  const body = init?.body ? JSON.parse(String(init.body)) : undefined
  if (body) bodies.push(body)
  const respond = async (data: unknown, kind: string) => {
    if (hold === kind) {
      hold = ''
      await new Promise<void>((resolve) => held.push(resolve))
    }
    if (failure === kind)
      return Response.json(
        { code: 'SERVICE_UNAVAILABLE', message: sensitive },
        { status: 503 },
      )
    return Response.json(data)
  }
  if (method === 'DELETE') {
    if (failure === 'delete-network') throw new TypeError(sensitive)
    if (failure === 'delete')
      return Response.json(
        { code: 'SESSION_NOT_ENDED', message: sensitive },
        { status: 409 },
      )
    const count = empty ? 0 : deleted ? 2 : 3
    if (url.pathname === '/api/data') empty = true
    else deleted = true
    return respond(
      url.pathname === '/api/data'
        ? {
            deletedSessionCount: count,
            invalidatedRunCount: count === 0 ? 0 : 4,
          }
        : { deletedSessionId: ids.session, invalidatedRunCount: 2 },
      'delete',
    )
  }
  if (url.pathname.endsWith('/check')) {
    if (failure === 'check-network') throw new TypeError(sensitive)
    provider = {
      ...provider,
      checkStatus: 'unavailable',
      lastCheckedAt: '2026-09-15T00:00:00Z',
      errorCode: 'provider_timeout',
    }
    failure = afterWriteFailure
    return respond({ deepSeek: provider }, 'check')
  }
  if (url.pathname === '/api/settings/providers')
    return respond({ deepSeek: provider }, 'providers')
  if (url.pathname === '/api/settings/agent') {
    if (method === 'PATCH') {
      if (failure === 'patch-field')
        return Response.json(
          {
            code: 'VALIDATION_ERROR',
            message: sensitive,
            fieldErrors: [
              {
                path: ['settings', 'decisionDeadlineSeconds'],
                message: sensitive,
              },
            ],
          },
          { status: 400 },
        )
      settings = { ...settings, ...body.settings }
      failure = afterWriteFailure
      return respond({ settings }, 'patch')
    }
    return respond({ settings }, 'agent')
  }
  if (url.pathname === '/api/health')
    return respond({ status: 'ok', database: 'available' }, 'health')
  if (url.pathname === '/api/sessions/active')
    return Response.json(
      { code: 'SESSION_NOT_FOUND', message: '无活动场次' },
      { status: 404 },
    )
  if (url.pathname === `/api/sessions/${ids.session}`) {
    if (deleted || empty || failure === 'detail404')
      return Response.json(
        { code: 'RESOURCE_NOT_FOUND', message: sensitive },
        { status: 404 },
      )
    return respond(
      {
        snapshot:
          detailLifecycle === 'ended'
            ? snapshot
            : uniquePlayers(PublicSessionSnapshotSchema.parse(publicSnapshot)),
      },
      'detail',
    )
  }
  if (url.pathname === '/api/statistics') {
    const query = statisticsSearch.decode(url.search)
    return respond(
      {
        scope: 'sessions',
        query,
        timeBasis: 'sessionEndedAt',
        totals: {
          sessionCount: 1,
          participantSessionCount: 1,
          finalChips: 2500,
          cumulativeBuyIn: 4000,
          sessionNetChange: -1500,
        },
      },
      'statistics',
    )
  }
  if (url.pathname === '/api/sessions') {
    const page = sessionsSearch.decode(url.search)
    const ended = managementItem('ended')
    ended.roster = ended.roster.map((seat) =>
      seat.kind === 'ai'
        ? { ...seat, displayName: '很长的历史人物名称用于验证手机布局完整显示' }
        : seat,
    )
    if (ended.accounting.status === 'available') {
      ended.accounting.seats[0]!.cumulativeBuyIn = Number.MAX_SAFE_INTEGER
      ended.accounting.seats[0]!.sessionNetChange =
        2500 - Number.MAX_SAFE_INTEGER
    }
    const items = empty
      ? []
      : page.cursor
        ? [managementItem('ended', 'e206c895-73d6-46c6-8237-5e6d7d943b57')]
        : [
            ...(!deleted ? [ended] : []),
            managementItem('active', 'e206c895-73d6-46c6-8237-5e6d7d943b58'),
            managementItem(
              'readonlyDiagnostic',
              'e206c895-73d6-46c6-8237-5e6d7d943b59',
            ),
          ]
    return respond(
      SessionManagementListResponseSchema.parse({
        query: page.query,
        timeBasis: 'sessionCreatedAt',
        items,
        nextCursor: empty || page.cursor ? null : 'next-page',
      }),
      'sessions',
    )
  }
  return Response.json(
    { code: 'RESOURCE_NOT_FOUND', message: sensitive },
    { status: 404 },
  )
}
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
  settingsFixture: {
    requests,
    aborted,
    bodies,
    failure: (value: string) => {
      failure = value
    },
    afterWriteFailure: (value: string) => {
      afterWriteFailure = value
    },
    hold: (value: string) => {
      hold = value
    },
    release: () => held.splice(0).forEach((done) => done()),
    provider: (status: ProviderSettingsResponse['deepSeek']['checkStatus']) => {
      provider = {
        configured: status !== 'notConfigured',
        canCreateSession: status !== 'notConfigured',
        checkStatus: status,
        lastCheckedAt: ['available', 'unavailable'].includes(status)
          ? '2026-09-15T00:00:00Z'
          : null,
        errorCode: status === 'unavailable' ? 'provider_timeout' : null,
      }
    },
    settings: (value: PlayerAgentSettings) => {
      settings = value
    },
    detailLifecycle: (value: string) => {
      detailLifecycle = value
    },
    startStatistics: () => {
      void client
        .fetchQuery(
          queries.statistics(statisticsSearch.decode('?scope=sessions')),
        )
        .catch(() => {})
    },
    seed: () => {
      client.setQueryData(keys.hand(ids.hand, 'public'), {
        sessionId: ids.session,
      })
      client.setQueryData(
        keys.statistics({
          scope: 'hands',
          subject: 'user',
          from: null,
          to: null,
          sessionId: null,
          personaId: null,
          personaVersion: null,
          personaName: null,
          configSnapshotKey: null,
          position: null,
          groupBy: 'none',
        }),
        { marker: 'old-statistics' },
      )
    },
    cached: () =>
      client
        .getQueryCache()
        .getAll()
        .map((q) => ({ key: q.queryKey, data: q.state.data })),
  },
})
