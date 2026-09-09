import { z } from 'zod'

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/
const TimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
  .refine((value) => {
    const milliseconds = `${value.slice(0, 23)}Z`
    const parsed = new Date(milliseconds)
    return (
      !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === milliseconds
    )
  })
export type AgentCallCursorKind =
  'handAgentRuns' | 'runAttempts' | 'runCapabilityInvocations'

export type AgentCallCursorAfter =
  | { readonly createdAt: string; readonly id: string }
  | { readonly sequence: number }

export interface NormalizedAgentCallListQuery {
  readonly limit: number
  readonly after: AgentCallCursorAfter | null
}

export class AgentCallQueryInvariantError extends Error {
  public constructor() {
    super('Agent 调用查询输入无效。')
    this.name = 'AgentCallQueryInvariantError'
  }
}

function invalid(): never {
  throw new AgentCallQueryInvariantError()
}

function parseAfter(kind: AgentCallCursorKind, value: unknown) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid()
  }
  if (kind === 'handAgentRuns') {
    const parsed = z
      .strictObject({ createdAt: TimestampSchema, id: z.uuid() })
      .safeParse(value)
    if (!parsed.success || parsed.data.id !== parsed.data.id.toLowerCase()) {
      return invalid()
    }
    return parsed.data
  }
  const parsed = z
    .strictObject({
      sequence: z.number().int().nonnegative().max(2_147_483_647),
    })
    .safeParse(value)
  if (!parsed.success) return invalid()
  return parsed.data
}

export function encodeAgentCallCursor(input: {
  readonly kind: AgentCallCursorKind
  readonly parentId: string
  readonly after: AgentCallCursorAfter
}): string {
  try {
    const parentId = z.uuid().parse(input.parentId)
    if (parentId !== parentId.toLowerCase()) return invalid()
    const after = parseAfter(input.kind, input.after)
    return Buffer.from(
      JSON.stringify({
        kind: input.kind,
        version: 1,
        parentId,
        after,
      }),
      'utf8',
    ).toString('base64url')
  } catch (error) {
    if (error instanceof AgentCallQueryInvariantError) throw error
    return invalid()
  }
}

function decodeCursor(
  value: string,
  expectedKind: AgentCallCursorKind,
  expectedParentId: string,
): AgentCallCursorAfter {
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
    const object = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as unknown
    if (
      typeof object !== 'object' ||
      object === null ||
      Array.isArray(object)
    ) {
      return invalid()
    }
    const cursor = object as Record<string, unknown>
    if (
      Object.keys(cursor).length !== 4 ||
      cursor.kind !== expectedKind ||
      cursor.version !== 1 ||
      cursor.parentId !== expectedParentId
    ) {
      return invalid()
    }
    return parseAfter(expectedKind, cursor.after)
  } catch (error) {
    if (error instanceof AgentCallQueryInvariantError) throw error
    return invalid()
  }
}

export function normalizeAgentCallListQuery(
  parameters: URLSearchParams,
  kind: AgentCallCursorKind,
  parentId: string,
): NormalizedAgentCallListQuery {
  try {
    const parsedParent = z.uuid().parse(parentId)
    if (parsedParent !== parsedParent.toLowerCase()) return invalid()
    const values = new Map<string, string>()
    for (const [key, value] of parameters) {
      if (
        (key !== 'limit' && key !== 'cursor') ||
        value.length === 0 ||
        values.has(key)
      ) {
        return invalid()
      }
      values.set(key, value)
    }
    const rawLimit = values.get('limit')
    const limit = rawLimit === undefined ? 20 : Number(rawLimit)
    if (
      rawLimit !== undefined &&
      (!POSITIVE_INTEGER_PATTERN.test(rawLimit) ||
        !Number.isSafeInteger(limit) ||
        limit > 100)
    ) {
      return invalid()
    }
    const cursor = values.get('cursor')
    return {
      limit,
      after:
        cursor === undefined ? null : decodeCursor(cursor, kind, parsedParent),
    }
  } catch (error) {
    if (error instanceof AgentCallQueryInvariantError) throw error
    return invalid()
  }
}
