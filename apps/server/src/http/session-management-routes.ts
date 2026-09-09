import { SessionManagementListResponseSchema } from '@tx-holdem-coach/contracts'
import { SessionManagementInvariantError } from '../sessions/data-management/errors.js'
import { normalizeSessionManagementQuery } from '../sessions/data-management/session-management-query.js'
import type { SessionManagementQueryService } from '../sessions/data-management/session-management-query-service.js'
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
    return normalizeSessionManagementQuery(parsed.searchParams)
  } catch (error) {
    if (error instanceof SessionManagementInvariantError) {
      throw new HttpBoundaryError(400, 'INVALID_REQUEST', '请求参数无效。')
    }
    throw error
  }
}

export function registerSessionManagementRoutes(
  app: ApiHono,
  service: SessionManagementQueryService,
): void {
  app.get('/api/sessions', async (context) =>
    jsonResponse(
      context,
      SessionManagementListResponseSchema,
      await service.list(parseQuery(context.req.url)),
    ),
  )
}
