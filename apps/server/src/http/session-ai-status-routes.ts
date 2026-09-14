import {
  SessionAiStatusResponseSchema,
  SessionPathParamsSchema,
} from '@tx-holdem-coach/contracts'
import type { SessionAiStatusReader } from '../persistence/session-ai-status-repository.js'
import type { ApiHono } from './api-context.js'
import { HttpBoundaryError, parseInput } from './request-boundary.js'
import { jsonResponse } from './response.js'

export function registerSessionAiStatusRoutes(
  app: ApiHono,
  reader: SessionAiStatusReader,
): void {
  app.get('/api/sessions/:sessionId/ai-status', async (context) => {
    if (new URL(context.req.url).search)
      throw new HttpBoundaryError(400, 'INVALID_REQUEST', '请求参数无效。')
    const { sessionId } = parseInput(
      SessionPathParamsSchema,
      context.req.param(),
    )
    const result = await reader.getById(sessionId)
    if (result === null)
      throw new HttpBoundaryError(404, 'SESSION_NOT_FOUND', '场次不存在。')
    return jsonResponse(context, SessionAiStatusResponseSchema, result)
  })
}
