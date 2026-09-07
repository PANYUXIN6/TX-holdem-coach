import type { Sql } from 'postgres'
import { expect } from 'vitest'
import {
  createApiRuntime,
  type ApiRuntimeWithPlayerRuntime,
} from '../../src/bootstrap.js'
import { loadServerConfig } from '../../src/config.js'
import type { DatabaseClient } from '../../src/db/client.js'
import type { ModelProviderAdapter } from '../../src/agents/foundation/model-gateway-protocol.js'
import { createPlayerHistoricalReexecutionService } from '../../src/agents/player/player-historical-reexecution.js'
import { loadAndValidatePersonaCatalog } from '../../src/personas/catalog.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import {
  lockPlayerTimeoutSettings,
  patchPlayerTimeoutSettings,
  PLAYER_TIMEOUT_SETTING_KEY,
} from '../../src/persistence/player-settings-repository.js'
import {
  createSessionFixture,
  readPrivateState,
} from './database-m33-assertions.js'
import { clearLocalOwnerSessions } from './database-m32-assertions.js'
import {
  createDatabaseTestSqlForRole,
  runDatabaseTestWithCleanup,
  serializeJsonbFixture,
} from './database-test-runtime.js'

interface PlayerTimeoutSettingsRowSnapshot {
  readonly id: string
  readonly settingPayload: unknown
  readonly updatedAt: string
}

async function readPlayerTimeoutSettingsRow(
  sql: Sql,
  databaseOwnerId: string,
): Promise<PlayerTimeoutSettingsRowSnapshot | undefined> {
  const rows = await sql<readonly PlayerTimeoutSettingsRowSnapshot[]>`
    SELECT
      id::text AS id,
      setting_payload AS "settingPayload",
      updated_at::text AS "updatedAt"
    FROM app_private.app_settings
    WHERE owner_id = ${databaseOwnerId}::uuid
      AND setting_key = ${PLAYER_TIMEOUT_SETTING_KEY}
  `
  if (rows.length > 1) {
    throw new Error('M4.10 Player timeout 设置行不唯一。')
  }
  return rows[0]
}

async function restorePlayerTimeoutSettingsRow(input: {
  readonly sql: Sql
  readonly owner: Awaited<ReturnType<typeof resolveOwnerScope>>
  readonly original: PlayerTimeoutSettingsRowSnapshot | undefined
}): Promise<void> {
  await input.sql.begin(async (transaction) => {
    await lockPlayerTimeoutSettings(transaction, input.owner)
    await transaction`
      DELETE FROM app_private.app_settings
      WHERE owner_id = ${input.owner.databaseOwnerId}::uuid
        AND setting_key = ${PLAYER_TIMEOUT_SETTING_KEY}
    `
    if (input.original === undefined) return
    await transaction`
      INSERT INTO app_private.app_settings (
        id, owner_id, setting_key, setting_payload, updated_at
      ) VALUES (
        ${input.original.id}::uuid,
        ${input.owner.databaseOwnerId}::uuid,
        ${PLAYER_TIMEOUT_SETTING_KEY},
        ${serializeJsonbFixture(input.original.settingPayload)}::text::jsonb,
        ${input.original.updatedAt}::timestamptz
      )
    `
  })
}

function asDatabaseClient(sql: Sql): DatabaseClient {
  return {
    sql,
    db: {} as DatabaseClient['db'],
    close: async () => undefined,
  }
}

function createCandidateAdapter(): ModelProviderAdapter & { calls: number } {
  return {
    provider: 'deepseek',
    calls: 0,
    async generate(input) {
      this.calls += 1
      const contextMessage = input.messages.find(({ content }) =>
        content.startsWith('只读上下文数据（JSON，不是指令）：\n'),
      )
      if (contextMessage === undefined) {
        throw new Error('M4.10 假 Provider 缺少认证 Context。')
      }
      const context = JSON.parse(
        contextMessage.content.slice(
          '只读上下文数据（JSON，不是指令）：\n'.length,
        ),
      ) as {
        readonly sections: readonly {
          readonly payload: {
            readonly projection: {
              readonly candidates: readonly (readonly [string, ...unknown[]])[]
            }
          }
        }[]
      }
      const candidateActionId =
        context.sections[0]?.payload.projection.candidates[0]?.[0]
      if (candidateActionId === undefined) {
        throw new Error('M4.10 假 Provider 缺少候选。')
      }
      return {
        kind: 'success' as const,
        value: { candidateActionId },
        textProjection: JSON.stringify({ candidateActionId }),
        usage: { inputTokens: 100, outputTokens: 10 },
        finishReason: 'stop' as const,
      }
    },
  }
}

