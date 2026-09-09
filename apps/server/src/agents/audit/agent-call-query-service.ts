import {
  AgentRunAttemptsResponseSchema,
  AgentRunCapabilityInvocationsResponseSchema,
  AgentRunDetailResponseSchema,
  HandAgentCallsResponseSchema,
  type AgentCallHandSummary,
  type AgentAttemptSummary,
  type AgentCapabilityInvocationSummary,
  type AgentRunDetailResponse,
  type AgentRunSummary,
  type AgentRunAttemptsResponse,
  type AgentRunCapabilityInvocationsResponse,
  type HandAgentCallsResponse,
} from '@tx-holdem-coach/contracts'
import {
  encodeAgentCallCursor,
  type NormalizedAgentCallListQuery,
} from './agent-call-query.js'

export interface AgentCallQueryReader {
  listRuns(input: {
    readonly handId: string
    readonly query: NormalizedAgentCallListQuery
  }): Promise<{
    readonly hand: AgentCallHandSummary
    readonly items: readonly AgentRunSummary[]
    readonly hasMore: boolean
  }>
  readRun(runId: string): Promise<AgentRunDetailResponse>
  listAttempts(input: {
    readonly runId: string
    readonly query: NormalizedAgentCallListQuery
  }): Promise<{
    readonly items: readonly AgentAttemptSummary[]
    readonly hasMore: boolean
  }>
  listCapabilityInvocations(input: {
    readonly runId: string
    readonly query: NormalizedAgentCallListQuery
  }): Promise<{
    readonly items: readonly AgentCapabilityInvocationSummary[]
    readonly hasMore: boolean
  }>
}

export interface AgentCallQueryService {
  listRuns(
    handId: string,
    query: NormalizedAgentCallListQuery,
  ): Promise<HandAgentCallsResponse>
  readRun(runId: string): Promise<AgentRunDetailResponse>
  listAttempts(
    runId: string,
    query: NormalizedAgentCallListQuery,
  ): Promise<AgentRunAttemptsResponse>
  listCapabilityInvocations(
    runId: string,
    query: NormalizedAgentCallListQuery,
  ): Promise<AgentRunCapabilityInvocationsResponse>
}

function parse<Output>(
  schema: { parse(value: unknown): Output },
  value: unknown,
) {
  return Object.freeze(schema.parse(value))
}

export function createAgentCallQueryService(input: {
  readonly reader: AgentCallQueryReader
}): AgentCallQueryService {
  const service: AgentCallQueryService = {
    async listRuns(handId, query) {
      const result = await input.reader.listRuns({ handId, query })
      const last = result.items.at(-1)
      return parse(HandAgentCallsResponseSchema, {
        query: { limit: query.limit },
        hand: result.hand,
        items: result.items,
        nextCursor:
          result.hasMore && last !== undefined
            ? encodeAgentCallCursor({
                kind: 'handAgentRuns',
                parentId: handId,
                after: { createdAt: last.createdAt, id: last.runId },
              })
            : null,
      })
    },
    async readRun(runId) {
      return parse(
        AgentRunDetailResponseSchema,
        await input.reader.readRun(runId),
      )
    },
    async listAttempts(runId, query) {
      const page = await input.reader.listAttempts({ runId, query })
      const last = page.items.at(-1)
      return parse(AgentRunAttemptsResponseSchema, {
        query: { limit: query.limit },
        runId,
        items: page.items,
        nextCursor:
          page.hasMore && last !== undefined
            ? encodeAgentCallCursor({
                kind: 'runAttempts',
                parentId: runId,
                after: { sequence: last.attemptNumber },
              })
            : null,
      })
    },
    async listCapabilityInvocations(runId, query) {
      const page = await input.reader.listCapabilityInvocations({
        runId,
        query,
      })
      const last = page.items.at(-1)
      return parse(AgentRunCapabilityInvocationsResponseSchema, {
        query: { limit: query.limit },
        runId,
        items: page.items,
        nextCursor:
          page.hasMore && last !== undefined
            ? encodeAgentCallCursor({
                kind: 'runCapabilityInvocations',
                parentId: runId,
                after: { sequence: last.invocationNumber },
              })
            : null,
      })
    },
  }
  return Object.freeze(service)
}
