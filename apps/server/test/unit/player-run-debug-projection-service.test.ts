import { describe, expect, test } from 'vitest'
import { createPlayerRunDebugProjectionService } from '../../src/agents/player/player-run-debug-projection.js'
import type {
  PlayerAuditReplayService,
  PlayerAuditReplayV1,
} from '../../src/agents/player/player-audit-replay-service.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'

const RUN_ID = '60000000-0000-4000-8000-000000000049'

function replay(): PlayerAuditReplayV1 {
  return {
    replaySchemaVersion: 1,
    decision: {
      decisionId: '70000000-0000-4000-8000-000000000049',
      runId: RUN_ID,
      sessionId: '50000000-0000-4000-8000-000000000049',
      participantId: '40000000-0000-4000-8000-000000000049',
      executionMode: 'live',
      lifecycle: 'completed',
      status: 'selected',
      terminalOutcome: null,
      terminalReason: null,
      snapshotSha256: 'a'.repeat(64),
      sourceDecisionId: null,
    },
    memory: {
      revision: 1,
      payloadVersion: 1,
      payload: {
        memorySchemaVersion: 1,
        pokerRuleSetVersion: 'nlhe-cash-6to9-10-20-v1',
        scannedThrough: null,
        lastCompletedHandNumber: null,
        sessionSummary: { completedHandsObserved: 0, showdownHandsObserved: 0 },
        opponents: [],
        recentHands: [],
        detailLevel: 'full',
      },
      sha256: 'b'.repeat(64),
      sourceAgentRunId: RUN_ID,
      sourceHandId: '30000000-0000-4000-8000-000000000049',
      sourceStateVersion: 1,
      decisionRequestId: '20000000-0000-4000-8000-000000000049',
      asOfEventSeq: 2,
    },
    attempts: [],
    capabilityInvocations: [],
  }
}

describe('M4.9 Player Run debug projection service', () => {
  test('以 owner/run 为根读取 Replay 事实，再生成无大 payload 的稳定图', async () => {
    const calls: unknown[] = []
    const auditReplay = {
      replayDecision: async () => replay(),
      replayRun: async (input: unknown) => {
        calls.push(input)
        return replay()
      },
    } as PlayerAuditReplayService
    const owner = await resolveOwnerScope(
      (async () => [
        { databaseOwnerId: '10000000-0000-4000-8000-000000000049' },
      ]) as never,
      { ownerId: 'local-user' },
    )
    const service = createPlayerRunDebugProjectionService({ auditReplay })

    await expect(
      service.projectRun({ owner, runId: RUN_ID }),
    ).resolves.toMatchObject({
      traceSchemaVersion: 1,
      runId: RUN_ID,
    })
    expect(calls).toEqual([{ owner, runId: RUN_ID }])
  })
})
