import type { Sql } from 'postgres'
import { describe, expect, test, vi } from 'vitest'
import { issueRuntimeCommitAuthority } from '../../src/agents/foundation/runtime-ports.js'
import { buildPlayerModelProjectionV1 } from '../../src/agents/player/player-model-projection.js'
import { certifyPlayerDecisionPacketV1 } from '../../src/agents/player/player-decision-packet-leak-guard.js'
import { createPlayerModelAttemptControlV1 } from '../../src/persistence/player-model-attempt-control.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import { createPlayerDecisionAuditFixture } from '../helpers/player-decision-packet-fixture.js'

const authority = issueRuntimeCommitAuthority({
  runtimeType: 'player',
  runId: '40000000-0000-4000-8000-000000000001',
  leaseOwner: 'unit-m48:player:0',
  fencingToken: 1,
})

async function owner() {
  const sql = (() =>
    Promise.resolve([
      { databaseOwnerId: '10000000-0000-4000-8000-000000000001' },
    ])) as unknown as Sql
  return resolveOwnerScope(sql, { ownerId: 'local-user' })
}

function packet() {
  const { snapshot } = createPlayerDecisionAuditFixture()
  return certifyPlayerDecisionPacketV1({
    snapshot,
    decisionRecordId: '50000000-0000-4000-8000-000000000001',
    projection: buildPlayerModelProjectionV1(snapshot),
  })
}

describe('Player Model Attempt control', () => {
  test('requires the Session-first correction port so correction cannot fall back to Run-first persistence', async () => {
    const resolvedOwner = await owner()
    expect(() =>
      createPlayerModelAttemptControlV1({
        sql: (() => undefined) as unknown as Sql,
        foundationRepository: {} as never,
        decisionRepository: {} as never,
        owner: resolvedOwner,
        authority,
        packet: packet(),
      } as never),
    ).toThrow(TypeError)
  })

  test('routes correction attempts through the required Session-first port', async () => {
    const resolvedOwner = await owner()
    const startBudgetedAgentAttemptAudit = vi.fn()
    const startCorrectionAttempt = vi.fn().mockResolvedValue({
      kind: 'started' as const,
      attemptId: '60000000-0000-4000-8000-000000000001',
      actualTimeoutMs: 1_000,
      maximumOutputTokens: 20,
    })
    const decisionPacket = packet()
    const control = createPlayerModelAttemptControlV1({
      sql: (() => undefined) as unknown as Sql,
      foundationRepository: { startBudgetedAgentAttemptAudit } as never,
      decisionRepository: {} as never,
      owner: resolvedOwner,
      authority,
      packet: decisionPacket,
      correctionAttemptPort: { startCorrectionAttempt },
      now: () => '2026-08-28T00:00:00.000Z',
    })

    await expect(
      control.startAttempt({
        attemptType: 'correction',
        routingReasonCode: 'content_correction',
        stage: 'player.bounded-choice',
        provider: 'deepseek',
        model: 'deepseek-chat',
        estimatedInputTokens: 10,
        requestedMaximumOutputTokens: 20,
        reservedCostMicrounits: 30,
        requestProjectionHash: 'a'.repeat(64),
      }),
    ).resolves.toMatchObject({ kind: 'started' })

    expect(startCorrectionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: '20000000-0000-4000-8000-000000000001',
        agentRunId: authority.runId,
        decisionRequestId: decisionPacket.binding.decisionRequestId,
        attemptAt: '2026-08-28T00:00:00.000Z',
      }),
    )
    expect(startBudgetedAgentAttemptAudit).not.toHaveBeenCalled()
  })
})
