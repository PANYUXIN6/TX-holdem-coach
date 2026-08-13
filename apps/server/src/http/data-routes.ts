import {
  ClearDataRequestSchema,
  ClearDataResponseSchema,
  DeleteSessionRequestSchema,
  DeleteSessionResponseSchema,
  SessionPathParamsSchema,
} from '@tx-holdem-coach/contracts'
import type { SessionDataDeletionService } from '../sessions/session-data-deletion-service.js'
import type { ApiHono } from './api-context.js'
import { parseInput, parseJsonBody } from './request-boundary.js'
import { jsonResponse } from './response.js'

export function registerDataRoutes(
  app: ApiHono,
  deletion: SessionDataDeletionService,
): void {
  app.delete('/api/sessions/:sessionId', async (context) => {
    const { sessionId } = parseInput(
      SessionPathParamsSchema,
      context.req.param(),
    )
    const request = await parseJsonBody(context, DeleteSessionRequestSchema)
    return jsonResponse(
      context,
      DeleteSessionResponseSchema,
      await deletion.deleteEndedSession(sessionId, request),
    )
  })
  app.delete('/api/data', async (context) => {
    const request = await parseJsonBody(context, ClearDataRequestSchema)
    return jsonResponse(
      context,
      ClearDataResponseSchema,
      await deletion.clearAll(request),
    )
  })
}
