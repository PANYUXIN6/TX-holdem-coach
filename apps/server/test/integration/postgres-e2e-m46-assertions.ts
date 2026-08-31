import { randomUUID } from 'node:crypto'
import type { Sql, TransactionSql } from 'postgres'
import { expect } from 'vitest'
import { createAgentRunCoordinator } from '../../src/agents/foundation/agent-run-coordinator.js'
import { createAgentWorker } from '../../src/agents/foundation/agent-worker.js'
import type { AgentRunWorkerControl } from '../../src/agents/foundation/agent-worker-ports.js'
import { createCapabilityExecutor } from '../../src/agents/foundation/capability-executor.js'
import { createModelGateway } from '../../src/agents/foundation/model-gateway.js'
import type { ModelProviderAdapter } from '../../src/agents/foundation/model-gateway-protocol.js'
import {
  isRuntimeCommitAuthority,
  type RuntimeCommitAuthority,
} from '../../src/agents/foundation/runtime-ports.js'
import { createSensitiveValueScanner } from '../../src/agents/model-gateway/sensitive-value-scanner.js'
import { deepSeekPricingPolicy } from '../../src/agents/model-gateway/model-pricing-policy.js'
import { productionRuntimeRegistry } from '../../src/agents/production-runtime-registry.js'
import { playerDecisionCapabilityDefinitions } from '../../src/agents/player/player-decision-capabilities.js'
import { playerDecisionPreprocessingPlan } from '../../src/agents/player/player-decision-preprocessing-plan.js'
import { createPlayerRuntimeExecutor } from '../../src/agents/player/player-runtime-executor.js'
import { createPlayerCommitResultPort } from '../../src/agents/player/player-commit-gate.js'
import {
  isPlayerRuntimeCandidateResultV1,
  type PlayerRuntimeCandidateResultV1,
  type PlayerRuntimeResultPort,
} from '../../src/agents/player/player-runtime-result-port.js'
import { encodeStrategyPackAuditReference } from '../../src/agents/player/player-strategy-pack-audit-reference.js'
import { playerRuntimeDefinition } from '../../src/agents/player/foundation-definition.js'
import { playerModelRoutePolicy } from '../../src/agents/player/route-policy.js'
import type { DatabaseClient } from '../../src/db/client.js'
import { createAgentFoundationAuditRepository } from '../../src/persistence/agent-foundation-audit-repository.js'
import { runDatabaseTransaction } from '../../src/persistence/database-transaction.js'
import { productionSessionMutationRepository } from '../../src/persistence/session-mutation-repository.js'
import { productionSessionRecoveryRepository } from '../../src/persistence/session-recovery-repository.js'
import { createPostgresPlayerDecisionReferencePort } from '../../src/persistence/player-decision-reference-authority.js'
import { createPlayerDecisionRepository } from '../../src/persistence/player-decision-repository.js'
import {
  completeCommand,
  failCommand,
  readExistingCommandResult,
  registerCommand,
} from '../../src/persistence/command-ledger-repository.js'
import { createPlayerModelAttemptControlV1 } from '../../src/persistence/player-model-attempt-control.js'
import { createPostgresPlayerRunObservationPort } from '../../src/persistence/player-run-observation-port.js'
import type { PlayerCommitFailureCode } from '../../src/persistence/player-commit-gate-repository.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import {
  patchPlayerTimeoutSettings,
  readResolvedPlayerTimeoutSettings,
} from '../../src/persistence/player-settings-repository.js'
import { createPlayerCommitSessionComposition } from '../../src/sessions/command-execution/session-command-executor.js'
import {
  createStaticStrategyPackRepository,
  EMPTY_AUTHORIZED_STRATEGY_PACK,
} from '../../src/poker-strategy/strategy-pack-repository.js'
import {
  clearLocalOwnerSessions,
  projectPublicSnapshot,
} from './database-m32-assertions.js'
import {
  createSessionFixture,
  prepareObservableTerminalAgentTurn,
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

async function executeWithPlayerRuntimeDiagnostics(input: {
  readonly sql: Sql
  readonly runId: string
  readonly execute: () => Promise<void>
  readonly renewLease: () => Promise<unknown>
}): Promise<void> {
  try {
    await executeWithLeaseHeartbeat(input.execute, input.renewLease)
  } catch (error) {
    const diagnostics = await input.sql<
      readonly {
        readonly runLifecycle: string
        readonly deadlineExpired: boolean
        readonly leaseExpired: boolean
        readonly deadlineDurationMs: number
        readonly remainingDeadlineMs: number
        readonly budgetWallClockMs: number
        readonly attemptLifecycle: string | null
        readonly attemptErrorCategory: string | null
        readonly validationStatus: string | null
      }[]
    >`
      SELECT
        run.lifecycle AS "runLifecycle",
        run.deadline_at <= clock_timestamp() AS "deadlineExpired",
        run.lease_expires_at <= clock_timestamp() AS "leaseExpired",
        extract(epoch FROM (run.deadline_at - run.created_at)) * 1000
          AS "deadlineDurationMs",
        extract(epoch FROM (run.deadline_at - clock_timestamp())) * 1000
          AS "remainingDeadlineMs",
        (run.budget_payload->'budget'->>'maxWallClockMs')::float8
          AS "budgetWallClockMs",
        attempt.lifecycle AS "attemptLifecycle",
        attempt.error_category AS "attemptErrorCategory",
        attempt.attempt_payload->>'validationStatus' AS "validationStatus"
      FROM app_private.agent_runs AS run
      LEFT JOIN app_private.agent_attempts AS attempt
        ON attempt.agent_run_id = run.id
      WHERE run.id = ${input.runId}::uuid
      ORDER BY attempt.attempt_number DESC
      LIMIT 1
    `
    throw new Error(
      `M4.6 Player Runtime 失败诊断：${JSON.stringify(diagnostics)}`,
      { cause: error },
    )
  }
}

function candidateAdapter(
  options: { readonly forceFold?: boolean } = {},
): ModelProviderAdapter & {
  calls: number
} {
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
      const candidates = context.sections[0]?.payload.projection.candidates
      const candidateActionId =
        (options.forceFold === true
          ? candidates?.find((candidate) => candidate[1] === 0)?.[0]
          : candidates?.[0]?.[0]) ?? undefined
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

export interface M47CommitScenario {
  /**
   * E2E 中 Worker 的控制面必须能与命令事务并发续租；生产连接池同样如此。
   * 默认复用当前连接，供 M4.6 的单连接 selected-result 验收使用。
   */
  readonly workerControl?: AgentRunWorkerControl
  readonly rejectionScenarios?: readonly M47CommitRejectionScenario[]
  readonly expectedFailureCode?: PlayerCommitFailureCode
  readonly failSessionPublish?: boolean
  readonly failRunPublish?: boolean
  readonly completeHand?: boolean
  readonly failAfterLedger?: boolean
  readonly assertAfterLedger?: (input: {
    readonly transaction: TransactionSql
    readonly sessionId: string
    readonly handId: string
    readonly decisionRecordId: string
  }) => Promise<void>
  readonly onSelected?: (input: {
    readonly sql: Sql
    readonly owner: Awaited<ReturnType<typeof resolveOwnerScope>>
    readonly sessionId: string
    readonly runId: string
    readonly authority: RuntimeCommitAuthority<'player'>
    readonly result: PlayerRuntimeCandidateResultV1
  }) => Promise<void>
}

export interface M47CommitRejectionScenario {
  readonly name: string
  readonly expectedFailureCode: PlayerCommitFailureCode
  readonly beforeCommit: (input: {
    readonly sql: Sql
    readonly sessionId: string
    readonly handId: string
    readonly runId: string
    readonly decisionRecordId: string
    readonly authority: RuntimeCommitAuthority<'player'>
    readonly result: PlayerRuntimeCandidateResultV1
  }) => Promise<void>
}

function createSavepointSql(transaction: TransactionSql): Sql {
  return new Proxy(transaction, {
    get(target, property, receiver) {
      if (property === 'begin') {
        return (operation: (nested: TransactionSql) => unknown) =>
          transaction.savepoint(operation)
      }
      return Reflect.get(target, property, receiver)
    },
  }) as unknown as Sql
}

function createFailAfterLedgerRepository(
  assertAfterLedger?: (transaction: TransactionSql) => Promise<void>,
) {
  return Object.freeze({
    registerCommand,
    readExistingCommandResult,
    completeCommand: async (...input: Parameters<typeof completeCommand>) => {
      await completeCommand(...input)
      await assertAfterLedger?.(input[0])
      throw new Error('M4.7 在 ledger 完成后注入失败。')
    },
    failCommand,
  })
}

export async function assertM46PlayerDecisionApplicationFlow(
  sql: Sql,
  input: {
    readonly commitSelectedDecision?: boolean
  } & M47CommitScenario = {},
): Promise<void> {
  let publishedEventCount = 0
  const owner = await resolveOwnerScope(sql, { ownerId: 'local-user' })
  const originalTimeoutSettings = await readResolvedPlayerTimeoutSettings(
    sql,
    owner,
  )
  try {
    // 该 E2E 验证 Player 全链路而非 deadline 策略。显式使用足够覆盖远程
    // PostgreSQL 往返的测试预算，并在 finally 恢复，避免依赖其他里程碑残留设置。
    await sql.begin((transaction) =>
      patchPlayerTimeoutSettings(transaction, owner, {
        attemptTimeoutSeconds: 15,
        decisionDeadlineSeconds: 120,
      }),
    )
    const identityGraph = await createSessionFixture(sql, 0)
    if (input.completeHand === true) {
      await prepareObservableTerminalAgentTurn(sql, owner, identityGraph)
    }
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
    // M4.7 以独立连接提供 Worker 控制面，使 lease heartbeat 能与单连接的
    // E2E 命令事务并发。M4.6 保持当前连接，覆盖其原有 selected-result 流程。
    const workerControl = input.workerControl ?? coordinator.workerControl
    const claim = await workerControl.claimNext({
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
    const runningRun = await workerControl.markRunning(claim.authority)
    const authority = claim.authority
    if (!isRuntimeCommitAuthority(authority, 'player')) {
      throw new Error('M4.6 E2E authority 无效。')
    }

    const database = asDatabaseClient(sql)
    const decisionRepository = createPlayerDecisionRepository()
    const foundationRepository = createAgentFoundationAuditRepository()
    const adapter = candidateAdapter({ forceFold: input.completeHand === true })
    const publishedResults: unknown[] = []
    let reservationSequence = 0
    const beforeState = await readPrivateState(sql, identityGraph.sessionId)
    publishedEventCount = 0
    let publishSelectedResult: PlayerRuntimeResultPort['publish'] = async ({
      authority: resultAuthority,
      result,
    }) => {
      expect(resultAuthority).toEqual(authority)
      expect(isPlayerRuntimeCandidateResultV1(result)).toBe(true)
      publishedResults.push(result)
    }
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
          correctionAttemptPort: {
            async startCorrectionAttempt() {
              throw new Error('M4.6 E2E 不应触发 correction Attempt。')
            },
          },
        }),
      resultPort: {
        publish: (published) => publishSelectedResult(published),
      },
    })
    if (runningRun.runtimeType !== 'player') {
      throw new Error('M4.6 E2E running Run 类型无效。')
    }
    expect(runningRun.budget.maxWallClockMs).toBe(120_000)
    expect(
      Date.parse(runningRun.deadlineAt) - Date.parse(runningRun.createdAt),
    ).toBe(120_000)
    // 远程 E2E 的 executor 组装和首个 strict read 也处于真实 lease 生命周期中。
    // 在开始 resume 前续租，避免网络往返耗尽 lease 而把测试准备阶段误判为
    // fencing 丢失；后续过期/owner 失配场景仍在 selected Result 之后显式构造。
    await workerControl.renewLease(authority)
    const initialResume = await runDatabaseTransaction(sql, (transaction) =>
      decisionRepository.readForResume(transaction, owner, authority),
    )
    expect(initialResume).toEqual({ kind: 'none' })
    await executeWithPlayerRuntimeDiagnostics({
      sql,
      runId,
      execute: () => executor.execute(runningRun, new AbortController().signal),
      renewLease: () => workerControl.renewLease(authority),
    })

    expect(adapter.calls).toBe(1)
    expect(reservationSequence).toBe(4)
    expect(publishedResults).toHaveLength(1)
    // M4.6 自身验证 selected resume；M4.7 已由成功场景中的真实 Worker
    // 重领并恢复 selected Run，无需在每个 Commit Gate 场景前重复一次完整执行。
    if (input.commitSelectedDecision !== true) {
      await executeWithPlayerRuntimeDiagnostics({
        sql,
        runId,
        execute: () =>
          executor.execute(runningRun, new AbortController().signal),
        renewLease: () => workerControl.renewLease(authority),
      })
      expect(adapter.calls).toBe(1)
      expect(reservationSequence).toBe(4)
      expect(publishedResults).toHaveLength(2)
    }
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
    const selectedResult = publishedResults[0]
    if (!isPlayerRuntimeCandidateResultV1(selectedResult)) {
      throw new Error('M4.7 E2E 缺少认证 selected ResultPort 结果。')
    }
    await input.onSelected?.({
      sql,
      owner,
      sessionId: identityGraph.sessionId,
      runId,
      authority,
      result: selectedResult,
    })
    if (input.commitSelectedDecision !== true) {
      const afterState = await readPrivateState(sql, identityGraph.sessionId)
      expect(afterState.stateVersion).toBe(beforeState.stateVersion)
      expect(afterState.poker).toEqual(beforeState.poker)
      expect(publishedEventCount).toBe(0)
      const runRows = await sql<readonly { lifecycle: string }[]>`
        SELECT lifecycle FROM app_private.agent_runs WHERE id = ${runId}::uuid
      `
      expect(runRows).toEqual([{ lifecycle: 'running' }])
      return
    }

    const sessionEvents: unknown[] = []
    const runEvents: unknown[] = []
    const sessionPublicationStates: Promise<
      readonly {
        readonly committedDecisionCount: number
        readonly completedRunCount: number
      }[]
    >[] = []
    const createCommitSurface = (gateSql: Sql) => {
      const { playerCommitGate: gate } = createPlayerCommitSessionComposition({
        session: {
          sql: gateSql,
          owner,
          mutationRepository: productionSessionMutationRepository,
          recoveryRepository: productionSessionRecoveryRepository,
          ...(input.failAfterLedger === true
            ? {
                commandLedgerRepository: createFailAfterLedgerRepository(
                  async (transaction) => {
                    await input.assertAfterLedger?.({
                      transaction,
                      sessionId: identityGraph.sessionId,
                      handId: identityGraph.handId,
                      decisionRecordId: selectedResult.decisionRecordId,
                    })
                  },
                ),
              }
            : {}),
          snapshotProjectorBinding: {
            bindReadPort: () => Object.freeze({}),
            projector: {
              async project({ state, session, eventSeq }) {
                return projectPublicSnapshot(state, session, eventSeq)
              },
            },
          },
          now: () => new Date().toISOString(),
          nextEventId: randomUUID,
          committedEventPublisher: {
            publish: (events) => {
              if (input.failSessionPublish === true) {
                throw new Error('M4.7 注入 Session 发布失败。')
              }
              sessionPublicationStates.push(sql`
                SELECT
                  (SELECT count(*)::int
                   FROM app_private.player_decisions
                   WHERE session_id = ${identityGraph.sessionId}::uuid
                     AND status = 'committed') AS "committedDecisionCount",
                  (SELECT count(*)::int
                   FROM app_private.agent_runs
                   WHERE session_id = ${identityGraph.sessionId}::uuid
                     AND lifecycle = 'completed') AS "completedRunCount"
              `)
              sessionEvents.push(...events)
            },
          },
        },
        player: {
          runEventPort: {
            publish: async (events) => {
              if (input.failRunPublish === true) {
                throw new Error('M4.7 注入 Run 发布失败。')
              }
              const visible = await sql<
                readonly {
                  readonly committedDecisionCount: number
                  readonly completedRunCount: number
                }[]
              >`
                SELECT
                  (SELECT count(*)::int
                   FROM app_private.player_decisions
                   WHERE session_id = ${identityGraph.sessionId}::uuid
                     AND status = 'committed') AS "committedDecisionCount",
                  (SELECT count(*)::int
                   FROM app_private.agent_runs
                   WHERE session_id = ${identityGraph.sessionId}::uuid
                     AND lifecycle = 'completed') AS "completedRunCount"
              `
              expect(visible).toEqual([
                { committedDecisionCount: 1, completedRunCount: 1 },
              ])
              runEvents.push(...events)
            },
          },
        },
      })
      return { gate, resultPort: createPlayerCommitResultPort({ gate }) }
    }
    const { gate, resultPort } = createCommitSurface(sql)
    if (input.rejectionScenarios !== undefined) {
      // 矩阵复用同一个 selected Run；只延长测试夹具的总 deadline，单项仍在
      // 各自事务内显式构造 deadline/lease 失效，并在回滚后恢复 live 基线。
      await sql`
        UPDATE app_private.agent_runs
        SET deadline_at = clock_timestamp() + interval '10 minutes',
            updated_at = clock_timestamp()
        WHERE id = ${runId}::uuid
      `
    }
    const readCommitSurfaces = () =>
      sql<
        readonly {
          readonly stateVersion: number | null
          readonly handStatus: string | null
          readonly decisionStatus: string | null
          readonly runLifecycle: string | null
        }[]
      >`
        SELECT
          (SELECT state_version::float8
           FROM app_private.sessions
           WHERE id = ${identityGraph.sessionId}::uuid) AS "stateVersion",
          (SELECT status
           FROM app_private.hands
           WHERE id = ${identityGraph.handId}::uuid) AS "handStatus",
          (SELECT status
           FROM app_private.player_decisions
           WHERE id = ${selectedResult.decisionRecordId}::uuid) AS "decisionStatus",
          (SELECT lifecycle
           FROM app_private.agent_runs
           WHERE id = ${runId}::uuid) AS "runLifecycle"
      `
    const surfacesBeforeGate = await readCommitSurfaces()
    expect(surfacesBeforeGate).toHaveLength(1)

    if (input.rejectionScenarios !== undefined) {
      for (const scenario of input.rejectionScenarios) {
        await workerControl.renewLease(authority)
        await expect(
          sql.begin(async (transaction) => {
            const scenarioSql = createSavepointSql(transaction)
            await scenario.beforeCommit({
              sql: scenarioSql,
              sessionId: identityGraph.sessionId,
              handId: identityGraph.handId,
              runId,
              decisionRecordId: selectedResult.decisionRecordId,
              authority,
              result: selectedResult,
            })
            await createCommitSurface(scenarioSql).resultPort.publish({
              authority,
              result: selectedResult,
            })
          }),
        ).rejects.toMatchObject({
          code: scenario.expectedFailureCode,
        })
        const ledgerRows = await sql<readonly { readonly count: number }[]>`
          SELECT count(*)::int AS count
          FROM app_private.command_ledger
          WHERE command_id = ${selectedResult.decisionRecordId}::uuid
        `
        expect(ledgerRows, scenario.name).toEqual([{ count: 0 }])
        expect(await readCommitSurfaces(), scenario.name).toEqual(
          surfacesBeforeGate,
        )
      }
      return
    }
    if (input.expectedFailureCode !== undefined) {
      await expect(
        resultPort.publish({ authority, result: selectedResult }),
      ).rejects.toMatchObject({
        code: input.expectedFailureCode,
      })
      const ledgerRows = await sql<readonly { readonly count: number }[]>`
        SELECT count(*)::int AS count
        FROM app_private.command_ledger
        WHERE command_id = ${selectedResult.decisionRecordId}::uuid
      `
      expect(ledgerRows).toEqual([{ count: 0 }])
      expect(await readCommitSurfaces()).toEqual(surfacesBeforeGate)
      return
    }
    // 用真实 Worker 重新领取 selected Run。Player executor 只能经 production
    // ResultPort 进入 Gate，随后 Worker 读取 settlement 并报告 terminal。
    await sql`
      UPDATE app_private.agent_runs
      SET lifecycle = 'queued',
          lease_owner = NULL,
          lease_expires_at = NULL,
          started_at = NULL,
          completed_at = NULL,
          termination_reason = NULL,
          deadline_at = clock_timestamp() + (deadline_at - created_at),
          updated_at = clock_timestamp()
      WHERE id = ${runId}::uuid
    `
    publishSelectedResult = (published) => resultPort.publish(published)
    let reportSettlement!: (
      disposition: 'terminal' | 'authorityLost' | 'runtimeSettlementRequired',
    ) => void
    const workerSettlement = new Promise<
      'terminal' | 'authorityLost' | 'runtimeSettlementRequired'
    >((resolve) => {
      reportSettlement = resolve
    })
    const worker = createAgentWorker({
      control: workerControl,
      playerExecutor: executor,
      coachExecutor: { runtimeType: 'coach', async execute() {} },
      onDisposition: ({ runtimeType, runId: settledRunId, disposition }) => {
        if (runtimeType === 'player' && settledRunId === runId) {
          reportSettlement(disposition)
        }
      },
    })
    await worker.start()
    try {
      const workerOutcome = await Promise.race([
        workerSettlement,
        worker.fatal.then(({ category }) => `fatal:${category}` as const),
      ])
      expect(workerOutcome).toBe('terminal')
    } finally {
      await worker.stop()
    }
    if (input.failSessionPublish !== true) {
      await expect(Promise.all(sessionPublicationStates)).resolves.toEqual([
        [{ committedDecisionCount: 1, completedRunCount: 1 }],
      ])
    }
    if (input.failSessionPublish === true) {
      expect(sessionEvents).toHaveLength(0)
    } else {
      expect(sessionEvents.length).toBeGreaterThan(0)
    }
    expect(runEvents).toHaveLength(input.failRunPublish === true ? 0 : 1)
    const replay = await gate.commit({ authority, result: selectedResult })
    expect(replay).toMatchObject({
      origin: 'replay',
      decisionRecordId: selectedResult.decisionRecordId,
    })
    if (input.failSessionPublish !== true) {
      expect(sessionEvents.length).toBeGreaterThan(0)
    }
    expect(runEvents).toHaveLength(input.failRunPublish === true ? 0 : 1)

    const afterState = await readPrivateState(sql, identityGraph.sessionId)
    expect(afterState.stateVersion).toBeGreaterThan(beforeState.stateVersion)
    if (input.completeHand === true) {
      expect(afterState.poker.pokerPhase).toBe('betweenHands')
      const completedHandRows = await sql<
        readonly {
          readonly status: string
          readonly completedAt: string | null
        }[]
      >`
        SELECT status,
               to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                 AS "completedAt"
        FROM app_private.hands
        WHERE id = ${identityGraph.handId}::uuid
      `
      expect(completedHandRows).toEqual([
        { status: 'completed', completedAt: expect.any(String) },
      ])
    }
    const committedDecisionRows = await sql<
      readonly {
        status: string
        commandLedgerId: string | null
        committedAt: string | null
        lifecycle: string
      }[]
    >`
      SELECT decision.status,
             decision.command_ledger_id::text AS "commandLedgerId",
             decision.committed_at::text AS "committedAt",
             run.lifecycle
      FROM app_private.player_decisions AS decision
      INNER JOIN app_private.agent_runs AS run ON run.id = decision.agent_run_id
      WHERE decision.id = ${selectedResult.decisionRecordId}::uuid
    `
    expect(committedDecisionRows).toEqual([
      {
        status: 'committed',
        commandLedgerId: replay.commandLedgerId,
        committedAt: expect.any(String),
        lifecycle: 'completed',
      },
    ])
  } finally {
    try {
      await clearLocalOwnerSessions(sql)
    } finally {
      await sql.begin((transaction) =>
        patchPlayerTimeoutSettings(transaction, owner, originalTimeoutSettings),
      )
    }
  }
}
