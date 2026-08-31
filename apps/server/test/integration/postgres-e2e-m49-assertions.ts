import { randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import { expect } from 'vitest'
import { createPlayerAuditReplayService } from '../../src/agents/player/player-audit-replay-service.js'
import { createPlayerHistoricalReexecutionService } from '../../src/agents/player/player-historical-reexecution.js'
import type { DatabaseClient } from '../../src/db/client.js'
import { assertM46PlayerDecisionApplicationFlow } from './postgres-e2e-m46-assertions.js'

function asDatabaseClient(sql: Sql): DatabaseClient {
  return { sql, db: {} as DatabaseClient['db'], close: async () => undefined }
}

/**
 * M4.9 必须在真实 Player Runtime 产出 live Decision 后才验证审计能力。这里故意
 * 不复用 schema assertion：Memory capability、Replay 的只读读取，以及历史重演的
 * 幂等 non-committing 创建都穿过 PostgreSQL 与运行时边界。
 */
export async function assertM49PlayerAuditReplayApplicationFlow(
  sql: Sql,
): Promise<void> {
  await assertM46PlayerDecisionApplicationFlow(sql, {
    onSelected: async ({ owner, sessionId, runId, result }) => {
      const database = asDatabaseClient(sql)
      const replayService = createPlayerAuditReplayService({ database })
      const historicalService = createPlayerHistoricalReexecutionService({
        database,
      })
      const before = await sql<
        readonly {
          readonly stateVersion: number
          readonly eventCount: number
          readonly commandCount: number
        }[]
      >`
        SELECT session.state_version::float8 AS "stateVersion",
               (SELECT count(*)::int FROM app_private.session_events
                WHERE session_id = session.id) AS "eventCount",
               (SELECT count(*)::int FROM app_private.command_ledger
                WHERE session_id = session.id) AS "commandCount"
        FROM app_private.sessions AS session
        WHERE session.id = ${sessionId}::uuid
          AND session.owner_id = ${owner.databaseOwnerId}::uuid
      `
      expect(before).toHaveLength(1)

      const replay = await replayService.replayDecision({
        owner,
        decisionId: result.decisionRecordId,
      })
      expect(replay.decision).toMatchObject({
        decisionId: result.decisionRecordId,
        runId,
        executionMode: 'live',
        status: 'selected',
        sourceDecisionId: null,
      })
      expect(replay.memory).toMatchObject({
        sourceAgentRunId: runId,
        sourceHandId: expect.any(String),
        sourceStateVersion: expect.any(Number),
        decisionRequestId: expect.any(String),
        asOfEventSeq: expect.any(Number),
      })
      // M4.6 的 E2E control 不落 capability audit；这里验证的是 runtime 已持久化
      // 的 Memory revision，而非把内存夹具误当成 Replay 数据。
      expect(replay.capabilityInvocations).toEqual([])
      expect(replay.attempts).toHaveLength(1)

      const idempotencyKey = `m49/history/${randomUUID()}`
      const [first, second] = await Promise.all([
        historicalService.create({
          owner,
          sourceDecisionId: result.decisionRecordId,
          idempotencyKey,
        }),
        historicalService.create({
          owner,
          sourceDecisionId: result.decisionRecordId,
          idempotencyKey,
        }),
      ])
      expect([first.kind, second.kind].sort()).toEqual(['created', 'existing'])
      expect(first.runId).toBe(second.runId)
      expect(first.decisionId).toBe(second.decisionId)

      const historicalReplay = await replayService.replayRun({
        owner,
        runId: first.runId,
      })
      expect(historicalReplay.decision).toMatchObject({
        decisionId: first.decisionId,
        runId: first.runId,
        executionMode: 'historicalReexecution',
        status: 'modelPrepared',
        sourceDecisionId: result.decisionRecordId,
      })
      expect(historicalReplay.attempts).toEqual([])
      expect(historicalReplay.capabilityInvocations).toEqual([])

      const after = await sql<
        readonly {
          readonly stateVersion: number
          readonly eventCount: number
          readonly commandCount: number
          readonly historicalRunCount: number
          readonly historicalDecisionCount: number
        }[]
      >`
        SELECT session.state_version::float8 AS "stateVersion",
               (SELECT count(*)::int FROM app_private.session_events
                WHERE session_id = session.id) AS "eventCount",
               (SELECT count(*)::int FROM app_private.command_ledger
                WHERE session_id = session.id) AS "commandCount",
               (SELECT count(*)::int FROM app_private.agent_runs
                WHERE session_id = session.id
                  AND execution_mode = 'historicalReexecution') AS "historicalRunCount",
               (SELECT count(*)::int FROM app_private.player_decisions
                WHERE session_id = session.id
                  AND execution_mode = 'historicalReexecution') AS "historicalDecisionCount"
        FROM app_private.sessions AS session
        WHERE session.id = ${sessionId}::uuid
          AND session.owner_id = ${owner.databaseOwnerId}::uuid
      `
      expect(after).toEqual([
        {
          ...before[0],
          historicalRunCount: 1,
          historicalDecisionCount: 1,
        },
      ])
    },
  })
}
