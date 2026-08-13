import { HealthResponseSchema } from '@tx-holdem-coach/contracts'
import type { ApiHono } from './api-context.js'
import type { HealthService } from './health-service.js'
import { jsonResponse } from './response.js'

export function registerHealthRoutes(
  app: ApiHono,
  health: HealthService,
): void {
  app.get('/api/health', async (context) =>
    jsonResponse(context, HealthResponseSchema, await health.read()),
  )
}
