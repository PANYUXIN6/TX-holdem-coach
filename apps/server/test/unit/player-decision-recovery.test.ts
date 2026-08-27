import type { Sql, TransactionSql } from 'postgres'
import { describe, expect, test } from 'vitest'
import { issueRuntimeCommitAuthority } from '../../src/agents/foundation/runtime-ports.js'
import {
  playerCandidateSetSnapshotCodec,
  playerDecisionAuditSnapshotCodec,
  playerModelProjectionCodec,
} from '../../src/agents/player/player-decision-audit-codec.js'
import { buildPlayerModelProjectionV1 } from '../../src/agents/player/player-model-projection.js'
import { AgentRunTransitionError } from '../../src/agents/foundation/agent-run-lifecycle.js'
import {
  PersistenceDataCorruptionError,
  PlayerDecisionTransitionError,
} from '../../src/persistence/errors.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import { createPlayerDecisionRepository } from '../../src/persistence/player-decision-repository.js'
import { createPlayerDecisionAuditFixture } from '../helpers/player-decision-packet-fixture.js'

const DATABASE_OWNER_ID = '11111111-1111-4111-8111-111111111111'
const RUN_ID = '60000000-0000-4000-8000-000000000046'
const DECISION_ID = '70000000-0000-4000-8000-000000000046'
const ATTEMPT_ID = '80000000-0000-4000-8000-000000000046'
const CREATED_AT = '2026-08-25T08:00:00.000Z'

function createSqlMock(responses: readonly unknown[]): Sql {
  const pending = [...responses]
  const tag = ((template: TemplateStringsArray, ..._parameters: unknown[]) => {
    const response = pending.shift()
    if (response === undefined) {
      throw new Error(`未登记 SQL 响应：${template.join('?')}`)
    }
    return response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(response as readonly unknown[])
  }) as unknown as Sql
  Object.assign(tag, {
    begin: async (
      operation: (transaction: TransactionSql) => Promise<unknown>,
    ) => operation(tag as unknown as TransactionSql),
    json: (value: unknown) => value,
  })
  return tag
}

async function owner() {
  return resolveOwnerScope(
    createSqlMock([[{ databaseOwnerId: DATABASE_OWNER_ID }]]),
    { ownerId: 'local-user' },
  )
}

function preparedRows(status: 'auditPrepared' | 'modelPrepared') {
  const { snapshot } = createPlayerDecisionAuditFixture()
  const projection = buildPlayerModelProjectionV1(snapshot)
  const audit = playerDecisionAuditSnapshotCodec.encode(snapshot)
  const candidates = playerCandidateSetSnapshotCodec.encode(snapshot.candidates)
  const model = playerModelProjectionCodec.encode(projection)
  const binding = snapshot.binding
  const lockedRun = {
    agentRunId: RUN_ID,
    sessionId: binding.sessionId,
    handId: binding.handId,
    participantId: binding.actorParticipantId,
    sourceStateVersion: binding.stateVersion,
    decisionRequestId: binding.decisionRequestId,
    fencingToken: 2,
  }
  const decision = {
    decisionRecordId: DECISION_ID,
    agentRunId: RUN_ID,
    sessionId: binding.sessionId,
    handId: binding.handId,
    participantId: binding.actorParticipantId,
    sourceStateVersion: binding.stateVersion,
    decisionRequestId: binding.decisionRequestId,
    status,
    auditPayloadVersion: audit.payloadVersion,
    auditPayload: structuredClone(audit.payload),
    candidatePayloadVersion: candidates.payloadVersion,
    candidatePayload: structuredClone(candidates.payload),
    projectionPayloadVersion:
      status === 'modelPrepared' ? model.payloadVersion : null,
    projectionPayload:
      status === 'modelPrepared' ? structuredClone(model.payload) : null,
    choicePayloadVersion: null,
    choicePayload: null,
    validatorPayloadVersion: null,
    validatorPayload: null,
    acceptedAttemptId: null,
    commandLedgerId: null,
    createdAt: CREATED_AT,
    modelPreparedAt: status === 'modelPrepared' ? CREATED_AT : null,
    selectedAt: null,
    committedAt: null,
  }
  return { lockedRun, decision, projection, snapshot }
}

function staleInterruptedAttempt() {
  return {
    attemptId: ATTEMPT_ID,
    lifecycle: 'stale',
    accepted: false,
    stale: true,
    interrupted: true,
    errorCategory: 'lease_replaced',
    stage: 'player.bounded-choice',
    fencingToken: 1,
    payloadVersion: 1,
    payload: {},
    startedAt: CREATED_AT,
  }
}

