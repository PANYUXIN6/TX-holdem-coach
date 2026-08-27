import type { Sql } from 'postgres'
import { expect } from 'vitest'
import { createAgentRunCoordinator } from '../../src/agents/foundation/agent-run-coordinator.js'
import type { AgentRunWorkerControl } from '../../src/agents/foundation/agent-worker-ports.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import { clearOwnerSessionData } from '../../src/persistence/session-deletion-repository.js'
import { createDatabaseTestSqlForRole } from './database-test-runtime.js'
import {
  assertM46PlayerDecisionApplicationFlow,
  type M47CommitRejectionScenario,
  type M47CommitScenario,
} from './postgres-e2e-m46-assertions.js'

async function withM47ScenarioSql<Result>(
  runtimeUrl: string,
  role: string,
  operation: (sql: Sql) => Promise<Result>,
): Promise<Result> {
  const sql = createDatabaseTestSqlForRole(runtimeUrl, role)
  try {
    return await operation(sql)
  } finally {
    await sql.end({ timeout: 0 })
  }
}

async function withM47WorkerControl<Result>(
  runtimeUrl: string,
  role: string,
  operation: (workerControl: AgentRunWorkerControl) => Promise<Result>,
): Promise<Result> {
  // 连接角色受测试基础设施的 24 字符限制；所有 M4.7 场景名称均以
  // `m47-` 开头，替换此前缀可保持可读性且为 Worker 角色留出空间。
  const workerRole = `m47w-${role.slice('m47-'.length)}`
  const workerSql = createDatabaseTestSqlForRole(runtimeUrl, workerRole)
  try {
    const owner = await resolveOwnerScope(workerSql, {
      ownerId: 'local-user',
    })
    const workerControl = createAgentRunCoordinator({
      sql: workerSql,
      owner,
      eventPort: { publish: async () => undefined },
    }).workerControl
    return await operation(workerControl)
  } finally {
    await workerSql.end({ timeout: 0 })
  }
}

async function assertM47CommitScenario(
  runtimeUrl: string,
  role: string,
  input: M47CommitScenario = {},
): Promise<void> {
  await withM47ScenarioSql(runtimeUrl, role, (sql) =>
    withM47WorkerControl(runtimeUrl, role, (workerControl) =>
      assertM46PlayerDecisionApplicationFlow(sql, {
        commitSelectedDecision: true,
        ...input,
        workerControl,
      }),
    ),
  )
}

/**
 * M4.7 只覆盖真实 Player selected result 之后的提交面；M4.6 自身仍只
 * 验证其 ResultPort 之前不推进牌局。成功/故障注入场景使用独立 Session；
 * 拒绝矩阵在同一个 selected Decision 上逐项事务回滚，避免重复构建整条
 * Player 流程，同时保持每个分支独立的零写断言。
 */
