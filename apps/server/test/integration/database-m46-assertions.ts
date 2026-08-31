import { randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import { expect } from 'vitest'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import {
  hashPlayerSessionMemoryV1,
  PLAYER_EMPTY_SESSION_MEMORY_V1,
} from '../../src/agents/player/player-session-memory.js'
import { runDatabaseTestWithCleanup } from './database-test-runtime.js'

const SESSION_ID = '20000000-0000-4000-8000-000000000046'
const HAND_ID = '30000000-0000-4000-8000-000000000046'
const PARTICIPANT_ID = '40000000-0000-4000-8000-000000000046'
const DECISION_REQUEST_ID = '50000000-0000-4000-8000-000000000046'
const OPTIONAL_PAYLOAD_PAIR_CONSTRAINT =
  'player_decisions_optional_payload_pairs_check'
const FROZEN_MODEL_INPUT_SHA256 = 'a'.repeat(64)
const ROSTER_IDS = [
  '40000000-0000-4000-8000-000000000040',
  PARTICIPANT_ID,
  '40000000-0000-4000-8000-000000000047',
  '40000000-0000-4000-8000-000000000048',
  '40000000-0000-4000-8000-000000000049',
  '40000000-0000-4000-8000-000000000050',
] as const

async function clearFixtures(sql: Sql): Promise<void> {
  await sql`DELETE FROM app_private.sessions WHERE id = ${SESSION_ID}::uuid`
}

export async function assertM46PlayerDecisionPersistence(
  sql: Sql,
): Promise<void> {
  await runDatabaseTestWithCleanup(
    async () => {
      await clearFixtures(sql)
      const owner = await resolveOwnerScope(sql, { ownerId: 'local-user' })
      const runId = randomUUID()
      const decisionId = randomUUID()
      await sql.begin(async (transaction) => {
        await transaction`
          INSERT INTO app_private.sessions (id, owner_id)
          VALUES (${SESSION_ID}::uuid, ${owner.databaseOwnerId}::uuid)
        `
        for (const [seatNumber, participantId] of ROSTER_IDS.entries()) {
          await transaction`
            INSERT INTO app_private.session_participants (
              id, session_id, owner_id, participant_type, seat_number
            ) VALUES (
              ${participantId}::uuid, ${SESSION_ID}::uuid,
              ${owner.databaseOwnerId}::uuid,
              ${seatNumber === 0 ? 'user' : 'agent'}, ${seatNumber}
            )
          `
          if (seatNumber > 0) {
            await transaction`
              INSERT INTO app_private.session_agents (
                participant_id, session_id, owner_id, display_name,
                avatar_color, persona_id, persona_version,
                config_snapshot_key, config_payload_version, config_payload,
                memory_payload_version, memory_payload
              ) VALUES (
                ${participantId}::uuid, ${SESSION_ID}::uuid,
                ${owner.databaseOwnerId}::uuid,
                ${`M46 Agent ${String(seatNumber)}`}, '#000000',
                ${`m46-persona-${String(seatNumber)}`}, 1,
                ${'0'.repeat(64)}, 1, ${transaction.json({})},
                1, ${transaction.json(PLAYER_EMPTY_SESSION_MEMORY_V1)}
              )
            `
            await transaction`
              INSERT INTO app_private.agent_memory_revisions (
                participant_id, session_id, owner_id, revision,
                memory_payload_version, memory_payload, memory_sha256
              ) VALUES (
                ${participantId}::uuid, ${SESSION_ID}::uuid,
                ${owner.databaseOwnerId}::uuid, 0, 1,
                ${transaction.json(PLAYER_EMPTY_SESSION_MEMORY_V1)},
                ${hashPlayerSessionMemoryV1(PLAYER_EMPTY_SESSION_MEMORY_V1)}
              )
            `
          }
        }
        await transaction`
          INSERT INTO app_private.hands (
            id, session_id, owner_id, hand_number, status,
            hand_start_checkpoint_payload_version,
            hand_start_checkpoint_payload, button_seat, participant_seats,
            started_at
          ) VALUES (
            ${HAND_ID}::uuid, ${SESSION_ID}::uuid,
            ${owner.databaseOwnerId}::uuid, 1, 'inProgress',
            1, ${transaction.json({ checkpoint: 1 })}, 0,
            ARRAY[0,1,2,3,4,5]::integer[], clock_timestamp()
          )
        `
        await transaction`
          INSERT INTO app_private.agent_runs (
            id, owner_id, session_id, runtime, trigger_type, lifecycle,
            idempotency_key, hand_id, participant_id, source_state_version,
            decision_request_id, lease_owner, lease_expires_at, fencing_token,
            deadline_at, runtime_definition_version,
            run_config_payload_version, run_config_payload,
            budget_payload_version, budget_payload, created_at, started_at
          ) VALUES (
            ${runId}::uuid, ${owner.databaseOwnerId}::uuid,
            ${SESSION_ID}::uuid, 'player', 'action_required', 'running',
            ${`m46/database/${runId}`}, ${HAND_ID}::uuid,
            ${PARTICIPANT_ID}::uuid, 7, ${DECISION_REQUEST_ID}::uuid,
            'm46-database:player:0', clock_timestamp() + interval '5 minutes', 1,
            clock_timestamp() + interval '5 minutes', 1,
            1, ${transaction.json({})}, 1, ${transaction.json({})},
            clock_timestamp(), clock_timestamp()
          )
        `
        await transaction`
          UPDATE app_private.sessions
          SET agent_run_state = 'thinking',
              active_player_run_id = ${runId}::uuid,
              active_decision_request_id = ${DECISION_REQUEST_ID}::uuid,
              current_hand_id = ${HAND_ID}::uuid,
              state_version = 7
          WHERE id = ${SESSION_ID}::uuid
        `
        await transaction`
          INSERT INTO app_private.player_decisions (
            id, agent_run_id, owner_id, session_id, hand_id, participant_id,
            source_state_version, decision_request_id, runtime, record_version,
            status, decision_audit_snapshot_payload_version,
            decision_audit_snapshot_payload, candidate_set_payload_version,
            candidate_set_payload, memory_revision, memory_payload_version,
            memory_sha256
          ) VALUES (
            ${decisionId}::uuid, ${runId}::uuid,
            ${owner.databaseOwnerId}::uuid, ${SESSION_ID}::uuid,
            ${HAND_ID}::uuid, ${PARTICIPANT_ID}::uuid, 7,
            ${DECISION_REQUEST_ID}::uuid, 'player', 1, 'auditPrepared',
            1, ${transaction.json({ audit: 1 })},
            1, ${transaction.json({ candidates: 1 })}, 0, 1,
            ${hashPlayerSessionMemoryV1(PLAYER_EMPTY_SESSION_MEMORY_V1)}
          )
        `
      })

      await expect(sql`
        INSERT INTO app_private.player_decisions (
          id, agent_run_id, owner_id, session_id, hand_id, participant_id,
          source_state_version, decision_request_id, runtime, record_version,
          status, decision_audit_snapshot_payload_version,
          decision_audit_snapshot_payload, candidate_set_payload_version,
          candidate_set_payload, memory_revision, memory_payload_version,
          memory_sha256
        ) SELECT
          ${randomUUID()}::uuid, agent_run_id, owner_id, session_id, hand_id,
          participant_id, source_state_version, decision_request_id, runtime,
          record_version, status, decision_audit_snapshot_payload_version,
          decision_audit_snapshot_payload, candidate_set_payload_version,
          candidate_set_payload, memory_revision, memory_payload_version,
          memory_sha256
        FROM app_private.player_decisions WHERE id = ${decisionId}::uuid
      `).rejects.toMatchObject({ code: '23505' })

      await expect(sql`
        UPDATE app_private.player_decisions
        SET status = 'modelPrepared', model_prepared_at = clock_timestamp()
        WHERE id = ${decisionId}::uuid
      `).rejects.toMatchObject({ code: '23514' })

      await expect(sql`
        UPDATE app_private.player_decisions
        SET status = 'modelPrepared',
            model_projection_payload_version = 1,
            model_projection_payload = ${sql.json({ projection: 1 })},
            model_prepared_at = clock_timestamp()
        WHERE id = ${decisionId}::uuid
      `).rejects.toMatchObject({ code: '23514' })

      await expect(sql`
        UPDATE app_private.player_decisions
        SET model_projection_payload_version = 1
        WHERE id = ${decisionId}::uuid
      `).rejects.toMatchObject({
        code: '23514',
        constraint_name: OPTIONAL_PAYLOAD_PAIR_CONSTRAINT,
      })
      await expect(sql`
        UPDATE app_private.player_decisions
        SET model_projection_payload = ${sql.json({ projection: 1 })}
        WHERE id = ${decisionId}::uuid
      `).rejects.toMatchObject({
        code: '23514',
        constraint_name: OPTIONAL_PAYLOAD_PAIR_CONSTRAINT,
      })

      await sql`
        UPDATE app_private.player_decisions
        SET status = 'modelPrepared',
            model_projection_payload_version = 1,
            model_projection_payload = ${sql.json({ projection: 1 })},
            frozen_model_input_payload_version = 1,
            frozen_model_input_payload = ${sql.json({ frozen: 1 })},
            frozen_model_input_sha256 = ${FROZEN_MODEL_INPUT_SHA256},
            model_prepared_at = clock_timestamp()
        WHERE id = ${decisionId}::uuid
      `
      const attemptId = randomUUID()
      await sql`
        INSERT INTO app_private.agent_attempts (
          id, agent_run_id, owner_id, session_id, fencing_token,
          attempt_number, attempt_type, stage, provider, model, lifecycle,
          accepted, stale, interrupted, input_tokens, output_tokens,
          cost_microunits, duration_ms, error_category,
          attempt_payload_version, attempt_payload,
          started_at, completed_at
        ) VALUES (
          ${attemptId}::uuid, ${runId}::uuid, ${owner.databaseOwnerId}::uuid,
          ${SESSION_ID}::uuid, 1, 1, 'initial',
          'player.bounded-choice', 'deepseek', 'deepseek-v4-flash',
          'completed', true, false, false, 100, 10, 120, 10,
          NULL, 1, ${sql.json({ validationStatus: 'valid' })},
          clock_timestamp(), clock_timestamp()
        )
      `
      await sql`
        UPDATE app_private.player_decisions
        SET status = 'selected',
            model_choice_payload_version = 1,
            model_choice_payload = ${sql.json({ candidateActionId: 'check' })},
            validator_result_payload_version = 1,
            validator_result_payload = ${sql.json({ valid: true })},
            accepted_attempt_id = ${attemptId}::uuid,
            selected_at = clock_timestamp()
        WHERE id = ${decisionId}::uuid
      `
      const selected = await sql<
        readonly { status: string; attemptId: string }[]
      >`
        SELECT status, accepted_attempt_id::text AS "attemptId"
        FROM app_private.player_decisions WHERE id = ${decisionId}::uuid
      `
      expect(selected).toEqual([{ status: 'selected', attemptId }])

      await expect(sql`
        UPDATE app_private.player_decisions
        SET model_choice_payload = NULL
        WHERE id = ${decisionId}::uuid
      `).rejects.toMatchObject({
        code: '23514',
        constraint_name: OPTIONAL_PAYLOAD_PAIR_CONSTRAINT,
      })
      await expect(sql`
        UPDATE app_private.player_decisions
        SET model_choice_payload_version = NULL
        WHERE id = ${decisionId}::uuid
      `).rejects.toMatchObject({
        code: '23514',
        constraint_name: OPTIONAL_PAYLOAD_PAIR_CONSTRAINT,
      })
      await expect(sql`
        UPDATE app_private.player_decisions
        SET validator_result_payload = NULL
        WHERE id = ${decisionId}::uuid
      `).rejects.toMatchObject({
        code: '23514',
        constraint_name: OPTIONAL_PAYLOAD_PAIR_CONSTRAINT,
      })
      await expect(sql`
        UPDATE app_private.player_decisions
        SET validator_result_payload_version = NULL
        WHERE id = ${decisionId}::uuid
      `).rejects.toMatchObject({
        code: '23514',
        constraint_name: OPTIONAL_PAYLOAD_PAIR_CONSTRAINT,
      })

      await expect(sql`
        UPDATE app_private.player_decisions
        SET participant_id = ${randomUUID()}::uuid
        WHERE id = ${decisionId}::uuid
      `).rejects.toMatchObject({ code: '23503' })

      await sql`DELETE FROM app_private.sessions WHERE id = ${SESSION_ID}::uuid`
      const cascaded = await sql<readonly { count: number }[]>`
        SELECT count(*)::int AS count FROM app_private.player_decisions
        WHERE id = ${decisionId}::uuid
      `
      expect(cascaded).toEqual([{ count: 0 }])
    },
    () => clearFixtures(sql),
  )
}