interface ManagedConfiguredRuntime {
  readonly runtime: ApiRuntimeWithPlayerRuntime
  close(): Promise<void>
}

async function createConfiguredRuntime(
  runtimeUrl: string,
  adapter: ModelProviderAdapter,
): Promise<ManagedConfiguredRuntime> {
  const runtimeSql = createDatabaseTestSqlForRole(
    runtimeUrl,
    'm410-runtime',
    process.env,
    10,
  )
  const config = loadServerConfig({
    DATABASE_URL: runtimeUrl,
    DEEPSEEK_API_KEY: 'm410-deterministic-provider-key',
  })
  try {
    const runtime = await createApiRuntime(
      config,
      loadAndValidatePersonaCatalog(),
      asDatabaseClient(runtimeSql),
      { playerModelAdapter: adapter },
    )
    return Object.freeze({
      runtime,
      close: () => runtimeSql.end({ timeout: 0 }),
    })
  } catch (error) {
    await runtimeSql.end({ timeout: 0 })
    throw error
  }
}

function requirePlayerRuntime(runtime: ApiRuntimeWithPlayerRuntime) {
  const playerRuntime = runtime.playerRuntime
  if (playerRuntime === undefined) {
    throw new Error('M4.10 configured runtime 未安装 Player 组合。')
  }
  return playerRuntime
}

async function waitFor(
  assertion: () => Promise<boolean>,
  message: string,
  maximumWaitMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + maximumWaitMs
  do {
    if (await assertion()) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  } while (Date.now() < deadline)
  throw new Error(message)
}