describe('M4.6 Player Decision durable-stage recovery', () => {
  test('distinguishes no Decision, auditPrepared and modelPrepared after JSON round-trip', async () => {
    const repository = createPlayerDecisionRepository()
    const resolvedOwner = await owner()
    const authority = issueRuntimeCommitAuthority({
      runtimeType: 'player',
      runId: RUN_ID,
      leaseOwner: 'm46-recovery:player:0',
      fencingToken: 2,
    })
    const audit = preparedRows('auditPrepared')
    const model = preparedRows('modelPrepared')

    await expect(
      repository.readForResume(
        createSqlMock([[audit.lockedRun], []]) as unknown as TransactionSql,
        resolvedOwner,
        authority,
      ),
    ).resolves.toEqual({ kind: 'none' })

    const auditResume = await repository.readForResume(
      createSqlMock([
        [audit.lockedRun],
        [audit.decision],
        [],
      ]) as unknown as TransactionSql,
      resolvedOwner,
      authority,
    )
    expect(auditResume).toMatchObject({ kind: 'auditPrepared' })
    if (auditResume.kind !== 'auditPrepared') {
      throw new Error('M4.6 测试未读取 auditPrepared。')
    }
    expect(auditResume.record.projection).toBeNull()

    const modelResume = await repository.readForResume(
      createSqlMock([
        [model.lockedRun],
        [model.decision],
        [],
      ]) as unknown as TransactionSql,
      resolvedOwner,
      authority,
    )
    expect(modelResume).toMatchObject({ kind: 'modelPrepared' })
    if (modelResume.kind !== 'modelPrepared') {
      throw new Error('M4.6 测试未读取 modelPrepared。')
    }
    expect(modelResume.record.projection).toEqual(model.projection)
  })

  test('classifies a replaced in-flight model call without retrying it', async () => {
    const repository = createPlayerDecisionRepository()
    const resolvedOwner = await owner()
    const authority = issueRuntimeCommitAuthority({
      runtimeType: 'player',
      runId: RUN_ID,
      leaseOwner: 'm46-recovery:player:0',
      fencingToken: 2,
    })
    const model = preparedRows('modelPrepared')
    await expect(
      repository.readForResume(
        createSqlMock([
          [model.lockedRun],
          [model.decision],
          [staleInterruptedAttempt()],
        ]) as unknown as TransactionSql,
        resolvedOwner,
        authority,
      ),
    ).resolves.toEqual({
      kind: 'inflightUnknown',
      decisionRecordId: DECISION_ID,
    })
  })

  test('rejects model preparation when any projected candidate outcome drifts', async () => {
    const repository = createPlayerDecisionRepository()
    const resolvedOwner = await owner()
    const authority = issueRuntimeCommitAuthority({
      runtimeType: 'player',
      runId: RUN_ID,
      leaseOwner: 'm46-recovery:player:0',
      fencingToken: 2,
    })
    const audit = preparedRows('auditPrepared')
    const driftedProjection = structuredClone(audit.projection)
    const firstCandidate = driftedProjection.candidates[0]
    if (firstCandidate === undefined) throw new Error('测试候选缺失。')
    firstCandidate[9][0] += 1

    await expect(
      repository.markModelPrepared(
        createSqlMock([
          [audit.lockedRun],
          [audit.decision],
        ]) as unknown as TransactionSql,
        resolvedOwner,
        authority,
        {
          decisionRecordId: DECISION_ID,
          snapshotSha256: audit.snapshot.snapshotSha256,
          candidateSetSha256: audit.snapshot.candidates.candidateSetSha256,
          projection: driftedProjection,
        },
      ),
    ).rejects.toBeInstanceOf(PlayerDecisionTransitionError)

    const model = preparedRows('modelPrepared')
    const persistedDrift = structuredClone(model.projection)
    const persistedCandidate = persistedDrift.candidates[0]
    if (persistedCandidate === undefined) throw new Error('测试候选缺失。')
    persistedCandidate[9][0] += 1
    const driftedPayload = playerModelProjectionCodec.encode(persistedDrift)
    await expect(
      repository.readForResume(
        createSqlMock([
          [model.lockedRun],
          [
            {
              ...model.decision,
              projectionPayload: driftedPayload.payload,
            },
          ],
        ]) as unknown as TransactionSql,
        resolvedOwner,
        authority,
      ),
    ).rejects.toBeInstanceOf(PersistenceDataCorruptionError)
  })

  test('rejects stale fencing and an impossible auditPrepared model attempt', async () => {
    const repository = createPlayerDecisionRepository()
    const resolvedOwner = await owner()
    const authority = issueRuntimeCommitAuthority({
      runtimeType: 'player',
      runId: RUN_ID,
      leaseOwner: 'm46-recovery:player:0',
      fencingToken: 2,
    })
    const audit = preparedRows('auditPrepared')

    await expect(
      repository.readForResume(
        createSqlMock([[]]) as unknown as TransactionSql,
        resolvedOwner,
        authority,
      ),
    ).rejects.toBeInstanceOf(AgentRunTransitionError)

    await expect(
      repository.readForResume(
        createSqlMock([
          [audit.lockedRun],
          [audit.decision],
          [staleInterruptedAttempt()],
        ]) as unknown as TransactionSql,
        resolvedOwner,
        authority,
      ),
    ).rejects.toBeInstanceOf(PersistenceDataCorruptionError)
  })
})
