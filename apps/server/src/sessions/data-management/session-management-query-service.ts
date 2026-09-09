import {
  SessionManagementListQuerySchema,
  SessionManagementListResponseSchema,
  type SessionManagementListResponse,
} from '@tx-holdem-coach/contracts'
import type { SessionManagementFactsReader } from './session-management.js'
import {
  encodeSessionManagementCursor,
  type NormalizedSessionManagementQuery,
} from './session-management-query.js'
import { SessionManagementInvariantError } from './errors.js'
import { projectSessionManagementItem } from './session-management-projector.js'

function invalid(): never {
  throw new SessionManagementInvariantError()
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

export interface SessionManagementQueryService {
  list(
    query: NormalizedSessionManagementQuery,
  ): Promise<SessionManagementListResponse>
}

export function createSessionManagementQueryService(input: {
  readonly reader: SessionManagementFactsReader
}): SessionManagementQueryService {
  return Object.freeze({
    async list(query: NormalizedSessionManagementQuery) {
      const { after, ...publicQuery } = query
      if (
        !SessionManagementListQuerySchema.safeParse(publicQuery).success ||
        (after !== null &&
          (typeof after !== 'object' ||
            typeof after.createdAt !== 'string' ||
            typeof after.sessionId !== 'string'))
      ) {
        return invalid()
      }
      const page = await input.reader.listSessionManagementFacts(query)
      if (
        page.items.length > query.limit ||
        (page.hasMore && page.items.length === 0)
      ) {
        return invalid()
      }
      const last = page.items.at(-1)
      const parsed = SessionManagementListResponseSchema.safeParse({
        query: publicQuery,
        timeBasis: 'sessionCreatedAt',
        items: page.items.map(projectSessionManagementItem),
        nextCursor:
          page.hasMore && last !== undefined
            ? encodeSessionManagementCursor({
                query,
                after: {
                  createdAt: last.createdAt,
                  sessionId: last.sessionId,
                },
              })
            : null,
      })
      if (!parsed.success) return invalid()
      return deepFreeze(parsed.data)
    },
  })
}
