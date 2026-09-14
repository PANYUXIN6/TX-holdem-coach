import * as C from '@tx-holdem-coach/contracts'
import type { z } from 'zod'
import { ApiError, parseInput, safeFieldPaths } from './errors.js'
import {
  callsSearch,
  encodeQuery,
  historySearch,
  sessionsSearch,
  statisticsSearch,
} from './search.js'

export type RequestOptions = { signal?: AbortSignal }
export function sessionId(input: string) {
  return parseInput(C.SessionPathParamsSchema, {
    sessionId: input,
  }).sessionId.toLowerCase()
}
export function handId(input: string) {
  return parseInput(C.HandHistoryPathParamsSchema, {
    handId: input,
  }).handId.toLowerCase()
}
export function runId(input: string) {
  return parseInput(C.AgentRunPathParamsSchema, {
    runId: input,
  }).runId.toLowerCase()
}
export function personaId(input: string) {
  return parseInput(C.AgentPersonaPathParamsSchema, { personaId: input })
    .personaId
}
const segment = encodeURIComponent
const matches = (actual: string, expected: string) =>
  actual.toLowerCase() === expected
const echoed = (actual: object, expected: object) =>
  Object.entries(expected).every(
    ([key, value]) => Reflect.get(actual, key) === value,
  )

