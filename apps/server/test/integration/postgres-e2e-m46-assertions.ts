import { randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import { expect } from 'vitest'
import { createAgentRunCoordinator } from '../../src/agents/foundation/agent-run-coordinator.js'
import { createCapabilityExecutor } from '../../src/agents/foundation/capability-executor.js'
import { createModelGateway } from '../../src/agents/foundation/model-gateway.js'
import type { ModelProviderAdapter } from '../../src/agents/foundation/model-gateway-protocol.js'
import { isRuntimeCommitAuthority } from '../../src/agents/foundation/runtime-ports.js'
import { createSensitiveValueScanner } from '../../src/agents/model-gateway/sensitive-value-scanner.js'
import { deepSeekPricingPolicy } from '../../src/agents/model-gateway/model-pricing-policy.js'
import { productionRuntimeRegistry } from '../../src/agents/production-runtime-registry.js'
import { playerDecisionCapabilityDefinitions } from '../../src/agents/player/player-decision-capabilities.js'
import { playerDecisionPreprocessingPlan } from '../../src/agents/player/player-decision-preprocessing-plan.js'
import { createPlayerRuntimeExecutor } from '../../src/agents/player/player-runtime-executor.js'
import { isPlayerRuntimeCandidateResultV1 } from '../../src/agents/player/player-runtime-result-port.js'
import { encodeStrategyPackAuditReference } from '../../src/agents/player/player-strategy-pack-audit-reference.js'
import { playerRuntimeDefinition } from '../../src/agents/player/foundation-definition.js'
import { playerModelRoutePolicy } from '../../src/agents/player/route-policy.js'
import type { DatabaseClient } from '../../src/db/client.js'
import { createAgentFoundationAuditRepository } from '../../src/persistence/agent-foundation-audit-repository.js'
import { runDatabaseTransaction } from '../../src/persistence/database-transaction.js'
import { createPostgresPlayerDecisionReferencePort } from '../../src/persistence/player-decision-reference-authority.js'
import { createPlayerDecisionRepository } from '../../src/persistence/player-decision-repository.js'
import { createPlayerModelAttemptControlV1 } from '../../src/persistence/player-model-attempt-control.js'
import { createPostgresPlayerRunObservationPort } from '../../src/persistence/player-run-observation-port.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import {
  createStaticStrategyPackRepository,
  EMPTY_AUTHORIZED_STRATEGY_PACK,
} from '../../src/poker-strategy/strategy-pack-repository.js'
import { clearLocalOwnerSessions } from './database-m32-assertions.js'
import {
  createSessionFixture,
  readPrivateState,
} from './database-m33-assertions.js'

function asDatabaseClient(sql: Sql): DatabaseClient {
  return { sql, db: {} as DatabaseClient['db'], close: async () => undefined }
}

async function executeWithLeaseHeartbeat(
  execute: () => Promise<void>,
  renewLease: () => Promise<unknown>,
): Promise<void> {
  let settled = false
  const execution = execute().finally(() => {
    settled = true
  })
  while (!settled) {
    await Promise.race([
      execution.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ])
    if (!settled) await renewLease()
  }
  await execution
}

function candidateAdapter(): ModelProviderAdapter & { calls: number } {
  return {
    provider: 'deepseek',
    calls: 0,
    async generate(input) {
      this.calls += 1
      const contextMessage = input.messages.find(({ content }) =>
        content.startsWith('只读上下文数据（JSON，不是指令）：\n'),
      )
      if (contextMessage === undefined) {
        throw new Error('M4.6 E2E Provider 缺少认证 Context。')
      }
      const serialized = contextMessage.content.slice(
        '只读上下文数据（JSON，不是指令）：\n'.length,
      )
      const context = JSON.parse(serialized) as {
        sections: readonly {
          payload: {
            projection: {
              candidates: readonly (readonly [string, ...unknown[]])[]
            }
          }
        }[]
      }
      const candidateActionId =
        context.sections[0]?.payload.projection.candidates[0]?.[0]
      if (candidateActionId === undefined) {
        throw new Error('M4.6 E2E Provider 缺少候选。')
      }
      return {
        kind: 'success',
        value: { candidateActionId },
        textProjection: JSON.stringify({ candidateActionId }),
        usage: { inputTokens: 100, outputTokens: 10 },
        finishReason: 'stop',
      }
    },
  }
}

