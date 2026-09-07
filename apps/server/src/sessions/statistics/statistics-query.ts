import {
  StatisticsQuerySchema,
  type StatisticsQuery,
} from '@tx-holdem-coach/contracts'
import { z } from 'zod'
import { StatisticsInvariantError } from './errors.js'

const QUERY_KEYS = new Set([
  'scope',
  'subject',
  'from',
  'to',
  'sessionId',
  'position',
  'personaId',
  'personaVersion',
  'personaName',
  'configSnapshotKey',
  'groupBy',
])
const UTC_TIMESTAMP_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/
const DECIMAL_POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/

function invalid(): never {
  throw new StatisticsInvariantError()
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

function parseOptionalTimestamp(value: string | undefined): string | null {
  return value === undefined ? null : parseCanonicalTimestamp(value)
}

function parseOptionalUuid(value: string | undefined): string | null {
  if (value === undefined) return null
  if (!z.uuid().safeParse(value).success) return invalid()
  return value.toLowerCase()
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

export function normalizeStatisticsQuery(
  parameters: URLSearchParams,
): StatisticsQuery {
  try {
    const values = parseEntries(parameters)
    const scope = values.get('scope') ?? 'hands'
    const shared = {
      subject: values.get('subject') ?? 'user',
      from: parseOptionalTimestamp(values.get('from')),
      to: parseOptionalTimestamp(values.get('to')),
      sessionId: parseOptionalUuid(values.get('sessionId')),
      personaId: parseOptionalString(values.get('personaId'), 128),
      personaVersion: parseOptionalPersonaVersion(values.get('personaVersion')),
      personaName: parseOptionalString(values.get('personaName'), 256),
      configSnapshotKey: values.get('configSnapshotKey') ?? null,
    }
    const query =
      scope === 'hands'
        ? {
            scope,
            ...shared,
            position: values.get('position') ?? null,
            groupBy: values.get('groupBy') ?? 'none',
          }
        : scope === 'sessions'
          ? values.has('position') || values.get('groupBy') === 'position'
            ? invalid()
            : { scope, ...shared, groupBy: values.get('groupBy') ?? 'none' }
          : invalid()
    const parsed = StatisticsQuerySchema.safeParse(query)
    if (!parsed.success) return invalid()
    return parsed.data
  } catch (error) {
    if (error instanceof StatisticsInvariantError) throw error
    return invalid()
  }
}
