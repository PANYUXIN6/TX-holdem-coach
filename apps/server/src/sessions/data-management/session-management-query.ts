import {
  SessionManagementListQuerySchema,
  type SessionManagementListQuery,
} from '@tx-holdem-coach/contracts'
import { z } from 'zod'
import { SessionManagementInvariantError } from './errors.js'

const QUERY_KEYS = new Set([
  'lifecycle',
  'from',
  'to',
  'sort',
  'limit',
  'cursor',
])
const UTC_TIMESTAMP_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/
const CANONICAL_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

type CursorQuery = Omit<SessionManagementListQuery, 'limit'>

export interface NormalizedSessionManagementQuery extends SessionManagementListQuery {
  readonly after: {
    readonly createdAt: string
    readonly sessionId: string
  } | null
}

export interface SessionManagementCursor {
  readonly query: CursorQuery
  readonly after: {
    readonly createdAt: string
    readonly sessionId: string
  }
}

function invalid(): never {
  throw new SessionManagementInvariantError()
}

function canonicalTimestamp(value: string): string {
  const match = UTC_TIMESTAMP_PATTERN.exec(value)
  const datePart = match?.[1]
  if (datePart === undefined) return invalid()
  const microseconds = (match?.[2] ?? '').padEnd(6, '0')
  const date = new Date(`${datePart}.${microseconds.slice(0, 3)}Z`)
  if (
    Number.isNaN(date.valueOf()) ||
    date.toISOString().slice(0, 19) !== datePart
  ) {
    return invalid()
  }
  return `${datePart}.${microseconds}Z`
}

function isCanonicalTimestamp(value: string): boolean {
  return (
    CANONICAL_TIMESTAMP_PATTERN.test(value) &&
    canonicalTimestamp(value) === value
  )
}

function queryWithoutLimit(query: SessionManagementListQuery): CursorQuery {
  const { limit: _limit, ...rest } = query
  return rest
}

function sameQuery(left: CursorQuery, right: CursorQuery): boolean {
  return (
    left.lifecycle === right.lifecycle &&
    left.from === right.from &&
    left.to === right.to &&
    left.sort === right.sort
  )
}

function parseCursor(value: unknown): SessionManagementCursor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid()
  }
  const object = value as Record<string, unknown>
  if (
    Object.keys(object).length !== 4 ||
    object.kind !== 'sessionList' ||
    object.version !== 1 ||
    typeof object.query !== 'object' ||
    object.query === null ||
    Array.isArray(object.query) ||
    typeof object.after !== 'object' ||
    object.after === null ||
    Array.isArray(object.after)
  ) {
    return invalid()
  }
  const rawQuery = object.query as Record<string, unknown>
  if ('limit' in rawQuery) return invalid()
  const parsedQuery = SessionManagementListQuerySchema.safeParse({
    ...rawQuery,
    limit: 1,
  })
  const after = object.after as Record<string, unknown>
  if (
    !parsedQuery.success ||
    Object.keys(after).length !== 2 ||
    typeof after.createdAt !== 'string' ||
    !isCanonicalTimestamp(after.createdAt)
  ) {
    return invalid()
  }
  const sessionId = after.sessionId
  if (
    typeof sessionId !== 'string' ||
    !z.uuid().safeParse(sessionId).success ||
    sessionId !== sessionId.toLowerCase()
  ) {
    return invalid()
  }
  const query = queryWithoutLimit(parsedQuery.data)
  if (
    (query.from !== null && after.createdAt < query.from) ||
    (query.to !== null && after.createdAt >= query.to)
  ) {
    return invalid()
  }
  return { query, after: { createdAt: after.createdAt, sessionId } }
}

export function encodeSessionManagementCursor(input: {
  readonly query: SessionManagementListQuery
  readonly after: SessionManagementCursor['after']
}): string {
  try {
    const { after: _after, ...rawQuery } =
      input.query as SessionManagementListQuery & {
        readonly after?: unknown
      }
    const parsed = SessionManagementListQuerySchema.parse(rawQuery)
    const cursor = parseCursor({
      kind: 'sessionList',
      version: 1,
      query: queryWithoutLimit(parsed),
      after: input.after,
    })
    return Buffer.from(
      JSON.stringify({ kind: 'sessionList', version: 1, ...cursor }),
      'utf8',
    ).toString('base64url')
  } catch (error) {
    if (error instanceof SessionManagementInvariantError) throw error
    return invalid()
  }
}

export function decodeSessionManagementCursor(
  value: string,
): SessionManagementCursor {
  try {
    if (
      value.length === 0 ||
      value.length > 4096 ||
      !BASE64URL_PATTERN.test(value)
    ) {
      return invalid()
    }
    const bytes = Buffer.from(value, 'base64url')
    if (bytes.toString('base64url') !== value) return invalid()
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return parseCursor(JSON.parse(text))
  } catch (error) {
    if (error instanceof SessionManagementInvariantError) throw error
    return invalid()
  }
}

export function normalizeSessionManagementQuery(
  parameters: URLSearchParams,
): NormalizedSessionManagementQuery {
  try {
    const values = new Map<string, string>()
    for (const [name, value] of parameters) {
      if (!QUERY_KEYS.has(name) || value.length === 0 || values.has(name)) {
        return invalid()
      }
      values.set(name, value)
    }
    const limitRaw = values.get('limit')
    const limit = limitRaw === undefined ? 20 : Number(limitRaw)
    if (
      limitRaw !== undefined &&
      (!POSITIVE_INTEGER_PATTERN.test(limitRaw) ||
        !Number.isSafeInteger(limit) ||
        limit > 100)
    ) {
      return invalid()
    }
    const query = SessionManagementListQuerySchema.parse({
      lifecycle: values.get('lifecycle') ?? 'all',
      from:
        values.get('from') === undefined
          ? null
          : canonicalTimestamp(values.get('from')!),
      to:
        values.get('to') === undefined
          ? null
          : canonicalTimestamp(values.get('to')!),
      sort: values.get('sort') ?? 'newest',
      limit,
    })
    const encodedCursor = values.get('cursor')
    if (encodedCursor === undefined) return { ...query, after: null }
    const cursor = decodeSessionManagementCursor(encodedCursor)
    if (!sameQuery(cursor.query, queryWithoutLimit(query))) return invalid()
    return { ...query, after: cursor.after }
  } catch (error) {
    if (error instanceof SessionManagementInvariantError) throw error
    return invalid()
  }
}