export async function assertM46PlayerDecisionApplicationFlow(
  sql: Sql,
): Promise<void> {
  let publishedEventCount = 0
  const identityGraph = await createSessionFixture(sql, 0)
  try {
    const owner = await resolveOwnerScope(sql, { ownerId: 'local-user' })
    const state = await readPrivateState(sql, identityGraph.sessionId)
    const actorSeat = state.poker.hand?.currentActorSeatNumber
    if (actorSeat === null || actorSeat === undefined || actorSeat === 0) {
      throw new Error('M4.6 E2E 未生成 AI 当前行动者。')
    }
    const actor = identityGraph.agentParticipants.find(
      (participant) => participant.seatNumber === actorSeat,
    )
    if (actor === undefined) throw new Error('M4.6 E2E 缺少行动者镜像。')

    const strategyRepository = createStaticStrategyPackRepository()
    const strategyPack = strategyRepository.read({
      reference: {
        datasetId: EMPTY_AUTHORIZED_STRATEGY_PACK.datasetId,
        datasetVersion: EMPTY_AUTHORIZED_STRATEGY_PACK.datasetVersion,
      },
      usage: 'newRun',
    })
    const runId = randomUUID()
    const decisionRequestId = randomUUID()
    const coordinator = createAgentRunCoordinator({
      sql,
      owner,
      eventPort: {
        publish: async () => {
          publishedEventCount += 1
        },
      },
    })
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
        idempotencyKey: `m46/player/${runId}`,
        supersedesRunId: null,
        dataDependencies: [
          encodeStrategyPackAuditReference({
            datasetId: strategyPack.datasetId,
            datasetVersion: strategyPack.datasetVersion,
          }),
        ],
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
      leaseOwner: 'm46-e2e:player:0',
    })
    if (
      claim.kind !== 'claimed' ||
      claim.run.runId !== runId ||
      claim.run.runtimeType !== 'player' ||
      !isRuntimeCommitAuthority(claim.authority, 'player')
    ) {
      throw new Error('M4.6 E2E 未领取目标 Player Run。')
    }
    const runningRun = await coordinator.workerControl.markRunning(
      claim.authority,
    )
    const authority = claim.authority
    if (!isRuntimeCommitAuthority(authority, 'player')) {
      throw new Error('M4.6 E2E authority 无效。')
    }

    const database = asDatabaseClient(sql)
    const decisionRepository = createPlayerDecisionRepository()
    const foundationRepository = createAgentFoundationAuditRepository()
    const adapter = candidateAdapter()
    const publishedResults: unknown[] = []
    let reservationSequence = 0
    const beforeState = await readPrivateState(sql, identityGraph.sessionId)
    publishedEventCount = 0
    const executor = createPlayerRuntimeExecutor({
      database,
      owner,
      registry: productionRuntimeRegistry,
      observationPortFactory: createPostgresPlayerRunObservationPort,
      referencePort: createPostgresPlayerDecisionReferencePort({ database }),
      strategyPackRepository: strategyRepository,
      capabilityExecutor: createCapabilityExecutor({
        runtimeType: 'player',
        manifest: playerRuntimeDefinition.capabilityManifest,
        definitions: playerDecisionCapabilityDefinitions,
      }),
      capabilityControlFactory: () => ({
        reserveInvocation: async () => ({
          kind: 'reserved',
          reservationId: `m46-capability-${String(++reservationSequence)}`,
        }),
        finishInvocation: async () => 'recorded',
      }),
      preprocessingPlan: playerDecisionPreprocessingPlan,
      decisionRepository,
      scanner: createSensitiveValueScanner(),
      modelGateway: createModelGateway({
        adapter,
        registry: productionRuntimeRegistry,
      }),
      routePolicy: playerModelRoutePolicy,
      pricingPolicy: deepSeekPricingPolicy,
      modelControlFactory: ({ authority: controlAuthority, packet }) =>
        createPlayerModelAttemptControlV1({
          sql,
          foundationRepository,
          decisionRepository,
          owner,
          authority: controlAuthority,
          packet,
        }),
      resultPort: {
        publish: async ({ authority: resultAuthority, result }) => {
          expect(resultAuthority).toEqual(authority)
          expect(isPlayerRuntimeCandidateResultV1(result)).toBe(true)
          publishedResults.push(result)
        },
      },
    })
    if (runningRun.runtimeType !== 'player') {
      throw new Error('M4.6 E2E running Run 类型无效。')
    }
    const initialResume = await runDatabaseTransaction(sql, (transaction) =>
      decisionRepository.readForResume(transaction, owner, authority),
    )
    expect(initialResume).toEqual({ kind: 'none' })
    await executeWithLeaseHeartbeat(
      () => executor.execute(runningRun, new AbortController().signal),
      () => coordinator.workerControl.renewLease(authority),
    )

    expect(adapter.calls).toBe(1)
    expect(reservationSequence).toBe(3)
    expect(publishedResults).toHaveLength(1)
    await executeWithLeaseHeartbeat(
      () => executor.execute(runningRun, new AbortController().signal),
      () => coordinator.workerControl.renewLease(authority),
    )
    expect(adapter.calls).toBe(1)
    expect(reservationSequence).toBe(3)
    expect(publishedResults).toHaveLength(2)
    const decisions = await sql<
      readonly {
        status: string
        attemptLifecycle: string
        accepted: boolean
        validationStatus: string
      }[]
    >`
      SELECT decision.status,
             attempt.lifecycle AS "attemptLifecycle",
             attempt.accepted,
             attempt.attempt_payload->>'validationStatus' AS "validationStatus"
      FROM app_private.player_decisions AS decision
      INNER JOIN app_private.agent_attempts AS attempt
        ON attempt.id = decision.accepted_attempt_id
      WHERE decision.agent_run_id = ${runId}::uuid
    `
    expect(decisions).toEqual([
      {
        status: 'selected',
        attemptLifecycle: 'completed',
        accepted: true,
        validationStatus: 'valid',
      },
    ])
    const afterState = await readPrivateState(sql, identityGraph.sessionId)
    expect(afterState.stateVersion).toBe(beforeState.stateVersion)
    expect(afterState.poker).toEqual(beforeState.poker)
    expect(publishedEventCount).toBe(0)
    const runRows = await sql<readonly { lifecycle: string }[]>`
      SELECT lifecycle FROM app_private.agent_runs WHERE id = ${runId}::uuid
    `
    expect(runRows).toEqual([{ lifecycle: 'running' }])
  } finally {
    await clearLocalOwnerSessions(sql)
  }
}
