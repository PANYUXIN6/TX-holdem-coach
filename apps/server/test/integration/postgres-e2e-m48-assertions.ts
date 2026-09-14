import { createEndSessionHandlerBinding } from '../../src/sessions/command-execution/end-session-handler.js'
import { createSessionAiStatusRepository } from '../../src/persistence/session-ai-status-repository.js'
import { randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import { expect } from 'vitest'
import { createAgentRunCoordinator } from '../../src/agents/foundation/agent-run-coordinator.js'
import { issueRuntimeCommitAuthority } from '../../src/agents/foundation/runtime-ports.js'
import { productionRuntimeRegistry } from '../../src/agents/production-runtime-registry.js'
import { createRetryAgentHandlerBinding } from '../../src/agents/player/retry-agent-handler.js'
import { createSessionAgentCoordinator } from '../../src/agents/player/session-agent-coordinator.js'
import { encodeStrategyPackAuditReference } from '../../src/agents/player/player-strategy-pack-audit-reference.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import { runDatabaseTransaction } from '../../src/persistence/database-transaction.js'
import { createAgentFoundationAuditRepository } from '../../src/persistence/agent-foundation-audit-repository.js'
import { productionSessionMutationRepository } from '../../src/persistence/session-mutation-repository.js'
import { productionSessionRecoveryRepository } from '../../src/persistence/session-recovery-repository.js'
import { createSessionCommandHandlerMap } from '../../src/sessions/command-execution/command-handler-map.js'
import { createSessionCommandExecutor } from '../../src/sessions/command-execution/session-command-executor.js'
import { createPublicSessionBindings } from '../../src/sessions/public-projection/public-session-bindings.js'
import {
  createSessionFixture,
  prepareTerminalAgentTurn,
  readPrivateState,
} from './database-m33-assertions.js'
import { assertM48PlayerCoordinationSchema } from './database-m48-assertions.js'
import { runDatabaseTestWithCleanup } from './database-test-runtime.js'
import { clearOwnerSessionData } from '../../src/persistence/session-deletion-repository.js'
import {
  createStaticStrategyPackRepository,
  EMPTY_AUTHORIZED_STRATEGY_PACK,
} from '../../src/poker-strategy/strategy-pack-repository.js'

const noopRunEventPort = { publish: async () => undefined }

function nextTimestamp(previous: string): string {
  return new Date(Date.parse(previous) + 1).toISOString()
}

/**
 * 把最终 AI 行动点从真实 Session 事实推进到 paused，再经公开命令恢复。
 * 该场景同时证明协调写入不推进 Poker stateVersion、retry 复用命令账本，
 * 并让新 Run 与唯一 failed leaf 建立 replacement lineage。
 */
export async function assertM48PlayerCoordinationApplicationFlow(
  sql: Sql,
): Promise<void> {
  await assertM48PlayerCoordinationSchema(sql)
  await runDatabaseTestWithCleanup(
    async () => {
      const owner = await resolveOwnerScope(sql, { ownerId: 'local-user' })
      const strategyPackRepository = createStaticStrategyPackRepository()
      const strategyDependency = encodeStrategyPackAuditReference({
        datasetId: EMPTY_AUTHORIZED_STRATEGY_PACK.datasetId,
        datasetVersion: EMPTY_AUTHORIZED_STRATEGY_PACK.datasetVersion,
      })
      const identity = await createSessionFixture(sql, 7)
      const prepared = await prepareTerminalAgentTurn(sql, owner, identity)
      const hand = prepared.state.poker.hand
      const actorSeatNumber = hand?.currentActorSeatNumber
      if (
        hand === null ||
        typeof actorSeatNumber !== 'number' ||
        actorSeatNumber < 1 ||
        actorSeatNumber > 8
      ) {
        throw new Error('M4.8 fixture 未停在有效 AI 行动点。')
      }
      const actor = prepared.state.poker.seats.find(
        (seat) => seat.seatNumber === actorSeatNumber && !seat.isUser,
      )
      if (actor === undefined) {
        throw new Error('M4.8 fixture 未找到当前 AI。')
      }
      const eventCountBeforeCoordination = await sql<
        readonly { readonly eventCount: number }[]
      >`
        SELECT count(*)::int AS "eventCount"
        FROM app_private.session_events
        WHERE session_id = ${identity.sessionId}::uuid
      `
      const initialEventCount = eventCountBeforeCoordination[0]?.eventCount
      if (
        typeof initialEventCount !== 'number' ||
        !Number.isSafeInteger(initialEventCount)
      ) {
        throw new Error('M4.8 fixture 未读取到初始事件计数。')
      }

      const runCoordinator = createAgentRunCoordinator({
        sql,
        owner,
        registry: productionRuntimeRegistry,
        eventPort: noopRunEventPort,
      })
      const coordinator = createSessionAgentCoordinator({
        sql,
        owner,
        registry: productionRuntimeRegistry,
        runCoordinator,
        strategyPackRepository,
        runEventPort: noopRunEventPort,
      })
      const startedAt = new Date().toISOString()
      const originalRunId = randomUUID()
      const originalRequestId = randomUUID()
      const started = await coordinator.startIfNeeded({
        sessionId: identity.sessionId,
        agentRunId: originalRunId,
        decisionRequestId: originalRequestId,
        actorParticipantId: actor.playerId,
        actorSeatNumber,
        idempotencyKey: `m48-start:${originalRunId}`,
        dataDependencies: [strategyDependency],
        createdAt: startedAt,
        trigger: 'initial',
        supersedesRunId: null,
        commandLedgerId: null,
      })
      expect(started.kind).toBe('started')
      expect(started.effects.sessionEvents).toHaveLength(1)
      expect(started.effects.sessionEvents[0]).toMatchObject({
        type: 'agentStarted',
        stateVersion: prepared.state.stateVersion,
      })

      const claimed = await runCoordinator.workerControl.claimNext({
        runtimeType: 'player',
        leaseOwner: 'm48-pause:player:0',
      })
      expect(claimed.kind).toBe('claimed')
      if (claimed.kind !== 'claimed') {
        throw new Error('M4.8 fixture 未领取初始 Player Run。')
      }
      const running = await runCoordinator.workerControl.markRunning(
        claimed.authority,
      )
      expect(running.runId).toBe(originalRunId)
      const playerAuthority = issueRuntimeCommitAuthority({
        runtimeType: 'player',
        runId: originalRunId,
        leaseOwner: claimed.authority.leaseOwner,
        fencingToken: claimed.authority.fencingToken,
      })
      const foundationRepository = createAgentFoundationAuditRepository()
      const initialAttempt = await runDatabaseTransaction(sql, (transaction) =>
        foundationRepository.startBudgetedAgentAttemptAudit(
          transaction,
          owner,
          playerAuthority,
          {
            sessionId: identity.sessionId,
            agentRunId: originalRunId,
            stage: 'player.bounded-choice',
            provider: 'deepseek',
            model: 'deepseek-chat',
            attemptType: 'initial',
            routingReasonCode: null,
            estimatedInputTokens: 1,
            requestedMaximumOutputTokens: 1,
            reservedCostMicrounits: 1,
            requestProjectionHash: '0'.repeat(64),
          },
        ),
      )
      expect(initialAttempt).toMatchObject({
        kind: 'started',
        attemptNumber: 0,
      })
      if (initialAttempt.kind !== 'started') {
        throw new Error('M4.8 fixture 未能启动 initial Attempt。')
      }
      await expect(
        runDatabaseTransaction(sql, (transaction) =>
          foundationRepository.finishAgentAttemptAudit(
            transaction,
            owner,
            playerAuthority,
            {
              sessionId: identity.sessionId,
              agentRunId: originalRunId,
              attemptId: initialAttempt.attemptId,
              lifecycle: 'completed',
              accepted: false,
              stale: false,
              interrupted: false,
              inputTokens: 1,
              outputTokens: 1,
              costMicrounits: 1,
              durationMs: 1,
              errorCode: null,
              responseProjectionHash: '1'.repeat(64),
              validationStatus: 'invalid',
              usageAccounting: 'providerReported',
              costAccounting: 'allInputAtCacheMiss',
              completedAt: new Date().toISOString(),
            },
          ),
        ),
      ).resolves.toBe('recorded')

      const correction = await coordinator.startCorrectionAttempt({
        sessionId: identity.sessionId,
        agentRunId: originalRunId,
        decisionRequestId: originalRequestId,
        authority: playerAuthority,
        attemptAt: new Date(Date.now() + 500).toISOString(),
        stage: 'player.bounded-choice',
        provider: 'deepseek',
        model: 'deepseek-chat',
        attemptType: 'correction',
        routingReasonCode: 'content_correction',
        estimatedInputTokens: 1,
        requestedMaximumOutputTokens: 1,
        reservedCostMicrounits: 1,
        requestProjectionHash: 'a'.repeat(64),
      })
      expect(correction).toMatchObject({ kind: 'started' })
      if (correction.kind !== 'started') {
        throw new Error('M4.8 fixture 未能启动 correction Attempt。')
      }
      const correctionSurface = await sql<
        readonly {
          readonly attemptId: string
          readonly lifecycle: string
          readonly event: {
            readonly type: string
            readonly attemptId: string
            readonly actorSeatNumber: number
            readonly repairOrdinal: number
          }
        }[]
      >`
        SELECT
          attempt.id::text AS "attemptId",
          attempt.lifecycle,
          event.private_event_payload->'event' AS event
        FROM app_private.agent_attempts AS attempt
        JOIN app_private.session_events AS event
          ON event.session_id = attempt.session_id
         AND event.private_event_payload->'event'->>'attemptId' = attempt.id::text
        WHERE attempt.id = ${correction.attemptId}::uuid
      `
      expect(correctionSurface).toEqual([
        expect.objectContaining({
          attemptId: correction.attemptId,
          lifecycle: 'started',
          event: expect.objectContaining({
            type: 'agentRepairAttempted',
            attemptId: correction.attemptId,
            actorSeatNumber,
            repairOrdinal: 1,
          }),
        }),
      ])

      // `markRunning()` 在数据库侧记录实际开始时间；暂停测试时间必须在
      // 它完成之后，不能复用较早的初始 Run 创建时间。
      const pausedAt = new Date(Date.now() + 1_000).toISOString()
      const paused = await coordinator.pauseAfterFailure({
        sessionId: identity.sessionId,
        agentRunId: originalRunId,
        decisionRequestId: originalRequestId,
        authority: playerAuthority,
        reason: 'provider_timeout',
        settledAt: pausedAt,
      })
      expect(paused.kind).toBe('paused')
      expect(paused.effects.sessionEvents).toEqual([
        expect.objectContaining({
          type: 'agentPaused',
          stateVersion: prepared.state.stateVersion,
        }),
      ])
      expect(await readPrivateState(sql, identity.sessionId)).toEqual(
        prepared.state,
      )

      const pausedSurface = await sql<
        readonly {
          readonly stateVersion: number
          readonly agentRunState: string
          readonly activePlayerRunId: string | null
          readonly activeDecisionRequestId: string | null
          readonly lifecycle: string
          readonly terminationReason: string | null
          readonly privatePayloadVersion: number
        }[]
      >`
        SELECT
          (SELECT state_version::float8 FROM app_private.sessions
           WHERE id = ${identity.sessionId}::uuid) AS "stateVersion",
          (SELECT agent_run_state FROM app_private.sessions
           WHERE id = ${identity.sessionId}::uuid) AS "agentRunState",
          (SELECT active_player_run_id::text FROM app_private.sessions
           WHERE id = ${identity.sessionId}::uuid) AS "activePlayerRunId",
          (SELECT active_decision_request_id::text FROM app_private.sessions
           WHERE id = ${identity.sessionId}::uuid) AS "activeDecisionRequestId",
          (SELECT lifecycle FROM app_private.agent_runs
           WHERE id = ${originalRunId}::uuid) AS lifecycle,
          (SELECT termination_reason FROM app_private.agent_runs
           WHERE id = ${originalRunId}::uuid) AS "terminationReason",
          (SELECT private_event_payload_version FROM app_private.session_events
           WHERE session_id = ${identity.sessionId}::uuid
           ORDER BY event_seq DESC LIMIT 1) AS "privatePayloadVersion"
      `
      expect(pausedSurface).toEqual([
        {
          stateVersion: prepared.state.stateVersion,
          agentRunState: 'paused',
          activePlayerRunId: null,
          activeDecisionRequestId: null,
          lifecycle: 'failed',
          terminationReason: 'provider_timeout',
          privatePayloadVersion: 1,
        },
      ])

      const commandId = randomUUID()
      let commandAt = nextTimestamp(pausedAt)
      const makeCommands = () =>
        createSessionCommandExecutor({
          sql,
          owner,
          handlers: createSessionCommandHandlerMap({
            bindings: [
              createEndSessionHandlerBinding({ owner }),
              createRetryAgentHandlerBinding({
                owner,
                registry: productionRuntimeRegistry,
                strategyPackRepository,
                nextRunId: randomUUID,
                nextDecisionRequestId: randomUUID,
              }),
            ],
          }),
          mutationRepository: productionSessionMutationRepository,
          recoveryRepository: productionSessionRecoveryRepository,
          snapshotProjectorBinding: createPublicSessionBindings(owner).command,
          now: () => commandAt,
          nextEventId: randomUUID,
          committedEventPublisher: { publish: () => undefined },
        })
      const commands = makeCommands()
      const command = {
        sessionId: identity.sessionId,
        commandId,
        expectedStateVersion: prepared.state.stateVersion,
        type: 'retryAgent' as const,
        payload: {},
      }
      const retry = await commands.execute(command)
      expect(retry).toMatchObject({ kind: 'completed', origin: 'newCommit' })
      const replay = await commands.execute(command)
      expect(replay).toMatchObject({ kind: 'completed', origin: 'replay' })

      const retrySurface = await sql<
        readonly {
          readonly stateVersion: number
          readonly agentRunState: string
          readonly activePlayerRunId: string | null
          readonly activeDecisionRequestId: string | null
          readonly predecessorLifecycle: string
          readonly replacementRunId: string | null
          readonly parentRunId: string | null
          readonly replacementLifecycle: string | null
          readonly eventCount: number
        }[]
      >`
        SELECT
          (SELECT state_version::float8 FROM app_private.sessions
           WHERE id = ${identity.sessionId}::uuid) AS "stateVersion",
          (SELECT agent_run_state FROM app_private.sessions
           WHERE id = ${identity.sessionId}::uuid) AS "agentRunState",
          (SELECT active_player_run_id::text FROM app_private.sessions
           WHERE id = ${identity.sessionId}::uuid) AS "activePlayerRunId",
          (SELECT active_decision_request_id::text FROM app_private.sessions
           WHERE id = ${identity.sessionId}::uuid) AS "activeDecisionRequestId",
          predecessor.lifecycle AS "predecessorLifecycle",
          predecessor.replacement_run_id::text AS "replacementRunId",
          replacement.parent_run_id::text AS "parentRunId",
          replacement.lifecycle AS "replacementLifecycle",
          (SELECT count(*)::int FROM app_private.session_events
           WHERE session_id = ${identity.sessionId}::uuid) AS "eventCount"
        FROM app_private.agent_runs AS predecessor
        JOIN app_private.agent_runs AS replacement
          ON replacement.id = predecessor.replacement_run_id
        WHERE predecessor.id = ${originalRunId}::uuid
      `
      expect(retrySurface).toEqual([
        {
          stateVersion: prepared.state.stateVersion,
          agentRunState: 'thinking',
          activePlayerRunId: expect.any(String),
          activeDecisionRequestId: expect.any(String),
          predecessorLifecycle: 'failed',
          replacementRunId: expect.any(String),
          parentRunId: originalRunId,
          replacementLifecycle: 'queued',
          eventCount: initialEventCount + 4,
        },
      ])
      expect(retrySurface[0]?.activePlayerRunId).toBe(
        retrySurface[0]?.replacementRunId,
      )
      // 第二次失败仍是同一个扑克版本，旧目标必须在锁内拒绝。
      const replacementId = retrySurface[0]!.activePlayerRunId!
      const replacementRequest = retrySurface[0]!.activeDecisionRequestId!
      const secondClaim = await runCoordinator.workerControl.claimNext({
        runtimeType: 'player',
        leaseOwner: 'm76-second-failure',
      })
      if (secondClaim.kind !== 'claimed')
        throw new Error('M7.6 未领取替代运行。')
      expect(
        (await runCoordinator.workerControl.markRunning(secondClaim.authority))
          .runId,
      ).toBe(replacementId)
      const secondAuthority = issueRuntimeCommitAuthority({
        runtimeType: 'player',
        runId: replacementId,
        leaseOwner: secondClaim.authority.leaseOwner,
        fencingToken: secondClaim.authority.fencingToken,
      })
      const secondPausedAt = new Date(Date.now() + 1_000).toISOString()
      expect(
        (
          await coordinator.pauseAfterFailure({
            sessionId: identity.sessionId,
            agentRunId: replacementId,
            decisionRequestId: replacementRequest,
            authority: secondAuthority,
            reason: 'provider_timeout',
            settledAt: secondPausedAt,
          })
        ).kind,
      ).toBe('paused')
      commandAt = nextTimestamp(secondPausedAt)
      const aiReader = createSessionAiStatusRepository({ sql, owner })
      const secondPaused = await aiReader.getById(identity.sessionId)
      expect(secondPaused).toMatchObject({
        stateVersion: prepared.state.stateVersion,
        coordination: {
          state: 'paused',
          run: { runId: replacementId, trigger: 'manualRetry' },
        },
      })
      for (const type of ['retryAgent', 'endSession'] as const) {
        const rejected = await commands.execute({
          ...command,
          commandId: randomUUID(),
          type,
          payload: { expectedPausedRunId: originalRunId },
        })
        expect(rejected).toMatchObject({
          kind: 'rejected',
          response: { code: 'PAUSED_RUN_CONFLICT' },
        })
      }
      expect(await aiReader.getById(identity.sessionId)).toEqual(secondPaused)
      expect(await readPrivateState(sql, identity.sessionId)).toEqual(
        prepared.state,
      )
      const targetCommand = {
        ...command,
        commandId: randomUUID(),
        payload: { expectedPausedRunId: replacementId },
      }
      const independentCommands = makeCommands()
      const competition = await Promise.all([
        commands.execute(targetCommand),
        independentCommands.execute({
          ...targetCommand,
          commandId: randomUUID(),
          type: 'endSession',
        }),
      ])
      expect(competition.filter((r) => r.kind === 'completed')).toHaveLength(1)
      expect(competition.filter((r) => r.kind === 'rejected')).toHaveLength(1)
      if (competition[0]!.kind === 'completed') {
        expect(await commands.execute(targetCommand)).toMatchObject({
          kind: 'completed',
          origin: 'replay',
        })
        await expect(
          commands.execute({
            ...targetCommand,
            payload: { expectedPausedRunId: originalRunId },
          }),
        ).rejects.toMatchObject({
          name: 'CommandPayloadConflictError',
        })
      }
    },
    () =>
      runDatabaseTransaction(sql, async (transaction) => {
        const cleanupOwner = await resolveOwnerScope(transaction, {
          ownerId: 'local-user',
        })
        await clearOwnerSessionData(transaction, cleanupOwner, {
          deletedAt: new Date().toISOString(),
        })
      }),
  )
}
