import type { Sql } from 'postgres'
import { expect } from 'vitest'

export async function assertM49PlayerAuditReplayMemorySchema(
  sql: Sql,
): Promise<void> {
  const columns = await sql<
    readonly {
      readonly tableName: string
      readonly columnName: string
      readonly isNullable: 'YES' | 'NO'
      readonly columnDefault: string | null
    }[]
  >`
    SELECT table_name AS "tableName", column_name AS "columnName",
           is_nullable AS "isNullable", column_default AS "columnDefault"
    FROM information_schema.columns
    WHERE table_schema = 'app_private'
      AND table_name IN ('agent_memory_revisions', 'agent_runs', 'player_decisions')
      AND column_name IN (
        'source_agent_run_id', 'source_hand_id', 'source_state_version',
        'decision_request_id', 'as_of_event_seq', 'memory_sha256',
        'execution_mode', 'reexecution_source_run_id', 'memory_revision',
        'memory_payload_version', 'frozen_model_input_payload_version',
        'frozen_model_input_payload', 'frozen_model_input_sha256',
        'reexecution_source_decision_id', 'source_snapshot_sha256',
        'source_candidate_set_sha256', 'source_projection_sha256',
        'source_model_input_sha256'
      )
  `
  const byKey = new Map(
    columns.map((column) => [
      `${column.tableName}.${column.columnName}`,
      column,
    ]),
  )
  expect(byKey.get('agent_memory_revisions.memory_sha256')?.isNullable).toBe(
    'NO',
  )
  expect(
    byKey.get('agent_memory_revisions.source_agent_run_id')?.isNullable,
  ).toBe('YES')
  expect(byKey.get('agent_runs.execution_mode')?.columnDefault).toContain(
    'live',
  )
  expect(byKey.get('agent_runs.reexecution_source_run_id')?.isNullable).toBe(
    'YES',
  )
  expect(byKey.get('player_decisions.memory_revision')?.isNullable).toBe('NO')
  expect(
    byKey.get('player_decisions.memory_payload_version')?.columnDefault,
  ).toContain('1')
  expect(
    byKey.get('player_decisions.frozen_model_input_payload_version')
      ?.isNullable,
  ).toBe('YES')
  expect(
    byKey.get('player_decisions.frozen_model_input_payload')?.isNullable,
  ).toBe('YES')
  expect(
    byKey.get('player_decisions.frozen_model_input_sha256')?.isNullable,
  ).toBe('YES')
  expect(byKey.get('player_decisions.execution_mode')?.columnDefault).toContain(
    'live',
  )
  expect(
    byKey.get('player_decisions.reexecution_source_decision_id')?.isNullable,
  ).toBe('YES')

  const constraints = await sql<
    readonly { readonly name: string; readonly definition: string }[]
  >`
    SELECT conname AS name, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE connamespace = 'app_private'::regnamespace
      AND conname IN (
        'agent_memory_revisions_source_lifecycle_check',
        'agent_runs_execution_mode_check',
        'player_decisions_memory_revision_scope_fk',
        'player_decisions_stage_matrix_check',
        'player_decisions_execution_mode_check',
        'player_decisions_reexecution_source_scope_fk'
      )
  `
  expect(constraints).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'agent_memory_revisions_source_lifecycle_check',
        definition: expect.stringContaining('source_agent_run_id'),
      }),
      expect.objectContaining({
        name: 'agent_runs_execution_mode_check',
        definition: expect.stringContaining('historicalReexecution'),
      }),
      expect.objectContaining({
        name: 'player_decisions_memory_revision_scope_fk',
        definition: expect.stringContaining('FOREIGN KEY'),
      }),
      expect.objectContaining({
        name: 'player_decisions_stage_matrix_check',
        definition: expect.stringContaining(
          'frozen_model_input_payload_version',
        ),
      }),
      expect.objectContaining({
        name: 'player_decisions_execution_mode_check',
        definition: expect.stringContaining('reexecution_source_decision_id'),
      }),
      expect.objectContaining({
        name: 'player_decisions_reexecution_source_scope_fk',
        definition: expect.stringContaining('FOREIGN KEY'),
      }),
    ]),
  )

  const coordinationTrigger = await sql<
    readonly { readonly definition: string }[]
  >`
    SELECT pg_get_functiondef('app_private.enforce_player_run_coordination()'::regprocedure)
      AS definition
  `
  expect(coordinationTrigger).toEqual([
    expect.objectContaining({
      definition: expect.stringContaining("run.execution_mode = 'live'"),
    }),
  ])
}
