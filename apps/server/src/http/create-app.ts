import { randomUUID } from 'node:crypto'
import { ErrorResponseSchema } from '@tx-holdem-coach/contracts'
import { Hono, type Context } from 'hono'
import { matchedRoutes, routePath } from 'hono/route'
import type { PersonaCatalog } from '../personas/catalog.js'
import type { ProviderHealthService } from '../providers/provider-health-service.js'
import type { PlayerAgentSettingsService } from '../settings/player-agent-settings-service.js'
import type { SessionDataDeletionService } from '../sessions/session-data-deletion-service.js'
import type { SessionEventStreamService } from '../sessions/public-projection/session-event-stream-service.js'
import type { CompletedHandHistoryQueryService } from '../sessions/hand-history/completed-hand-history-query-service.js'
import type { CompletedHandHistoryListQueryService } from '../sessions/hand-history/completed-hand-history-list-query-service.js'
import type { StatisticsQueryService } from '../sessions/statistics/statistics-query-service.js'
import type { SessionManagementQueryService } from '../sessions/data-management/session-management-query-service.js'
import type { AgentCallQueryService } from '../agents/audit/agent-call-query-service.js'
import { registerAgentCallRoutes } from './agent-call-routes.js'
import { registerSessionManagementRoutes } from './session-management-routes.js'
import { registerAgentSettingsRoutes } from './agent-settings-routes.js'
import type { ApiVariables } from './api-context.js'
import { registerDataRoutes } from './data-routes.js'
import { handleHttpError } from './error-mapper.js'
import { registerHealthRoutes } from './health-routes.js'
import { registerHandHistoryRoutes } from './hand-history-routes.js'
import { registerHandHistoryListRoutes } from './hand-history-list-routes.js'
import { registerStatisticsRoutes } from './statistics-routes.js'
import type { HealthService } from './health-service.js'
import { registerPersonaRoutes } from './persona-routes.js'
import { registerProviderSettingsRoutes } from './provider-settings-routes.js'
import { HttpBoundaryError } from './request-boundary.js'
import {
  registerSessionRoutes,
  type SessionHttpPorts,
} from './session-routes.js'
import { registerSessionEventRoutes } from './session-event-routes.js'

export interface ApiRuntime {
  readonly health: HealthService
  readonly providerHealth: ProviderHealthService
  readonly playerAgentSettings: PlayerAgentSettingsService
  readonly personaCatalog: PersonaCatalog
  readonly deletion: SessionDataDeletionService
  readonly sessionHttp: SessionHttpPorts
  readonly sessionEvents: SessionEventStreamService
  readonly handHistory: CompletedHandHistoryQueryService
  readonly handHistoryList: CompletedHandHistoryListQueryService
  readonly statistics: StatisticsQueryService
  readonly sessionManagement: SessionManagementQueryService
  readonly agentCalls: AgentCallQueryService
}

export interface ApiAppOptions {
  readonly port: number
  readonly allowedOrigins: ReadonlySet<string>
  readonly logRequest?: (entry: ApiRequestLogEntry) => void
}

export interface ApiRequestLogEntry {
  readonly requestId: string
  readonly method: string
  readonly route: string
  readonly status: number
  readonly errorCode?: string
  readonly durationMs: number
}

function routeLookupMethod(method: string): string {
  return method === 'HEAD' ? 'GET' : method
}

function requestLogRoute(context: Context): string {
  const activePath = routePath(context)
  if (activePath !== '' && !activePath.includes('*')) return activePath

  return (
    matchedRoutes(context).find((route) => !route.path.includes('*'))?.path ??
    'unmatched'
  )
}

function isKnownRoute(method: string, path: string): boolean {
  method = routeLookupMethod(method)
  const fixed = new Set([
    'GET /api/health',
    'GET /api/sessions/roster-preview/latest-ended',
    'GET /api/settings/providers',
    'GET /api/settings/agent',
    'PATCH /api/settings/agent',
    'GET /api/agent-personas',
    'DELETE /api/data',
  ])
  if (fixed.has(`${method} ${path}`)) return true
  if (/^\/api\/settings\/providers\/deepseek\/check$/.test(path)) {
    return method === 'POST'
  }
  if (/^\/api\/agent-personas\/[^/]+$/.test(path)) return method === 'GET'
  if (path === '/api/hands') return method === 'GET'
  if (path === '/api/statistics') return method === 'GET'
  if (/^\/api\/hands\/[^/]+\/agent-calls$/.test(path)) return method === 'GET'
  if (/^\/api\/agent-runs\/[^/]+$/.test(path)) return method === 'GET'
  if (
    /^\/api\/agent-runs\/[^/]+\/(attempts|capability-invocations)$/.test(path)
  ) {
    return method === 'GET'
  }
  if (/^\/api\/hands\/[^/]+$/.test(path)) return method === 'GET'
  if (path === '/api/sessions/active') return method === 'GET'
  if (/^\/api\/sessions\/[^/]+\/events$/.test(path)) {
    return method === 'GET'
  }
  if (/^\/api\/sessions\/[^/]+$/.test(path)) {
    return method === 'DELETE' || method === 'GET'
  }
  if (path === '/api/sessions') return method === 'POST' || method === 'GET'
  return method === 'POST' && /^\/api\/sessions\/[^/]+\/commands$/.test(path)
}

function appendVaryOrigin(response: Response): void {
  const current = response.headers.get('Vary')
  if (current === null) response.headers.set('Vary', 'Origin')
  else if (
    !current
      .split(',')
      .map((part) => part.trim())
      .includes('Origin')
  ) {
    response.headers.set('Vary', `${current}, Origin`)
  }
}