export async function assertM47PlayerCommitApplicationFlow(
  _sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  // 每个场景都有独立的主连接和 Worker 控制面连接。前者维持 E2E 单连接
  // 约束，后者则可在命令事务运行时真实领取、续租并观察 settlement。
  // continue-hand 成功、同一结果 replay、Decision/Run 成功终态；两类
  // COMMIT 后发布同时失败也不能回滚数据库结果或重提。
  await assertM47CommitScenario(runtimeUrl, 'm47-continue', {
    failSessionPublish: true,
    failRunPublish: true,
  })
  // 同一 Gate 链路还必须原子完成 Hand 审计，而不是只覆盖 continue-hand。
  await assertM47CommitScenario(runtimeUrl, 'm47-complete-hand', {
    completeHand: true,
  })

  // 关系写入、Session mutation、completed ledger、Decision 和 Run 同属一个
  // 命令事务；在 ledger 已写完后失败也必须整体回滚。
  await assertM47CommitScenario(runtimeUrl, 'm47-ledger-rollback', {
    failAfterLedger: true,
    expectedFailureCode: 'player_commit_persistence_rejected',
  })
  // complete-hand 的真实 relation writer 已先把 Hand 写成 completed；随后在
  // ledger 后失败，必须把 Hand 与其他提交面一起恢复到提交前状态。
  await assertM47CommitScenario(runtimeUrl, 'm47-complete-rollback', {
    completeHand: true,
    failAfterLedger: true,
    expectedFailureCode: 'player_commit_persistence_rejected',
    assertAfterLedger: async ({ transaction, handId }) => {
      const handRows = await transaction<
        readonly {
          readonly status: string
          readonly completedAt: string | null
        }[]
      >`
        SELECT status,
               completed_at::text AS "completedAt"
        FROM app_private.hands
        WHERE id = ${handId}::uuid
      `
      expect(handRows).toEqual([
        { status: 'completed', completedAt: expect.any(String) },
      ])
    },
  })

  const rejectionScenarios: readonly M47CommitRejectionScenario[] = [
    {
      name: 'state version drift',
      expectedFailureCode: 'player_commit_decision_stale',
      beforeCommit: async ({ sql: transactionSql, sessionId }) => {
        await transactionSql`
          UPDATE app_private.sessions
          SET state_version = state_version + 1
          WHERE id = ${sessionId}::uuid
        `
      },
    },
    {
      name: 'terminal run',
      expectedFailureCode: 'player_commit_authority_lost',
      beforeCommit: async ({ sql: transactionSql, sessionId, runId }) => {
        await transactionSql.begin(async (transaction) => {
          await transaction`
            UPDATE app_private.agent_runs
            SET lifecycle = 'completed',
                lease_owner = NULL,
                lease_expires_at = NULL,
                completed_at = clock_timestamp(),
                updated_at = clock_timestamp()
            WHERE id = ${runId}::uuid
          `
          await transaction`
            UPDATE app_private.sessions
            SET agent_run_state = 'idle',
                active_player_run_id = NULL,
                active_decision_request_id = NULL,
                updated_at = clock_timestamp()
            WHERE id = ${sessionId}::uuid
          `
        })
      },
    },
    {
      name: 'expired deadline',
      expectedFailureCode: 'player_commit_authority_lost',
      beforeCommit: async ({ sql: transactionSql, runId }) => {
        await transactionSql`
          UPDATE app_private.agent_runs
          SET deadline_at = clock_timestamp() - interval '1 second',
              updated_at = clock_timestamp()
          WHERE id = ${runId}::uuid
        `
      },
    },
    {
      name: 'aborted hand',
      expectedFailureCode: 'player_commit_decision_stale',
      beforeCommit: async ({ sql: transactionSql, handId }) => {
        await transactionSql`
          UPDATE app_private.hands
          SET status = 'aborted',
              abort_reason = 'm47-e2e-aborted',
              aborted_at = clock_timestamp(),
              updated_at = clock_timestamp()
          WHERE id = ${handId}::uuid
        `
      },
    },
    {
      name: 'ended session',
      expectedFailureCode: 'player_commit_decision_stale',
      beforeCommit: async ({ sql: transactionSql, sessionId, runId }) => {
        // `idle` Session 不能遗留 running Player Run；两个状态原子收敛，
        // 以验证真正到达 Gate 的 ended Session 分类。
        await transactionSql.begin(async (transaction) => {
          await transaction`
            UPDATE app_private.agent_runs
            SET lifecycle = 'completed',
                lease_owner = NULL,
                lease_expires_at = NULL,
                completed_at = clock_timestamp(),
                updated_at = clock_timestamp()
            WHERE id = ${runId}::uuid
          `
          await transaction`
            UPDATE app_private.sessions
            SET lifecycle_status = 'ended',
                ended_at = clock_timestamp(),
                agent_run_state = 'idle',
                active_player_run_id = NULL,
                active_decision_request_id = NULL,
                updated_at = clock_timestamp()
            WHERE id = ${sessionId}::uuid
          `
        })
      },
    },
    {
      name: 'expired lease',
      expectedFailureCode: 'player_commit_authority_lost',
      beforeCommit: async ({ sql: transactionSql, runId }) => {
        await transactionSql`
          UPDATE app_private.agent_runs
          SET updated_at = clock_timestamp() - interval '2 seconds',
              lease_expires_at = clock_timestamp() - interval '1 second'
          WHERE id = ${runId}::uuid
        `
      },
    },
    {
      name: 'different lease owner',
      expectedFailureCode: 'player_commit_authority_lost',
      beforeCommit: async ({ sql: transactionSql, runId }) => {
        await transactionSql`
          UPDATE app_private.agent_runs
          SET lease_owner = 'm47-e2e:other-worker',
              updated_at = clock_timestamp()
          WHERE id = ${runId}::uuid
        `
      },
    },
    {
      name: 'participant seat drift',
      expectedFailureCode: 'player_commit_decision_stale',
      beforeCommit: async ({ sql: transactionSql, result }) => {
        await transactionSql`
          UPDATE app_private.session_participants
          SET seat_number = 8
          WHERE id = ${result.binding.actorParticipantId}::uuid
        `
      },
    },
    {
      name: 'fencing drift',
      expectedFailureCode: 'player_commit_authority_lost',
      beforeCommit: async ({ sql: transactionSql, runId }) => {
        await transactionSql`
          UPDATE app_private.agent_runs
          SET fencing_token = fencing_token + 1,
              updated_at = clock_timestamp()
          WHERE id = ${runId}::uuid
        `
      },
    },
    {
      name: 'tampered selected choice',
      expectedFailureCode: 'player_commit_selected_decision_invalid',
      beforeCommit: async ({ sql: transactionSql, decisionRecordId }) => {
        await transactionSql`
          UPDATE app_private.player_decisions
          SET model_choice_payload = ${transactionSql.json({
            candidateActionId: 'tampered-candidate',
          })}
          WHERE id = ${decisionRecordId}::uuid
        `
      },
    },
    {
      name: 'deleted session',
      expectedFailureCode: 'player_commit_resource_missing',
      beforeCommit: async ({ sql: transactionSql, sessionId }) => {
        await transactionSql`
          DELETE FROM app_private.sessions
          WHERE id = ${sessionId}::uuid
        `
      },
    },
    {
      name: 'cleared owner',
      expectedFailureCode: 'player_commit_resource_missing',
      beforeCommit: async ({ sql: transactionSql }) => {
        const owner = await resolveOwnerScope(transactionSql, {
          ownerId: 'local-user',
        })
        await transactionSql.begin(async (transaction) => {
          await clearOwnerSessionData(transaction, owner, {
            deletedAt: new Date().toISOString(),
          })
        })
      },
    },
  ]
  await assertM47CommitScenario(runtimeUrl, 'm47-rejections', {
    rejectionScenarios,
  })
}
