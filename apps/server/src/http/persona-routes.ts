import {
  AgentPersonaDetailResponseSchema,
  AgentPersonaListResponseSchema,
  AgentPersonaPathParamsSchema,
  PROTOCOL_VERSION,
} from '@tx-holdem-coach/contracts'
import type { PersonaCatalog } from '../personas/catalog.js'
import type { ApiHono } from './api-context.js'
import { parseInput } from './request-boundary.js'
import { jsonResponse } from './response.js'

export function registerPersonaRoutes(
  app: ApiHono,
  catalog: PersonaCatalog,
): void {
  app.get('/api/agent-personas', (context) =>
    jsonResponse(context, AgentPersonaListResponseSchema, {
      protocolVersion: PROTOCOL_VERSION,
      personas: catalog.listPublicSummaries(),
    }),
  )
  app.get('/api/agent-personas/:personaId', (context) => {
    const { personaId } = parseInput(
      AgentPersonaPathParamsSchema,
      context.req.param(),
    )
    return jsonResponse(context, AgentPersonaDetailResponseSchema, {
      protocolVersion: PROTOCOL_VERSION,
      persona: catalog.getPublicSummary(personaId),
    })
  })
}
