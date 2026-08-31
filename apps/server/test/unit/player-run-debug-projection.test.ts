import { describe, expect, test } from 'vitest'
import type { PlayerAuditReplayV1 } from '../../src/agents/player/player-audit-replay-service.js'
import { buildPlayerRunDebugTraceV1 } from '../../src/agents/player/player-run-debug-projection.js'
import { PLAYER_EMPTY_SESSION_MEMORY_V1 } from '../../src/agents/player/player-session-memory.js'

const replay: PlayerAuditReplayV1 = Object.freeze({
  replaySchemaVersion: 1,
  decision: Object.freeze({
    decisionId: '00000000-0000-4000-8000-000000000001',
    runId: '00000000-0000-4000-8000-000000000002',
    sessionId: '00000000-0000-4000-8000-000000000003',
    participantId: '00000000-0000-4000-8000-000000000004',
    executionMode: 'live',
    lifecycle: 'completed',
    status: 'committed',
    terminalOutcome: null,
    terminalReason: null,
    snapshotSha256: 'a'.repeat(64),
    sourceDecisionId: null,
  }),
  memory: Object.freeze({
    revision: 2,
    payloadVersion: 1,
    payload: PLAYER_EMPTY_SESSION_MEMORY_V1,
    sha256: 'b'.repeat(64),
    sourceAgentRunId: '00000000-0000-4000-8000-000000000002',
    sourceHandId: '00000000-0000-4000-8000-000000000005',
    sourceStateVersion: 4,
    decisionRequestId: '00000000-0000-4000-8000-000000000006',
    asOfEventSeq: 12,
  }),
  attempts: Object.freeze([
    Object.freeze({
      attemptId: '00000000-0000-4000-8000-000000000008',
      attemptNumber: 0,
      lifecycle: 'completed',
      accepted: true,
      stale: false,
      interrupted: false,
      requestProjectionHash: 'c'.repeat(64),
      responseProjectionHash: 'd'.repeat(64),
      errorCategory: null,
    }),
  ]),
  capabilityInvocations: Object.freeze([
    Object.freeze({
      invocationId: '00000000-0000-4000-8000-000000000007',
      invocationNumber: 0,
      capabilityName: 'player.read-session-memory',
      capabilityVersion: 1,
      authorized: true,
      inputHash: 'e'.repeat(64),
      outputHash: 'f'.repeat(64),
      errorCode: null,
    }),
  ]),
})

describe('Player Run debug projection', () => {
  test('只投影稳定摘要节点和关联边，不复制 Memory payload', () => {
    const trace = buildPlayerRunDebugTraceV1(replay)

    expect(trace.nodes).toEqual([
      expect.objectContaining({ kind: 'run', id: replay.decision.runId }),
      expect.objectContaining({
        kind: 'attempt',
        id: replay.attempts[0]!.attemptId,
      }),
      expect.objectContaining({
        kind: 'capabilityInvocation',
        id: replay.capabilityInvocations[0]!.invocationId,
      }),
      expect.objectContaining({ kind: 'memoryRevision', id: 'memory:2' }),
      expect.objectContaining({
        kind: 'playerDecision',
        id: replay.decision.decisionId,
      }),
    ])
    expect(trace.edges).toEqual([
      expect.objectContaining({ relation: 'HAS_ATTEMPT' }),
      expect.objectContaining({ relation: 'INVOKED' }),
      expect.objectContaining({ relation: 'USED_MEMORY' }),
      expect.objectContaining({ relation: 'PRODUCED' }),
      expect.objectContaining({ relation: 'ACCEPTED_FROM' }),
      expect.objectContaining({ relation: 'COMMITTED_AS' }),
    ])
    expect(JSON.stringify(trace)).not.toContain('recentHands')
    expect(Object.isFrozen(trace.nodes)).toBe(true)
  })

  test('historical Run 只以 REEXECUTES 边引用来源 Decision', () => {
    const historical = structuredClone(replay) as PlayerAuditReplayV1
    const decision = historical.decision as {
      executionMode: 'live' | 'historicalReexecution'
      sourceDecisionId: string | null
    }
    decision.executionMode = 'historicalReexecution'
    decision.sourceDecisionId = '00000000-0000-4000-8000-000000000009'

    expect(buildPlayerRunDebugTraceV1(historical).edges).toContainEqual({
      from: historical.decision.runId,
      to: '00000000-0000-4000-8000-000000000009',
      relation: 'REEXECUTES',
    })
  })
})
