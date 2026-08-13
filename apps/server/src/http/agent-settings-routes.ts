import {
  PlayerAgentSettingsPatchRequestSchema,
  PlayerAgentSettingsResponseSchema,
} from '@tx-holdem-coach/contracts'
import type { PlayerAgentSettingsService } from '../settings/player-agent-settings-service.js'
import type { ApiHono } from './api-context.js'
import { parseJsonBody } from './request-boundary.js'
import { jsonResponse } from './response.js'

export function registerAgentSettingsRoutes(
  app: ApiHono,
  settings: PlayerAgentSettingsService,
): void {
  app.get('/api/settings/agent', async (context) =>
    jsonResponse(
      context,
      PlayerAgentSettingsResponseSchema,
      await settings.read(),
    ),
  )
  app.patch('/api/settings/agent', async (context) => {
    const request = await parseJsonBody(
      context,
      PlayerAgentSettingsPatchRequestSchema,
    )
    return jsonResponse(
      context,
      PlayerAgentSettingsResponseSchema,
      await settings.update(request),
    )
  })
}