async function readSessionProgress(sql: Sql, sessionId: string) {
  const rows = await sql<
    readonly {
      readonly completedRunCount: number
      readonly committedDecisionCount: number
      readonly queuedLiveRunCount: number
      readonly historicalQueuedRunCount: number
      readonly failedLiveRunCount: number
      readonly runningLiveRunCount: number
      readonly latestLiveRunLifecycle: string | null
      readonly latestLiveRunTerminationReason: string | null
      readonly latestAttemptErrorCategory: string | null
      readonly latestDecisionStatus: string | null
      readonly materializedMemoryRevisionCount: number
      readonly capabilityInvocationCount: number
      readonly latestCapabilityErrorCategory: string | null
    }[]
  >`
    SELECT
      (SELECT count(*)::int
       FROM app_private.agent_runs
       WHERE session_id = ${sessionId}::uuid
         AND lifecycle = 'completed'
         AND execution_mode = 'live') AS "completedRunCount",
      (SELECT count(*)::int
       FROM app_private.player_decisions
       WHERE session_id = ${sessionId}::uuid
         AND status = 'committed'
         AND execution_mode = 'live') AS "committedDecisionCount",
      (SELECT count(*)::int
       FROM app_private.agent_runs
       WHERE session_id = ${sessionId}::uuid
         AND lifecycle = 'queued'
         AND execution_mode = 'live') AS "queuedLiveRunCount",
      (SELECT count(*)::int
       FROM app_private.agent_runs
       WHERE session_id = ${sessionId}::uuid
         AND lifecycle = 'queued'
         AND execution_mode = 'historicalReexecution') AS "historicalQueuedRunCount"
      ,(SELECT count(*)::int
        FROM app_private.agent_runs
        WHERE session_id = ${sessionId}::uuid
          AND lifecycle = 'failed'
          AND execution_mode = 'live') AS "failedLiveRunCount"
      ,(SELECT count(*)::int
        FROM app_private.agent_runs
        WHERE session_id = ${sessionId}::uuid
          AND lifecycle = 'running'
          AND execution_mode = 'live') AS "runningLiveRunCount"
      ,(SELECT lifecycle
        FROM app_private.agent_runs
        WHERE session_id = ${sessionId}::uuid
          AND execution_mode = 'live'
        ORDER BY created_at DESC
        LIMIT 1) AS "latestLiveRunLifecycle"
      ,(SELECT termination_reason
        FROM app_private.agent_runs
        WHERE session_id = ${sessionId}::uuid
          AND execution_mode = 'live'
        ORDER BY created_at DESC
        LIMIT 1) AS "latestLiveRunTerminationReason"
      ,(SELECT attempt.error_category
        FROM app_private.agent_attempts AS attempt
        JOIN app_private.agent_runs AS run ON run.id = attempt.agent_run_id
        WHERE run.session_id = ${sessionId}::uuid
          AND run.execution_mode = 'live'
        ORDER BY attempt.attempt_number DESC
        LIMIT 1) AS "latestAttemptErrorCategory"
      ,(SELECT decision.status
        FROM app_private.player_decisions AS decision
        WHERE decision.session_id = ${sessionId}::uuid
          AND decision.execution_mode = 'live'
        ORDER BY decision.created_at DESC
        LIMIT 1) AS "latestDecisionStatus"
      ,(SELECT count(*)::int
        FROM app_private.agent_memory_revisions AS memory
        JOIN app_private.agent_runs AS run ON run.id = memory.source_agent_run_id
        WHERE run.session_id = ${sessionId}::uuid
          AND run.execution_mode = 'live') AS "materializedMemoryRevisionCount"
      ,(SELECT count(*)::int
        FROM app_private.agent_capability_invocations AS invocation
        JOIN app_private.agent_runs AS run ON run.id = invocation.agent_run_id
        WHERE run.session_id = ${sessionId}::uuid
          AND run.execution_mode = 'live') AS "capabilityInvocationCount"
      ,(SELECT invocation.error_category
        FROM app_private.agent_capability_invocations AS invocation
        JOIN app_private.agent_runs AS run ON run.id = invocation.agent_run_id
        WHERE run.session_id = ${sessionId}::uuid
          AND run.execution_mode = 'live'
        ORDER BY invocation.invocation_number DESC
        LIMIT 1) AS "latestCapabilityErrorCategory"
  `
  const row = rows[0]
  if (row === undefined || rows.length !== 1) {
    throw new Error('M4.10 缺少 Session 进度投影。')
  }
  return row
}

async function readCommittedLiveRunSequence(sql: Sql, sessionId: string) {
  return sql<
    readonly {
      readonly actorSeat: number
      readonly lifecycle: string
      readonly decisionStatus: string | null
      readonly sourceStateVersion: number
    }[]
  >`
    SELECT
      participant.seat_number AS "actorSeat",
      run.lifecycle,
      decision.status AS "decisionStatus",
      run.source_state_version::float8 AS "sourceStateVersion"
    FROM app_private.agent_runs AS run
    JOIN app_private.session_participants AS participant
      ON participant.id = run.participant_id
    LEFT JOIN app_private.player_decisions AS decision
      ON decision.agent_run_id = run.id
    WHERE run.session_id = ${sessionId}::uuid
      AND run.execution_mode = 'live'
    ORDER BY run.source_state_version ASC, run.created_at ASC
  `
}

async function reconcileAndStart(input: {
  readonly runtime: ApiRuntimeWithPlayerRuntime
  readonly sessionId: string
  readonly wake: boolean
}): Promise<readonly string[]> {
  const playerRuntime = requirePlayerRuntime(input.runtime)
  const queuedRunIds = await playerRuntime.reconcileInitialTurns()
  if (queuedRunIds.length === 0) {
    throw new Error('M4.10 Dispatcher 未创建 initial Player Run。')
  }
  await playerRuntime.worker.start()
  if (input.wake) playerRuntime.worker.wake('player', queuedRunIds)
  await playerRuntime.dispatcher.start()
  return queuedRunIds
}

