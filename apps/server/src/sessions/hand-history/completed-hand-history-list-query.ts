import {
  HandHistoryListQuerySchema,
  type HandHistoryListQuery,
} from '@tx-holdem-coach/contracts'
import { z } from 'zod'
import { CompletedHandHistoryInvariantError } from './errors.js'

const QUERY_KEYS = new Set([
  'from',
  'to',
  'sessionId',
  'position',
  'result',
  'startingHand',
  'personaId',
  'personaVersion',
  'personaName',
  'configSnapshotKey',
  'sort',
  'limit',
  'cursor',
])
const UTC_TIMESTAMP_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/
const CANONICAL_UTC_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/
const DECIMAL_POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

type CursorQuery = Omit<HandHistoryListQuery, 'limit'>

export interface CompletedHandHistoryListQuery extends HandHistoryListQuery {
  readonly after: {
    readonly startedAt: string
    readonly handId: string
  } | null
}

export interface HandHistoryListCursor {
  readonly query: CursorQuery
  readonly after: {
    readonly startedAt: string
    readonly handId: string
  }
}

function invalid(): never {
  throw new CompletedHandHistoryInvariantError()
}

function parseCanonicalTimestamp(value: string): string {
  const match = UTC_TIMESTAMP_PATTERN.exec(value)
  if (match === null) return invalid()
  const datePart = match[1]
  if (datePart === undefined) return invalid()
  const microseconds = (match[2] ?? '').padEnd(6, '0')
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
    CANONICAL_UTC_TIMESTAMP_PATTERN.test(value) &&
    parseCanonicalTimestamp(value) === value
  )
}

function parseOptionalTimestamp(value: string | undefined): string | null {
  return value === undefined ? null : parseCanonicalTimestamp(value)
}

function parseOptionalUuid(value: string | undefined): string | null {
  if (value === undefined) return null
  if (!z.uuid().safeParse(value).success) return invalid()
  return value.toLowerCase()
}

function isLowercaseUuid(value: string): boolean {
  return z.uuid().safeParse(value).success && value === value.toLowerCase()
}

function parseOptionalString(
  value: string | undefined,
  maximumLength: number,
): string | null {
  if (value === undefined) return null
  if (
    value.length === 0 ||
    value.length > maximumLength ||
    value.trim().length === 0
  ) {
    return invalid()
  }
  return value
}

function parseOptionalPersonaVersion(value: string | undefined): number | null {
  if (value === undefined) return null
  if (!DECIMAL_POSITIVE_INTEGER_PATTERN.test(value)) return invalid()
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed > 2_147_483_647) return invalid()
  return parsed
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 20
  if (!DECIMAL_POSITIVE_INTEGER_PATTERN.test(value)) return invalid()
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed > 100) return invalid()
  return parsed
}

function parseEntries(
  parameters: URLSearchParams,
): ReadonlyMap<string, string> {
  const values = new Map<string, string>()
  for (const [name, value] of parameters.entries()) {
    if (!QUERY_KEYS.has(name) || value.length === 0 || values.has(name)) {
      return invalid()
    }
    values.set(name, value)
  }
  return values
}

function cursorQuery(query: HandHistoryListQuery): CursorQuery {
  const { limit: _limit, ...filters } = query
  return filters
}

function sameCursorQuery(left: CursorQuery, right: CursorQuery): boolean {
  return (
    left.from === right.from &&
    left.to === right.to &&
    left.sessionId === right.sessionId &&
    left.position === right.position &&
    left.result === right.result &&
    left.startingHand === right.startingHand &&
    left.personaId === right.personaId &&
    left.personaVersion === right.personaVersion &&
    left.personaName === right.personaName &&
    left.configSnapshotKey === right.configSnapshotKey &&
    left.sort === right.sort
  )
}

function assertCursorRange(cursor: HandHistoryListCursor): void {
  const { from, to } = cursor.query
  if (
    (from !== null && cursor.after.startedAt < from) ||
    (to !== null && cursor.after.startedAt >= to)
  ) {
    invalid()
  }
}

