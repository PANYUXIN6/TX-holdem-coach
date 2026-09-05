import {
  HandHistoryListQuerySchema,
  HandHistoryListResponseSchema,
  type HandHistoryListResponse,
} from '@tx-holdem-coach/contracts'
import { z } from 'zod'
import type { CompletedHandHistoryListFactsReader } from './completed-hand-history-list.js'
import {
  encodeHandHistoryListCursor,
  type CompletedHandHistoryListQuery,
} from './completed-hand-history-list-query.js'
import { CompletedHandHistoryInvariantError } from './errors.js'
import { projectCompletedHandHistoryListItem } from './completed-hand-history-list-view-projector.js'

const CursorAfterSchema = z
  .strictObject({
    startedAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
    handId: z.uuid(),
  })
  .nullable()

function parseListQuery(query: unknown): CompletedHandHistoryListQuery {
  if (typeof query !== 'object' || query === null || Array.isArray(query)) {
    throw new CompletedHandHistoryInvariantError()
  }
  const rawQuery = query as Record<string, unknown>
  const { after, ...filters } = rawQuery
  const parsedFilters = HandHistoryListQuerySchema.safeParse(filters)
  const parsedAfter = CursorAfterSchema.safeParse(after)
  if (!parsedFilters.success || !parsedAfter.success) {
    throw new CompletedHandHistoryInvariantError()
  }
  return { ...parsedFilters.data, after: parsedAfter.data }
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const nestedValue of Object.values(value)) deepFreeze(nestedValue)
    Object.freeze(value)
  }
  return value
}

export interface CompletedHandHistoryListQueryService {
  list(query: CompletedHandHistoryListQuery): Promise<HandHistoryListResponse>
}

export function createCompletedHandHistoryListQueryService(input: {
  readonly reader: CompletedHandHistoryListFactsReader
}): CompletedHandHistoryListQueryService {
  if (typeof input.reader?.listCompletedHandHistoryFacts !== 'function') {
    throw new CompletedHandHistoryInvariantError()
  }
  return Object.freeze({
    async list(query: CompletedHandHistoryListQuery) {
      const parsed = parseListQuery(query)
      const facts = await input.reader.listCompletedHandHistoryFacts(parsed)
      if (facts.length > parsed.limit + 1) {
        throw new CompletedHandHistoryInvariantError()
      }
      const returnedFacts = facts.slice(0, parsed.limit)
      const lastReturned = returnedFacts.at(-1)
      const response = HandHistoryListResponseSchema.safeParse({
        items: returnedFacts.map(projectCompletedHandHistoryListItem),
        nextCursor:
          facts.length > parsed.limit && lastReturned !== undefined
            ? encodeHandHistoryListCursor({
                query: parsed,
                after: {
                  startedAt: lastReturned.startedAt,
                  handId: lastReturned.handId,
                },
              })
            : null,
      })
      if (!response.success) throw new CompletedHandHistoryInvariantError()
      return deepFreeze(response.data)
    },
  })
}
