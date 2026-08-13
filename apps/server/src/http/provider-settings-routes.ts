import {
  ProviderCheckRequestSchema,
  ProviderPathParamsSchema,
  ProviderSettingsResponseSchema,
} from '@tx-holdem-coach/contracts'
import type { ProviderHealthService } from '../providers/provider-health-service.js'
import type { ApiHono } from './api-context.js'
import { parseInput, parseJsonBody } from './request-boundary.js'
import { jsonResponse } from './response.js'

export function registerProviderSettingsRoutes(
  app: ApiHono,
  providerHealth: ProviderHealthService,
): void {
  app.get('/api/settings/providers', (context) =>
    jsonResponse(
      context,
      ProviderSettingsResponseSchema,
      providerHealth.read(),
    ),
  )
  app.post('/api/settings/providers/:provider/check', async (context) => {
    const { provider } = parseInput(
      ProviderPathParamsSchema,
      context.req.param(),
    )
    await parseJsonBody(context, ProviderCheckRequestSchema)
    return jsonResponse(
      context,
      ProviderSettingsResponseSchema,
      await providerHealth.check(provider),
    )
  })
}
