import { randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import { expect } from 'vitest'
import {
  createCapabilityExecutor,
  type CapabilityExecutionControlPort,
  type CapabilityInvocationAudit,
} from '../../src/agents/foundation/capability-executor.js'
import { createAgentRunCoordinator } from '../../src/agents/foundation/agent-run-coordinator.js'
import { isRuntimeCommitAuthority } from '../../src/agents/foundation/runtime-ports.js'
import { playerDecisionCapabilityDefinitions } from '../../src/agents/player/player-decision-capabilities.js'
import {
  encodeStrategyPackAuditReference,
  readPinnedStrategyPackReference,
} from '../../src/agents/player/player-strategy-pack-audit-reference.js'
import {
  executePlayerDecisionPreprocessingPlan,
  PLAYER_DECISION_PREPROCESSING_CAPABILITY_ORDER,
} from '../../src/agents/player/player-decision-preprocessing-plan.js'
import { isPlayerDecisionPreprocessingResult } from '../../src/agents/player/player-decision-preprocessor.js'
import { playerRuntimeDefinition } from '../../src/agents/player/foundation-definition.js'
import {
  hashPlayerSessionMemoryV1,
  PLAYER_EMPTY_SESSION_MEMORY_V1,
} from '../../src/agents/player/player-session-memory.js'
import type { DatabaseClient } from '../../src/db/client.js'
import { createPostgresPlayerDecisionReferencePort } from '../../src/persistence/player-decision-reference-authority.js'
import { createPostgresPlayerObservationPort } from '../../src/persistence/player-observation-authority.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import {
  createStaticStrategyPackRepository,
  EMPTY_AUTHORIZED_STRATEGY_PACK,
} from '../../src/poker-strategy/strategy-pack-repository.js'
import { createPlayerDecisionIdentity } from '../../src/sessions/authoritative-state/decision-identity.js'
import { isPlayerVisibleState } from '../../src/sessions/authoritative-state/player-information-boundary-guard.js'
import { clearLocalOwnerSessions } from './database-m32-assertions.js'
import {
  createSessionFixture,
  readPrivateState,
} from './database-m33-assertions.js'

function asDatabaseClient(sql: Sql): DatabaseClient {
  return {
    sql,
    db: {} as DatabaseClient['db'],
    close: async () => undefined,
  }
}