/** 只暴露已安装的具名端点；fetch 注入用于离线协议验收。 */
export function createApi(fetcher: typeof fetch = (...args) => fetch(...args)) {
  async function request<S extends z.ZodType>(
    path: string,
    schema: S,
    options: RequestOptions & {
      method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
      body?: object
      status?: number
      accepts?: (data: z.output<S>) => boolean
      expectedSessionId?: string
    } = {},
  ): Promise<z.output<S>> {
    const { signal } = options
    const cancelled = () => {
      if (signal?.aborted) throw new ApiError('cancelled')
    }
    cancelled()
    let response: Response
    try {
      response = await fetcher(`/api/${path}`, {
        method: options.method ?? 'GET',
        headers: {
          Accept: 'application/json',
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        },
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal: signal ?? null,
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      })
    } catch {
      cancelled()
      throw new ApiError('network')
    }
    cancelled()
    if (
      !/^application\/json(?:\s*;.*)?$/i.test(
        response.headers.get('content-type') ?? '',
      )
    )
      throw new ApiError('protocol', response.status)
    let raw: unknown
    try {
      raw = await response.json()
    } catch {
      cancelled()
      throw new ApiError('protocol', response.status)
    }
    cancelled()
    if (!response.ok) {
      const parsed = C.ErrorResponseSchema.safeParse(raw)
      if (!parsed.success) throw new ApiError('protocol', response.status)
      const error = parsed.data
      if (
        options.expectedSessionId &&
        error.latestSnapshot &&
        !matches(error.latestSnapshot.sessionId, options.expectedSessionId)
      )
        throw new ApiError('protocol', response.status)
      // 未知 code 不携带任意正文进入日志；只保存稳定代码字符集。
      const code = /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code)
        ? error.code
        : 'UNKNOWN_ERROR'
      throw new ApiError(
        'http',
        response.status,
        code,
        safeFieldPaths((error.fieldErrors ?? []).map((field) => field.path)),
        error.latestSnapshot,
      )
    }
    if (response.status !== (options.status ?? 200))
      throw new ApiError('protocol', response.status)
    const parsed = schema.safeParse(raw)
    if (!parsed.success || (options.accepts && !options.accepts(parsed.data)))
      throw new ApiError('protocol', response.status)
    cancelled()
    return parsed.data
  }
  return {
    rosterPreview: (options?: RequestOptions) =>
      request(
        'sessions/roster-preview/latest-ended',
        C.LatestEndedRosterPreviewResponseSchema,
        options,
      ),
    health: (options?: RequestOptions) =>
      request('health', C.HealthResponseSchema, options),
    providers: (options?: RequestOptions) =>
      request('settings/providers', C.ProviderSettingsResponseSchema, options),
    checkProvider(
      provider: C.ProviderPathParams['provider'],
      body: C.ProviderCheckRequest,
      options?: RequestOptions,
    ) {
      const path = parseInput(C.ProviderPathParamsSchema, { provider })
      return request(
        `settings/providers/${segment(path.provider)}/check`,
        C.ProviderSettingsResponseSchema,
        {
          ...options,
          method: 'POST',
          body: parseInput(C.ProviderCheckRequestSchema, body),
        },
      )
    },
    agentSettings: (options?: RequestOptions) =>
      request('settings/agent', C.PlayerAgentSettingsResponseSchema, options),
    updateAgentSettings: (
      body: C.PlayerAgentSettingsPatchRequest,
      options?: RequestOptions,
    ) =>
      request('settings/agent', C.PlayerAgentSettingsResponseSchema, {
        ...options,
        method: 'PATCH',
        body: parseInput(C.PlayerAgentSettingsPatchRequestSchema, body),
      }),
    personas: (options?: RequestOptions) =>
      request('agent-personas', C.AgentPersonaListResponseSchema, options),
    persona(id: string, options?: RequestOptions) {
      const key = personaId(id)
      return request(
        `agent-personas/${segment(key)}`,
        C.AgentPersonaDetailResponseSchema,
        { ...options, accepts: (data) => data.persona.personaId === key },
      )
    },
    sessionAiStatus(id: string, options?: RequestOptions) {
      const key = sessionId(id)
      return request(
        `sessions/${segment(key)}/ai-status`,
        C.SessionAiStatusResponseSchema,
        { ...options, accepts: (data) => matches(data.sessionId, key) },
      )
    },
    activeSession: (options?: RequestOptions) =>
      request('sessions/active', C.SessionSnapshotResponseSchema, options),
    session(id: string, options?: RequestOptions) {
      const key = sessionId(id)
      return request(
        `sessions/${segment(key)}`,
        C.SessionSnapshotResponseSchema,
        {
          ...options,
          expectedSessionId: key,
          accepts: (data) => matches(data.snapshot.sessionId, key),
        },
      )
    },
    createSession: (body: C.CreateSessionRequest, options?: RequestOptions) =>
      request('sessions', C.CreateSessionResponseSchema, {
        ...options,
        method: 'POST',
        status: 201,
        body: parseInput(C.CreateSessionRequestSchema, body),
      }),
    command(id: string, input: C.CommandRequest, options?: RequestOptions) {
      const key = sessionId(id)
      const body = parseInput(C.CommandRequestSchema, input)
      if (
        body.command.sessionId !== key ||
        body.command.commandId !== body.command.commandId.toLowerCase()
      )
        throw new ApiError('input')
      // commandId 与载荷归逻辑操作所有，不在传输层生成或升级版本。
      return request(
        `sessions/${segment(key)}/commands`,
        C.CommandResponseSchema,
        {
          ...options,
          method: 'POST',
          body,
          expectedSessionId: key,
          accepts: (data) => matches(data.snapshot.sessionId, key),
        },
      )
    },
    sessions(input: C.SessionManagementPageRequest, options?: RequestOptions) {
      const page = sessionsSearch.normalize(
        parseInput(C.SessionManagementPageRequestSchema, input),
      )
      return request(
        `sessions${encodeQuery(page.query, page.cursor)}`,
        C.SessionManagementListResponseSchema,
        { ...options, accepts: (data) => echoed(data.query, page.query) },
      )
    },
    deleteSession(
      id: string,
      body: C.DeleteSessionRequest,
      options?: RequestOptions,
    ) {
      const key = sessionId(id)
      return request(
        `sessions/${segment(key)}`,
        C.DeleteSessionResponseSchema,
        {
          ...options,
          method: 'DELETE',
          body: parseInput(C.DeleteSessionRequestSchema, body),
          expectedSessionId: key,
          accepts: (data) => matches(data.deletedSessionId, key),
        },
      )
    },
    clearData: (body: C.ClearDataRequest, options?: RequestOptions) =>
      request('data', C.ClearDataResponseSchema, {
        ...options,
        method: 'DELETE',
        body: parseInput(C.ClearDataRequestSchema, body),
      }),
    hands(input: C.HandHistoryPageRequest, options?: RequestOptions) {
      const page = historySearch.normalize(
        parseInput(C.HandHistoryPageRequestSchema, input),
      )
      return request(
        `hands${encodeQuery(page.query, page.cursor)}`,
        C.HandHistoryListResponseSchema,
        options,
      )
    },
    hand(
      id: string,
      input: C.HandHistoryQuery = { view: 'public' },
      options?: RequestOptions,
    ) {
      const key = handId(id)
      const query = parseInput(C.HandHistoryQuerySchema, input)
      return request(
        `hands/${segment(key)}${encodeQuery(query)}`,
        C.HandHistoryResponseSchema,
        {
          ...options,
          accepts: (data) =>
            matches(data.history.handId, key) && data.view === query.view,
        },
      )
    },
    statistics(input: C.StatisticsQuery, options?: RequestOptions) {
      const query = statisticsSearch.normalize(input)
      return request(
        `statistics${encodeQuery(query)}`,
        C.StatisticsResponseSchema,
        { ...options, accepts: (data) => echoed(data.query, query) },
      )
    },
    handCalls(
      id: string,
      input: C.AgentCallPageRequest,
      options?: RequestOptions,
    ) {
      const key = handId(id)
      const page = callsSearch.normalize(
        parseInput(C.AgentCallPageRequestSchema, input),
      )
      return request(
        `hands/${segment(key)}/agent-calls${encodeQuery(page.query, page.cursor)}`,
        C.HandAgentCallsResponseSchema,
        {
          ...options,
          accepts: (data) =>
            matches(data.hand.handId, key) && echoed(data.query, page.query),
        },
      )
    },
    run(id: string, options?: RequestOptions) {
      const key = runId(id)
      return request(
        `agent-runs/${segment(key)}`,
        C.AgentRunDetailResponseSchema,
        { ...options, accepts: (data) => matches(data.runId, key) },
      )
    },
    attempts(
      id: string,
      input: C.AgentCallPageRequest,
      options?: RequestOptions,
    ) {
      const key = runId(id)
      const page = callsSearch.normalize(
        parseInput(C.AgentCallPageRequestSchema, input),
      )
      return request(
        `agent-runs/${segment(key)}/attempts${encodeQuery(page.query, page.cursor)}`,
        C.AgentRunAttemptsResponseSchema,
        {
          ...options,
          accepts: (data) =>
            matches(data.runId, key) && echoed(data.query, page.query),
        },
      )
    },
    capabilities(
      id: string,
      input: C.AgentCallPageRequest,
      options?: RequestOptions,
    ) {
      const key = runId(id)
      const page = callsSearch.normalize(
        parseInput(C.AgentCallPageRequestSchema, input),
      )
      return request(
        `agent-runs/${segment(key)}/capability-invocations${encodeQuery(page.query, page.cursor)}`,
        C.AgentRunCapabilityInvocationsResponseSchema,
        {
          ...options,
          accepts: (data) =>
            matches(data.runId, key) && echoed(data.query, page.query),
        },
      )
    },
  }
}
export type Api = ReturnType<typeof createApi>
export const api = createApi()
