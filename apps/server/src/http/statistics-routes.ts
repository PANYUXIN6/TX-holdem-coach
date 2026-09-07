import { StatisticsResponseSchema } from '@tx-holdem-coach/contracts'
import { normalizeStatisticsQuery } from '../sessions/statistics/statistics-query.js'
import type { StatisticsQueryService } from '../sessions/statistics/statistics-query-service.js'
import { StatisticsInvariantError } from '../sessions/statistics/errors.js'
import type { ApiHono } from './api-context.js'
import { HttpBoundaryError } from './request-boundary.js'
import { jsonResponse } from './response.js'

const QUERY_BYTE_LIMIT = 8_192

function assertQueryEncodingIsValid(search: string): void {
  try {
    decodeURIComponent(search)
  } catch {
    throw new HttpBoundaryError(400, 'INVALID_REQUEST', '请求参数无效。')
  }
}

function parseQuery(url: string) {
  const parsed = new URL(url)
  if (new TextEncoder().encode(parsed.search).byteLength > QUERY_BYTE_LIMIT) {
    throw new HttpBoundaryError(400, 'INVALID_REQUEST', '请求参数无效。')
  }
  assertQueryEncodingIsValid(parsed.search)
  try {
    return normalizeStatisticsQuery(parsed.searchParams)
  } catch (error) {
    if (error instanceof StatisticsInvariantError) {
      throw new HttpBoundaryError(400, 'INVALID_REQUEST', '请求参数无效。')
    }
    throw error
  }
}

export function registerStatisticsRoutes(
  app: ApiHono,
  statistics: StatisticsQueryService,
): void {
  app.get('/api/statistics', async (context) =>
    jsonResponse(
      context,
      StatisticsResponseSchema,
      await statistics.read(parseQuery(context.req.url)),
    ),
  )
}