export async function assertM45PlayerDecisionPreprocessingApplicationFlow(
  sql: Sql,
): Promise<void> {
  let publishedEventCount = 0
  const eventPort = {
    publish: async () => {
      publishedEventCount += 1
    },
  }
  const identityGraph = await createSessionFixture(sql, 0)
  try {
    const owner = await resolveOwnerScope(sql, { ownerId: 'local-user' })
    const state = await readPrivateState(sql, identityGraph.sessionId)
    const actorSeat = state.poker.hand?.currentActorSeatNumber
    if (actorSeat === null || actorSeat === undefined || actorSeat === 0) {
      throw new Error('M4.5 E2E 未生成 AI 当前行动者。')
    }
    const actor = identityGraph.agentParticipants.find(
      (participant) => participant.seatNumber === actorSeat,
    )
    if (actor === undefined) throw new Error('M4.5 E2E 缺少行动者镜像。')

    const runId = randomUUID()
    const decisionRequestId = randomUUID()
    const strategyPackRepository = createStaticStrategyPackRepository()
    const newRunStrategyPack = strategyPackRepository.read({
      reference: {
        datasetId: EMPTY_AUTHORIZED_STRATEGY_PACK.datasetId,
        datasetVersion: EMPTY_AUTHORIZED_STRATEGY_PACK.datasetVersion,
      },
      usage: 'newRun',
    })
    const strategyPackDependency = encodeStrategyPackAuditReference({
      datasetId: newRunStrategyPack.datasetId,
      datasetVersion: newRunStrategyPack.datasetVersion,
    })
    const coordinator = createAgentRunCoordinator({ sql, owner, eventPort })
    await sql.begin(async (transaction) => {
      await coordinator.createOrReuse(transaction, {
        runtimeType: 'player',
        agentRunId: runId,
        sessionId: identityGraph.sessionId,
        handId: identityGraph.handId,
        actorParticipantId: actor.participantId,
        sourceStateVersion: state.stateVersion,
        decisionRequestId,
        triggerType: 'action_required',
        idempotencyKey: `m45/player/${runId}`,
        supersedesRunId: null,
        dataDependencies: [strategyPackDependency],
        createdAt: new Date().toISOString(),
      })
      await transaction`
        UPDATE app_private.sessions
        SET agent_run_state = 'thinking',
            active_player_run_id = ${runId}::uuid,
            active_decision_request_id = ${decisionRequestId}::uuid,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${identityGraph.sessionId}::uuid
          AND owner_id = ${owner.databaseOwnerId}::uuid
      `
    })
    const claim = await coordinator.workerControl.claimNext({
      runtimeType: 'player',
      leaseOwner: 'm45-e2e:player:0',
    })
    if (
      claim.kind !== 'claimed' ||
      claim.run.runId !== runId ||
      claim.run.runtimeType !== 'player' ||
      !isRuntimeCommitAuthority(claim.authority, 'player')
    ) {
      throw new Error('M4.5 E2E 未领取目标 Player Run。')
    }
    await coordinator.workerControl.markRunning(claim.authority)
    const pinnedStrategyPackReference = readPinnedStrategyPackReference(
      claim.run.runConfiguration.dataDependencies,
    )
    const pinnedStrategyPack = strategyPackRepository.read({
      reference: pinnedStrategyPackReference,
      usage: 'pinnedRun',
    })
    expect(pinnedStrategyPackReference).toEqual({
      datasetId: newRunStrategyPack.datasetId,
      datasetVersion: newRunStrategyPack.datasetVersion,
    })

    const database = asDatabaseClient(sql)
    const observationPort = createPostgresPlayerObservationPort({
      authority: claim.authority,
      database,
    })
    const observationResult = await observationPort.load({
      owner,
      identity: createPlayerDecisionIdentity({
        sessionId: identityGraph.sessionId,
        handId: identityGraph.handId,
        stateVersion: state.stateVersion,
        actorParticipantId: actor.participantId,
        actorSeat,
        decisionRequestId,
      }),
    })
    expect(observationResult.kind).toBe('ready')
    if (observationResult.kind !== 'ready') {
      throw new Error('M4.5 E2E 认证观察未就绪。')
    }
    const observation = observationResult.observation
    expect(isPlayerVisibleState(observation)).toBe(true)

    const referencePort = createPostgresPlayerDecisionReferencePort({
      database,
    })
    const referenceResult = await referencePort.load({ owner, observation })
    expect(referenceResult.kind).toBe('ready')
    if (referenceResult.kind !== 'ready') {
      throw new Error('M4.5 E2E 决策参考未就绪。')
    }
    publishedEventCount = 0
    const beforeRows = await sql<
      readonly {
        readonly stateVersion: number
        readonly nextEventSeq: number
        readonly currentHandId: string
      }[]
    >`
      SELECT
        state_version::float8 AS "stateVersion",
        next_event_seq::float8 AS "nextEventSeq",
        current_hand_id::text AS "currentHandId"
      FROM app_private.sessions
      WHERE id = ${identityGraph.sessionId}::uuid
        AND owner_id = ${owner.databaseOwnerId}::uuid
    `
    const invocationAudits: CapabilityInvocationAudit[] = []
    let reservationSequence = 0
    const control: CapabilityExecutionControlPort = {
      reserveInvocation: async () => {
        reservationSequence += 1
        return {
          kind: 'reserved',
          reservationId: `m45-e2e-reservation-${String(reservationSequence)}`,
        }
      },
      finishInvocation: async ({ audit }) => {
        invocationAudits.push(audit)
        return 'recorded'
      },
    }
    const executor = createCapabilityExecutor({
      runtimeType: 'player',
      manifest: playerRuntimeDefinition.capabilityManifest,
      definitions: playerDecisionCapabilityDefinitions,
    })
    const preprocessing = await executePlayerDecisionPreprocessingPlan({
      executor,
      authority: claim.authority,
      control,
      signal: new AbortController().signal,
      observation,
      reference: referenceResult.reference,
      strategyPack: pinnedStrategyPack,
      sessionMemory: {
        revision: 1,
        payloadVersion: 1,
        payload: PLAYER_EMPTY_SESSION_MEMORY_V1,
        sha256: hashPlayerSessionMemoryV1(PLAYER_EMPTY_SESSION_MEMORY_V1),
        sourceAgentRunId: runId,
        sourceHandId: identityGraph.handId,
        sourceStateVersion: state.stateVersion,
        decisionRequestId,
        asOfEventSeq: observation.identity.asOfEventSeq,
      },
    })

    expect(preprocessing.binding).toMatchObject({
      observationSchemaVersion: 1,
      observationSha256: observation.observationSha256,
      sessionId: identityGraph.sessionId,
      handId: identityGraph.handId,
      stateVersion: state.stateVersion,
      decisionRequestId,
      actorParticipantId: actor.participantId,
      actorSeat,
      pokerRuleSetVersion: referenceResult.reference.pokerRuleSetVersion,
    })
    expect(preprocessing.normalizedSpot.data).toMatchObject({
      spotSchemaVersion: 1,
      normalizerVersion: 1,
    })
    expect(preprocessing.handFeatures.data).toMatchObject({
      handFeatureSchemaVersion: 1,
      analyzerVersion: 1,
      street: observation.hand.street,
    })
    expect(preprocessing.contestablePot.data).toMatchObject({
      contestablePotSchemaVersion: 1,
      projectorVersion: 1,
    })
    expect(preprocessing.currentMetrics.data).toMatchObject({
      decisionMetricsSchemaVersion: 1,
      engineVersion: 1,
    })
    expect(isPlayerDecisionPreprocessingResult(preprocessing)).toBe(true)
    expect(preprocessing).toMatchObject({
      preprocessingResultSchemaVersion: 1,
      preprocessingPipelineVersion: 1,
      candidateSource: 'heuristic',
      opponentEvidence: {
        data: {
          opponentEvidenceSchemaVersion: 1,
          sourceScope: 'currentHandAndSessionMemory',
          status: 'insufficientEvidence',
          reasonCode: 'insufficientEvidence',
        },
      },
    })
    expect(preprocessing.candidateOutcomes.data).toHaveLength(
      preprocessing.candidates.data.length,
    )
    expect(invocationAudits.map((audit) => audit.capability)).toEqual(
      PLAYER_DECISION_PREPROCESSING_CAPABILITY_ORDER,
    )
    expect(
      invocationAudits.every(
        (audit) => audit.errorCode === null && audit.outputHash !== null,
      ),
    ).toBe(true)
    expect(JSON.stringify(preprocessing)).not.toContain('analysisInputField')
    expect(
      JSON.stringify({
        preprocessing,
        reference: referenceResult.reference,
      }),
    ).not.toMatch(
      /remainingDeck|burnedCards|holeCardsBySeat|memoryPayload|stateBeforeStartCommand/,
    )
    expect(Object.isFrozen(preprocessing)).toBe(true)
    expect(Object.isFrozen(preprocessing.candidateOutcomes.data)).toBe(true)
    const afterRows = await sql<
      readonly {
        readonly stateVersion: number
        readonly nextEventSeq: number
        readonly currentHandId: string
      }[]
    >`
      SELECT
        state_version::float8 AS "stateVersion",
        next_event_seq::float8 AS "nextEventSeq",
        current_hand_id::text AS "currentHandId"
      FROM app_private.sessions
      WHERE id = ${identityGraph.sessionId}::uuid
        AND owner_id = ${owner.databaseOwnerId}::uuid
    `
    expect(afterRows).toEqual(beforeRows)
    expect(publishedEventCount).toBe(0)
  } finally {
    await clearLocalOwnerSessions(sql)
  }
}