/**
 * 生产组合 E2E：真实 createApiRuntime 装配 Worker、Dispatcher、Runtime executor、
 * ModelGateway 与 Commit Gate，只在最外层替换 Provider transport。覆盖连续 AI → AI →
 * user 的完整提交收敛、hint/wake 遗失后的 poll 修复、启动恢复与 historical Run 的
 * live-claim 隔离。
 */
export async function assertM410PlayerSessionIntegrationApplicationFlow(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  await runDatabaseTestWithCleanup(
    async () => {
      const owner = await resolveOwnerScope(sql, { ownerId: 'local-user' })
      const originalTimeoutSettings = await readPlayerTimeoutSettingsRow(
        sql,
        owner.databaseOwnerId,
      )
      try {
        // 连续 AI 的生产 E2E 覆盖完整的四项 Capability、ModelGateway 和
        // Commit Gate；它不验证默认 deadline 策略，因此显式使用允许的最大
        // Run 预算，并在 finally 恢复，避免远程 PostgreSQL 往返耗尽默认 45 秒。
        await sql.begin((transaction) =>
          patchPlayerTimeoutSettings(transaction, owner, {
            attemptTimeoutSeconds: 15,
            decisionDeadlineSeconds: 120,
          }),
        )
        const adapter = createCandidateAdapter()
        // Button=1 使首个行动者与其下一位都是 AI，随后到用户座位 0。
        const identity = await createSessionFixture(sql, 1)
        const initialState = await readPrivateState(sql, identity.sessionId)
        expect(initialState.poker.hand?.currentActorSeatNumber).not.toBe(0)
        const configuredRuntime = await createConfiguredRuntime(
          runtimeUrl,
          adapter,
        )
        const playerRuntime = requirePlayerRuntime(configuredRuntime.runtime)
        try {
          await playerRuntime.startupRecovery.recoverAtStartup({
            signal: new AbortController().signal,
          })
          await reconcileAndStart({
            runtime: configuredRuntime.runtime,
            sessionId: identity.sessionId,
            wake: true,
          })
          try {
            await waitFor(
              async () => {
                const progress = await readSessionProgress(
                  sql,
                  identity.sessionId,
                )
                const state = await readPrivateState(sql, identity.sessionId)
                return (
                  progress.completedRunCount === 2 &&
                  progress.committedDecisionCount === 2 &&
                  progress.queuedLiveRunCount === 0 &&
                  progress.runningLiveRunCount === 0 &&
                  progress.failedLiveRunCount === 0 &&
                  progress.latestLiveRunLifecycle === 'completed' &&
                  progress.latestDecisionStatus === 'committed' &&
                  adapter.calls === 2 &&
                  state.poker.hand?.currentActorSeatNumber === 0
                )
              },
              'M4.10 连续 AI → AI → user 未经生产 Commit Gate 完整收敛。',
              240_000,
            )
          } catch (error) {
            const progress = await readSessionProgress(sql, identity.sessionId)
            throw new Error(
              `M4.10 连续 AI Player Run 诊断：${JSON.stringify({
                providerCalls: adapter.calls,
                progress,
              })}`,
              { cause: error },
            )
          }
          expect(adapter.calls).toBe(2)
          expect(
            await readCommittedLiveRunSequence(sql, identity.sessionId),
          ).toEqual([
            {
              actorSeat: 4,
              lifecycle: 'completed',
              decisionStatus: 'committed',
              sourceStateVersion: 1,
            },
            {
              actorSeat: 5,
              lifecycle: 'completed',
              decisionStatus: 'committed',
              sourceStateVersion: 2,
            },
          ])

          const committedDecision = await sql<
            readonly { readonly decisionId: string }[]
          >`
          SELECT id::text AS "decisionId"
          FROM app_private.player_decisions
          WHERE session_id = ${identity.sessionId}::uuid
            AND execution_mode = 'live'
            AND status = 'committed'
          ORDER BY created_at ASC
          LIMIT 1
        `
          const decisionId = committedDecision[0]?.decisionId
          if (decisionId === undefined) {
            throw new Error('M4.10 成功闭环缺少 committed Player Decision。')
          }
          const historical = await createPlayerHistoricalReexecutionService({
            database: asDatabaseClient(sql),
          }).create({
            owner,
            sourceDecisionId: decisionId,
            idempotencyKey: 'm410/historical-live-worker-isolation',
          })
          await new Promise((resolve) => setTimeout(resolve, 1_200))
          const afterHistorical = await readSessionProgress(
            sql,
            identity.sessionId,
          )
          expect(afterHistorical.historicalQueuedRunCount).toBe(1)
          expect(historical.runId).toMatch(/^[0-9a-f-]{36}$/)
        } finally {
          await playerRuntime.dispatcher.stop()
          await playerRuntime.worker.stop()
          await configuredRuntime.close()
        }

        const recoveryIdentity = await createSessionFixture(sql, 0)
        const recoveryConfiguredRuntime = await createConfiguredRuntime(
          runtimeUrl,
          createCandidateAdapter(),
        )
        const recoveryPlayerRuntime = requirePlayerRuntime(
          recoveryConfiguredRuntime.runtime,
        )
        try {
          await recoveryPlayerRuntime.startupRecovery.recoverAtStartup({
            signal: new AbortController().signal,
          })
          await recoveryPlayerRuntime.dispatcher.start()
          await waitFor(
            async () =>
              (await readSessionProgress(sql, recoveryIdentity.sessionId))
                .queuedLiveRunCount === 1,
            'M4.10 丢失 Dispatcher hint 后未由周期扫描创建 live Run。',
          )
          await recoveryPlayerRuntime.dispatcher.stop()
          await recoveryPlayerRuntime.worker.start()
          await waitFor(async () => {
            const progress = await readSessionProgress(
              sql,
              recoveryIdentity.sessionId,
            )
            return (
              progress.runningLiveRunCount >= 1 ||
              progress.completedRunCount >= 1
            )
          }, 'M4.10 丢失 Worker wake 后未由 poll 领取 live Run。')
        } finally {
          await recoveryPlayerRuntime.dispatcher.stop()
          await recoveryPlayerRuntime.worker.stop()
          await recoveryConfiguredRuntime.close()
        }

        const restartIdentity = await createSessionFixture(sql, 0)
        const restartConfiguredRuntime = await createConfiguredRuntime(
          runtimeUrl,
          createCandidateAdapter(),
        )
        const restartPlayerRuntime = requirePlayerRuntime(
          restartConfiguredRuntime.runtime,
        )
        try {
          const queuedBeforeRestart =
            await restartPlayerRuntime.reconcileInitialTurns()
          expect(queuedBeforeRestart).toHaveLength(1)
          const restartEffects =
            await restartPlayerRuntime.startupRecovery.recoverAtStartup({
              signal: new AbortController().signal,
            })
          expect(restartEffects.replacementRunIds).toHaveLength(1)
          const restartProgress = await readSessionProgress(
            sql,
            restartIdentity.sessionId,
          )
          expect(restartProgress.queuedLiveRunCount).toBe(1)
        } finally {
          await restartPlayerRuntime.dispatcher.stop()
          await restartPlayerRuntime.worker.stop()
          await restartConfiguredRuntime.close()
        }
      } finally {
        await restorePlayerTimeoutSettingsRow({
          sql,
          owner,
          original: originalTimeoutSettings,
        })
        const restoredTimeoutSettings = await readPlayerTimeoutSettingsRow(
          sql,
          owner.databaseOwnerId,
        )
        if (originalTimeoutSettings === undefined) {
          expect(restoredTimeoutSettings).toBeUndefined()
        } else {
          expect(restoredTimeoutSettings).toEqual({
            id: originalTimeoutSettings.id,
            settingPayload: originalTimeoutSettings.settingPayload,
            updatedAt: expect.any(String),
          })
        }
      }
    },
    () => clearLocalOwnerSessions(sql),
  )
}