function parseCursorQuery(value: unknown): CursorQuery {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid()
  }
  const rawQuery = value as Record<string, unknown>
  if ('limit' in rawQuery) return invalid()
  const parsed = HandHistoryListQuerySchema.safeParse({
    ...rawQuery,
    limit: 1,
  })
  if (!parsed.success) return invalid()
  const query = cursorQuery(parsed.data)
  for (const timestamp of [query.from, query.to]) {
    if (timestamp !== null && !isCanonicalTimestamp(timestamp)) return invalid()
  }
  if (query.sessionId !== null && !isLowercaseUuid(query.sessionId)) {
    return invalid()
  }
  return query
}

function parseCursor(value: unknown): HandHistoryListCursor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid()
  }
  const object = value as Record<string, unknown>
  if (
    Object.keys(object).length !== 3 ||
    object.version !== 1 ||
    !('query' in object) ||
    !('after' in object)
  ) {
    return invalid()
  }
  const query = parseCursorQuery(object.query)
  if (
    typeof object.after !== 'object' ||
    object.after === null ||
    Array.isArray(object.after) ||
    Object.keys(object.after).length !== 2
  ) {
    return invalid()
  }
  const after = object.after as Record<string, unknown>
  if (
    typeof after.startedAt !== 'string' ||
    !isCanonicalTimestamp(after.startedAt) ||
    typeof after.handId !== 'string' ||
    !isLowercaseUuid(after.handId)
  ) {
    return invalid()
  }
  const cursor = {
    query,
    after: { startedAt: after.startedAt, handId: after.handId },
  }
  assertCursorRange(cursor)
  return cursor
}

export function encodeHandHistoryListCursor(input: {
  readonly query: HandHistoryListQuery
  readonly after: HandHistoryListCursor['after']
}): string {
  try {
    const { after: _after, ...rawQuery } =
      input.query as HandHistoryListQuery & {
        readonly after?: unknown
      }
    const query = HandHistoryListQuerySchema.parse(rawQuery)
    const cursor = parseCursor({
      version: 1,
      query: cursorQuery(query),
      after: input.after,
    })
    return Buffer.from(
      JSON.stringify({ version: 1, ...cursor }),
      'utf8',
    ).toString('base64url')
  } catch {
    return invalid()
  }
}

export function decodeHandHistoryListCursor(
  value: string,
): HandHistoryListCursor {
  try {
    if (
      value.length === 0 ||
      value.length > 4096 ||
      !BASE64URL_PATTERN.test(value)
    ) {
      return invalid()
    }
    const decoded = Buffer.from(value, 'base64url')
    if (decoded.toString('base64url') !== value) return invalid()
    const text = new TextDecoder('utf-8', { fatal: true }).decode(decoded)
    return parseCursor(JSON.parse(text))
  } catch {
    return invalid()
  }
}

export function normalizeHandHistoryListQuery(
  parameters: URLSearchParams,
): CompletedHandHistoryListQuery {
  try {
    const values = parseEntries(parameters)
    const personaId = parseOptionalString(values.get('personaId'), 128)
    const query = HandHistoryListQuerySchema.parse({
      from: parseOptionalTimestamp(values.get('from')),
      to: parseOptionalTimestamp(values.get('to')),
      sessionId: parseOptionalUuid(values.get('sessionId')),
      position: values.get('position') ?? null,
      result: values.get('result') ?? null,
      startingHand: values.get('startingHand') ?? null,
      personaId,
      personaVersion: parseOptionalPersonaVersion(values.get('personaVersion')),
      personaName: parseOptionalString(values.get('personaName'), 256),
      configSnapshotKey: values.get('configSnapshotKey') ?? null,
      sort: values.get('sort') ?? 'newest',
      limit: parseLimit(values.get('limit')),
    })
    const cursorValue = values.get('cursor')
    if (cursorValue === undefined) return { ...query, after: null }
    const cursor = decodeHandHistoryListCursor(cursorValue)
    if (!sameCursorQuery(cursor.query, cursorQuery(query))) return invalid()
    return { ...query, after: cursor.after }
  } catch (error) {
    if (error instanceof CompletedHandHistoryInvariantError) throw error
    return invalid()
  }
}
