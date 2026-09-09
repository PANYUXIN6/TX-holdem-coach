import {
  AgentRunAttemptsResponseSchema,
  AgentRunCapabilityInvocationsResponseSchema,
  AgentRunDetailResponseSchema,
  HandAgentCallsResponseSchema,
} from '@tx-holdem-coach/contracts'
import type { AgentCallQueryService } from '../agents/audit/agent-call-query-service.js'
import {
  AgentCallQueryInvariantError,
  normalizeAgentCallListQuery,
  type AgentCallCursorKind,
} from '../agents/audit/agent-call-query.js'
import type { ApiHono } from './api-context.js'
import { HttpBoundaryError, parseInput } from './request-boundary.js'
import { jsonResponse } from './response.js'
import { z } from 'zod'

const QUERY_BYTE_LIMIT = 8_192
const IdParamsSchema = z.strictObject({ id: z.uuid() })

function id(value: string): string {
  return parseInput(IdParamsSchema, { id: value }).id.toLowerCase()
}

function query(url: string, kind: AgentCallCursorKind, parentId: string) {
  const parsed = new URL(url)
  if (new TextEncoder().encode(parsed.search).byteLength > QUERY_BYTE_LIMIT) {
    throw new HttpBoundaryError(400, 'INVALID_REQUEST', '请求参数无效。')
  }
  try {
    return normalizeAgentCallListQuery(parsed.searchParams, kind, parentId)
  } catch (error) {
    if (error instanceof AgentCallQueryInvariantError) {
      throw new HttpBoundaryError(400, 'INVALID_REQUEST', '请求参数无效。')
    }
    throw error
  }
}

export function registerAgentCallRoutes(
  app: ApiHono,
  service: AgentCallQueryService,
): void {
  app.get('/api/hands/:handId/agent-calls', async (context) => {
    const handId = id(context.req.param('handId'))
    return jsonResponse(
      context,
      HandAgentCallsResponseSchema,
      await service.listRuns(
        handId,
        query(context.req.url, 'handAgentRuns', handId),
      ),
    )
  })
  app.get('/api/agent-runs/:runId', async (context) =>
    jsonResponse(
      context,
      AgentRunDetailResponseSchema,
      await service.readRun(id(context.req.param('runId'))),
    ),
  )
  app.get('/api/agent-runs/:runId/attempts', async (context) => {
    const runId = id(context.req.param('runId'))
    return jsonResponse(
      context,
      AgentRunAttemptsResponseSchema,
      await service.listAttempts(
        runId,
        query(context.req.url, 'runAttempts', runId),
      ),
    )
  })
  app.get('/api/agent-runs/:runId/capability-invocations', async (context) => {
    const runId = id(context.req.param('runId'))
    return jsonResponse(
      context,
      AgentRunCapabilityInvocationsResponseSchema,
      await service.listCapabilityInvocations(
        runId,
        query(context.req.url, 'runCapabilityInvocations', runId),
      ),
    )
  })
}
