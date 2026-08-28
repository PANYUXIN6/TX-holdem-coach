import type { Sql } from 'postgres'
import { expect } from 'vitest'

/**
 * M4.8 的运行时协调流程由 PostgreSQL E2E 覆盖；这里冻结它赖以成立的
 * migration surface，避免 replacement lineage 或 Decision 终态在已迁移库中
 * 被悄悄移除或放宽。
 */
export async function assertM48PlayerCoordinationSchema(
  sql: Sql,
): Promise<void> {
  const decisionColumns = await sql<
    readonly { readonly columnName: string; readonly nullable: string }[]
  >`
    SELECT column_name AS "columnName", is_nullable AS "nullable"
    FROM information_schema.columns
    WHERE table_schema = 'app_private'
      AND table_name = 'player_decisions'
      AND column_name IN ('terminal_outcome', 'terminal_reason', 'terminated_at')
    ORDER BY column_name
  `
  expect(decisionColumns).toEqual([
    { columnName: 'terminal_outcome', nullable: 'YES' },
    { columnName: 'terminal_reason', nullable: 'YES' },
    { columnName: 'terminated_at', nullable: 'YES' },
  ])

  const constraints = await sql<readonly { readonly constraintName: string }[]>`
    SELECT conname AS "constraintName"
    FROM pg_constraint
    WHERE conrelid IN (
      'app_private.agent_runs'::regclass,
      'app_private.player_decisions'::regclass
    )
      AND conname IN (
        'agent_runs_replacement_not_self_check',
        'player_decisions_terminal_outcome_check',
        'player_decisions_timestamp_order_check'
      )
    ORDER BY conname
  `
  expect(constraints).toEqual([
    { constraintName: 'agent_runs_replacement_not_self_check' },
    { constraintName: 'player_decisions_terminal_outcome_check' },
    { constraintName: 'player_decisions_timestamp_order_check' },
  ])

  const indexes = await sql<readonly { readonly indexName: string }[]>`
    SELECT indexname AS "indexName"
    FROM pg_indexes
    WHERE schemaname = 'app_private'
      AND tablename = 'agent_runs'
      AND indexname IN (
        'agent_runs_parent_run_unique',
        'agent_runs_replacement_run_unique'
      )
    ORDER BY indexname
  `
  expect(indexes).toEqual([
    { indexName: 'agent_runs_parent_run_unique' },
    { indexName: 'agent_runs_replacement_run_unique' },
  ])

  const terminalConstraint = await sql<
    readonly {
      readonly validatesTerminalOutcome: boolean
      readonly allowsFailed: boolean
      readonly allowsStale: boolean
      readonly rejectsCommitted: boolean
    }[]
  >`
    SELECT
      pg_get_constraintdef(oid) LIKE '%terminal_outcome%'
        AS "validatesTerminalOutcome",
      pg_get_constraintdef(oid) LIKE '%failed%'
        AS "allowsFailed",
      pg_get_constraintdef(oid) LIKE '%stale%'
        AS "allowsStale",
      pg_get_constraintdef(oid) LIKE '%committed%'
        AS "rejectsCommitted"
    FROM pg_constraint
    WHERE conrelid = 'app_private.player_decisions'::regclass
      AND conname = 'player_decisions_terminal_outcome_check'
  `
  expect(terminalConstraint).toEqual([
    {
      validatesTerminalOutcome: true,
      allowsFailed: true,
      allowsStale: true,
      rejectsCommitted: true,
    },
  ])
}
