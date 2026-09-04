import {
  HandHistoryPathParamsSchema,
  HandHistoryQuerySchema,
  HandHistoryResponseSchema,
} from '@tx-holdem-coach/contracts'
import type { CompletedHandHistoryQueryService } from '../sessions/hand-history/completed-hand-history-query-service.js'
import type { ApiHono } from './api-context.js'
import { HttpBoundaryError, parseInput } from './request-boundary.js'
import { jsonResponse } from './response.js'

function parseQuery(url: string) {
  const entries = [...new URL(url).searchParams.entries()]
  if (entries.length > 1 || entries.some(([name]) => name !== 'view')) {
    throw new HttpBoundaryError(400, 'INVALID_REQUEST', '请求参数无效。')
  }
  return parseInput(
    HandHistoryQuerySchema,
    entries.length === 0 ? {} : { view: entries[0]![1] },
  )
}

export function registerHandHistoryRoutes(
  app: ApiHono,
  handHistory: CompletedHandHistoryQueryService,
): void {
  app.get('/api/hands/:handId', async (context) => {
    const { handId } = parseInput(
      HandHistoryPathParamsSchema,
      context.req.param(),
    )
    const { view } = parseQuery(context.req.url)
    const response = await handHistory.read({ handId, view })
    if (response === null) {
      throw new HttpBoundaryError(404, 'HAND_NOT_FOUND', '手牌不存在。')
    }
    return jsonResponse(context, HandHistoryResponseSchema, response)
  })
}
