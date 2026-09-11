import * as C from '@tx-holdem-coach/contracts'
import type { z } from 'zod'
import { ApiError, parseInput } from './errors.js'

const historyDefaults = {
  from: null,
  to: null,
  sessionId: null,
  position: null,
  result: null,
  startingHand: null,
  personaId: null,
  personaVersion: null,
  personaName: null,
  configSnapshotKey: null,
  sort: 'newest',
  limit: 20,
}
const sessionDefaults = {
  lifecycle: 'all',
  from: null,
  to: null,
  sort: 'newest',
  limit: 20,
}
const statisticsDefaults = {
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
}

function budget(search: string) {
  if (
    new TextEncoder().encode(search.startsWith('?') ? search : `?${search}`)
      .byteLength > 8192
  )
    throw new ApiError('input')
}
function decode(
  search: string,
  defaults: Record<string, unknown>,
  paged: boolean,
) {
  budget(search)
  const params = new URLSearchParams(search)
  const values = { ...defaults }
  const seen = new Set<string>()
  let cursor: string | null = null
  for (const [key, raw] of params) {
    if (
      seen.has(key) ||
      raw === '' ||
      (!Object.hasOwn(defaults, key) && !(paged && key === 'cursor'))
    )
      throw new ApiError('input')
    seen.add(key)
    if (key === 'cursor') {
      cursor = parseInput(C.OpaquePageCursorSchema, raw)
      continue
    }
    if (key === 'limit' || key === 'personaVersion') {
      if (!/^[1-9]\d*$/.test(raw)) throw new ApiError('input')
      values[key] = Number(raw)
    } else if (key === 'from' || key === 'to') {
      const match =
        /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(raw)
      if (!match) throw new ApiError('input')
      values[key] = `${match[1]}.${(match[2] ?? '').padEnd(6, '0')}Z`
    } else values[key] = raw
  }
  return { values, cursor }
}
function normalized<S extends z.ZodType>(
  schema: S,
  input: unknown,
): z.output<S> {
  // 先认证 UUID，再规范化；不改写人物名称或微秒时间戳。
  const value = parseInput(schema, input)
  if (typeof value === 'object' && value !== null) {
    if ('sessionId' in value && typeof value.sessionId === 'string')
      value.sessionId = value.sessionId.toLowerCase()
    for (const key of ['personaName', 'personaId']) {
      const field: unknown = Reflect.get(value, key)
      if (typeof field === 'string' && field.trim() === '')
        throw new ApiError('input')
    }
  }
  return value
}
export function encodeQuery(query: object, cursor?: string | null) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query))
    if (value !== null && value !== undefined) params.set(key, String(value))
  if (cursor !== null && cursor !== undefined)
    params.set('cursor', parseInput(C.OpaquePageCursorSchema, cursor))
  const search = params.toString()
  budget(search)
  return search ? `?${search}` : ''
}
function pageCodec<S extends z.ZodType>(
  schema: S,
  defaults: Record<string, unknown>,
) {
  return {
    decode(search: string) {
      const { values, cursor } = decode(search, defaults, true)
      return { query: normalized(schema, values), cursor }
    },
    normalize(input: { query: z.input<S>; cursor: string | null }) {
      return {
        query: normalized(schema, input.query),
        cursor: parseInput(C.OpaquePageCursorSchema.nullable(), input.cursor),
      }
    },
    encode(input: { query: z.input<S>; cursor: string | null }) {
      return encodeQuery(
        normalized(schema, input.query) as object,
        input.cursor,
      )
    },
  }
}
export const historySearch = pageCodec(
  C.HandHistoryListQuerySchema,
  historyDefaults,
)
export const sessionsSearch = pageCodec(
  C.SessionManagementListQuerySchema,
  sessionDefaults,
)
export const callsSearch = pageCodec(C.AgentCallListQuerySchema, { limit: 20 })
export const handSearch = {
  decode(search: string) {
    return parseInput(
      C.HandHistoryQuerySchema,
      decode(search, { view: 'public' }, false).values,
    )
  },
  encode(input: C.HandHistoryQuery) {
    return encodeQuery(parseInput(C.HandHistoryQuerySchema, input))
  },
}
export const statisticsSearch = {
  normalize(input: C.StatisticsQuery) {
    return normalized(C.StatisticsQuerySchema, input)
  },
  decode(search: string) {
    const defaults: Record<string, unknown> = { ...statisticsDefaults }
    if (new URLSearchParams(search).get('scope') === 'sessions')
      delete defaults.position
    return normalized(
      C.StatisticsQuerySchema,
      decode(search, defaults, false).values,
    )
  },
  encode(input: C.StatisticsQuery) {
    return encodeQuery(normalized(C.StatisticsQuerySchema, input))
  },
}