function setSecurityHeaders(
  context: Context<{ Variables: ApiVariables }>,
  requestId: string,
): void {
  context.header('Cache-Control', 'no-store')
  context.header('X-Content-Type-Options', 'nosniff')
  context.header('Referrer-Policy', 'no-referrer')
  context.header('X-Frame-Options', 'DENY')
  context.header('X-Request-Id', requestId)
  context.header('Vary', 'Origin')
}

export function createApp(
  runtime: ApiRuntime,
  options: ApiAppOptions,
): Hono<{ Variables: ApiVariables }> {
  const app = new Hono<{ Variables: ApiVariables }>()
  const allowedHosts = new Set([
    `127.0.0.1:${options.port}`,
    `localhost:${options.port}`,
  ])

  app.onError(handleHttpError)
  app.use('/api/*', async (context, next) => {
    const startedAt = Date.now()
    await next()
    let errorCode: string | undefined
    if (context.res.status >= 400) {
      try {
        const body = (await context.res.clone().json()) as unknown
        if (
          typeof body === 'object' &&
          body !== null &&
          'code' in body &&
          typeof body.code === 'string' &&
          /^[A-Z][A-Z0-9_]{0,63}$/.test(body.code)
        ) {
          errorCode = body.code
        }
      } catch {
        // Logging never changes the public response.
      }
    }
    try {
      options.logRequest?.({
        requestId: context.get('requestId'),
        method: context.req.method,
        route: requestLogRoute(context),
        status: context.res.status,
        ...(errorCode === undefined ? {} : { errorCode }),
        durationMs: Date.now() - startedAt,
      })
    } catch {
      // Logging never changes the public response.
    }
  })
  app.use('/api/*', async (context, next) => {
    const requestId = randomUUID()
    context.set('requestId', requestId)
    setSecurityHeaders(context, requestId)
    const host = context.req.header('host') ?? new URL(context.req.url).host
    if (!allowedHosts.has(host.toLowerCase())) {
      throw new HttpBoundaryError(
        403,
        'HOST_NOT_ALLOWED',
        '请求 Host 不受信任。',
      )
    }

    const origin = context.req.header('origin')
    if (origin !== undefined && options.allowedOrigins.has(origin)) {
      context.header('Access-Control-Allow-Origin', origin)
    }
    const method = context.req.method.toUpperCase()
    const mutating =
      method === 'POST' || method === 'PATCH' || method === 'DELETE'
    if (
      mutating &&
      (origin === undefined || !options.allowedOrigins.has(origin))
    ) {
      throw new HttpBoundaryError(
        403,
        'ORIGIN_NOT_ALLOWED',
        '请求来源不受允许。',
      )
    }
    if (mutating) {
      const contentType = context.req.header('content-type')?.toLowerCase()
      if (contentType?.split(';', 1)[0]?.trim() !== 'application/json') {
        throw new HttpBoundaryError(
          415,
          'UNSUPPORTED_MEDIA_TYPE',
          '修改请求必须使用 application/json。',
        )
      }
    }
    const url = new URL(context.req.url)
    if (
      url.search.length > 0 &&
      !(
        (url.pathname === '/api/hands' ||
          url.pathname === '/api/sessions' ||
          url.pathname === '/api/statistics' ||
          /^\/api\/hands\/[^/]+(?:\/agent-calls)?$/.test(url.pathname) ||
          /^\/api\/agent-runs\/[^/]+\/(?:attempts|capability-invocations)$/.test(
            url.pathname,
          )) &&
        routeLookupMethod(method) === 'GET'
      )
    ) {
      throw new HttpBoundaryError(
        400,
        'INVALID_REQUEST',
        '该接口不接受查询参数。',
      )
    }

    await next()
    const response = context.res
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('X-Content-Type-Options', 'nosniff')
    response.headers.set('Referrer-Policy', 'no-referrer')
    response.headers.set('X-Frame-Options', 'DENY')
    response.headers.set('X-Request-Id', context.get('requestId'))
    appendVaryOrigin(response)
  })

  app.options('/api/*', (context) => {
    const origin = context.req.header('origin')
    const requestedMethod = context.req.header('access-control-request-method')
    if (
      origin === undefined ||
      !options.allowedOrigins.has(origin) ||
      requestedMethod === undefined ||
      !isKnownRoute(
        requestedMethod.toUpperCase(),
        new URL(context.req.url).pathname,
      )
    ) {
      throw new HttpBoundaryError(404, 'ROUTE_NOT_FOUND', '接口不存在。')
    }
    context.header(
      'Access-Control-Allow-Methods',
      requestedMethod.toUpperCase(),
    )
    context.header(
      'Access-Control-Allow-Headers',
      /^\/api\/sessions\/[^/]+\/events$/.test(new URL(context.req.url).pathname)
        ? 'Last-Event-ID'
        : 'Content-Type',
    )
    return context.body(null, 204)
  })

  registerHealthRoutes(app, runtime.health)
  registerProviderSettingsRoutes(app, runtime.providerHealth)
  registerAgentSettingsRoutes(app, runtime.playerAgentSettings)
  registerPersonaRoutes(app, runtime.personaCatalog)
  registerDataRoutes(app, runtime.deletion)
  registerHandHistoryListRoutes(app, runtime.handHistoryList)
  registerHandHistoryRoutes(app, runtime.handHistory)
  registerStatisticsRoutes(app, runtime.statistics)
  registerSessionManagementRoutes(app, runtime.sessionManagement)
  registerAgentCallRoutes(app, runtime.agentCalls)
  registerSessionRoutes(app, runtime.sessionHttp)
  registerSessionEventRoutes(app, runtime.sessionEvents)

  app.notFound((context) =>
    context.json(
      ErrorResponseSchema.parse({
        code: 'ROUTE_NOT_FOUND',
        message: '接口不存在。',
      }),
      404,
    ),
  )
  return app
}
