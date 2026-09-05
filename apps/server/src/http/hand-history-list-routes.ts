import { HandHistoryListResponseSchema } from '@tx-holdem-coach/contracts'
import { normalizeHandHistoryListQuery } from '../sessions/hand-history/completed-hand-history-list-query.js'
import type { CompletedHandHistoryListQueryService } from '../sessions/hand-history/completed-hand-history-list-query-service.js'
import { CompletedHandHistoryInvariantError } from '../sessions/hand-history/errors.js'
import type { ApiHono } from './api-context.js'
import { HttpBoundaryError } from './request-boundary.js'
import { jsonResponse } from './response.js'

const QUERY_BYTE_LIMIT = 8_192

function parseQuery(url: string) {
  const parsed = new URL(url)
  if (new TextEncoder().encode(parsed.search).byteLength > QUERY_BYTE_LIMIT) {
    throw new HttpBoundaryError(400, 'INVALID_REQUEST', '请求参数无效。')
  }
  try {
    return normalizeHandHistoryListQuery(parsed.searchParams)
  } catch (error) {
    if (error instanceof CompletedHandHistoryInvariantError) {
      throw new HttpBoundaryError(400, 'INVALID_REQUEST', '请求参数无效。')
    }
    throw error
  }
}

export function registerHandHistoryListRoutes(
  app: ApiHono,
  handHistoryList: CompletedHandHistoryListQueryService,
): void {
  app.get('/api/hands', async (context) =>
    jsonResponse(
      context,
      HandHistoryListResponseSchema,
      await handHistoryList.list(parseQuery(context.req.url)),
    ),
  )
}
