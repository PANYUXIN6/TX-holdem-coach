import {
  SessionAiStatusResponseSchema,
  AgentAuditPublicCodeSchema,
  type SessionAiStatusResponse,
} from '@tx-holdem-coach/contracts'
import type { Sql } from 'postgres'
import { z } from 'zod'
import { currentSnapshotReader } from '../sessions/authoritative-state/snapshot-codec.js'
import { SessionReadonlyDiagnosticError } from '../sessions/public-projection/errors.js'
import { runDatabaseTransaction } from './database-transaction.js'
import {
  DatabaseOperationError,
  PersistenceDataCorruptionError,
  RepositoryInputValidationError,
  UnknownPayloadVersionError,
} from './errors.js'
import { isResolvedOwnerScope, type ResolvedOwnerScope } from './owner-scope.js'
import { readSessionAgentSnapshots } from './session-repository.js'

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const rowSchema = z.strictObject({
  sessionId: z.uuid(),
  lifecycleStatus: z.enum(['active', 'ended', 'readonlyDiagnostic']),
  stateVersion: integer,
  nextEventSeq: integer,
  currentHandId: z.uuid().nullable(),
  handStatus: z.enum(['inProgress', 'completed', 'aborted']).nullable(),
  agentRunState: z.enum(['idle', 'thinking', 'paused']),
  activePlayerRunId: z.uuid().nullable(),
  activeDecisionRequestId: z.uuid().nullable(),
  snapshotVersion: z.unknown(),
  snapshot: z.unknown(),
  participants: z.array(
    z.strictObject({
      id: z.uuid(),
      seat: integer,
      type: z.enum(['user', 'agent']),
    }),
  ),
})
const runSchema = z.strictObject({
  runId: z.uuid(),
  sessionId: z.uuid(),
  handId: z.uuid(),
  participantId: z.uuid(),
  sourceStateVersion: integer,
  decisionRequestId: z.uuid(),
  triggerType: z.string(),
  parentRunId: z.uuid().nullable(),
  replacementRunId: z.uuid().nullable(),
  runtime: z.literal('player'),
  executionMode: z.literal('live'),
  lifecycle: z.string(),
  reason: z.string().nullable(),
})
function corrupt(): never {
  throw new PersistenceDataCorruptionError('mirrorMismatch')
}
const triggers = {
  initial: 'initial',
  action_required: 'initial',
  manual_retry: 'manualRetry',
  stale_replacement: 'staleReplacement',
  process_restart: 'processRestart',
} as const

export interface SessionAiStatusReader {
  getById(sessionId: string): Promise<SessionAiStatusResponse | null>
}

export function createSessionAiStatusRepository(input: {
  sql: Sql
  owner: ResolvedOwnerScope
}): SessionAiStatusReader {
  if (!isResolvedOwnerScope(input.owner))
    throw new RepositoryInputValidationError()
  return {
    async getById(sessionId) {
      if (!z.uuid().safeParse(sessionId).success)
        throw new RepositoryInputValidationError()
      return runDatabaseTransaction(input.sql, async (tx) => {
        await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`
        try {
          const rows = await tx`
          SELECT s.id::text AS "sessionId", s.lifecycle_status AS "lifecycleStatus",
            s.state_version::float8 AS "stateVersion", s.next_event_seq::float8 AS "nextEventSeq",
            s.current_hand_id::text AS "currentHandId", h.status AS "handStatus", s.agent_run_state AS "agentRunState",
            s.active_player_run_id::text AS "activePlayerRunId", s.active_decision_request_id::text AS "activeDecisionRequestId",
            ss.private_table_state_payload_version AS "snapshotVersion", ss.private_table_state_payload AS snapshot,
            (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', p.id::text, 'seat', p.seat_number, 'type', p.participant_type) ORDER BY p.seat_number), '[]'::jsonb)
              FROM app_private.session_participants p WHERE p.session_id = s.id AND p.owner_id = s.owner_id) AS participants
          FROM app_private.sessions s LEFT JOIN app_private.session_snapshots ss ON ss.session_id = s.id AND ss.owner_id = s.owner_id
          LEFT JOIN app_private.hands h ON h.id = s.current_hand_id AND h.session_id = s.id AND h.owner_id = s.owner_id
          WHERE s.id = ${sessionId}::uuid AND s.owner_id = ${input.owner.databaseOwnerId}::uuid
        `
          if (!rows.length) return null
          const parsed = rowSchema.safeParse(rows[0])
          if (!parsed.success) return corrupt()
          const s = parsed.data
          if (s.lifecycleStatus === 'readonlyDiagnostic')
            throw new SessionReadonlyDiagnosticError()
          if (s.nextEventSeq === 0) return corrupt()
          const decoded = currentSnapshotReader.read(
            s.snapshotVersion,
            s.snapshot,
          )
          if (decoded.kind !== 'decoded') {
            if (decoded.kind === 'unknownVersion')
              throw new UnknownPayloadVersionError('privateTableState')
            return corrupt()
          }
          const state = decoded.value
          const roster = await readSessionAgentSnapshots(
            tx,
            input.owner,
            sessionId,
          )
          if (
            (s.currentHandId === null
              ? s.handStatus !== null
              : s.handStatus !== 'inProgress') ||
            (s.lifecycleStatus === 'ended' && s.currentHandId !== null) ||
            state.stateVersion !== s.stateVersion ||
            (state.poker.hand?.handId ?? null) !== s.currentHandId ||
            s.participants.length !== roster.length + 1 ||
            state.poker.seats.length !== s.participants.length ||
            s.participants.filter((p) => p.type === 'user' && p.seat === 0)
              .length !== 1 ||
            s.participants.some(
              (p) =>
                !state.poker.seats.some(
                  (seat) =>
                    seat.playerId === p.id &&
                    seat.seatNumber === p.seat &&
                    seat.isUser === (p.type === 'user'),
                ),
            ) ||
            roster.some(
              (p) =>
                !s.participants.some(
                  (seat) =>
                    seat.id === p.participantId &&
                    seat.seat === p.seatNumber &&
                    seat.type === 'agent',
                ),
            )
          )
            return corrupt()
          let coordination: SessionAiStatusResponse['coordination'] = {
            state: 'idle',
          }
          if (s.agentRunState === 'idle') {
            if (
              s.activePlayerRunId !== null ||
              s.activeDecisionRequestId !== null
            )
              return corrupt()
          } else {
            const actor = state.poker.seats.find(
              (seat) =>
                seat.seatNumber === state.poker.hand?.currentActorSeatNumber,
            )
            if (
              s.lifecycleStatus !== 'active' ||
              !s.currentHandId ||
              !actor ||
              actor.isUser ||
              (s.agentRunState === 'paused' &&
                (s.activePlayerRunId !== null ||
                  s.activeDecisionRequestId !== null)) ||
              (s.agentRunState === 'thinking' &&
                (s.activePlayerRunId === null ||
                  s.activeDecisionRequestId === null))
            )
              return corrupt()
            const runs = await tx`
            SELECT id::text AS "runId", session_id::text AS "sessionId", hand_id::text AS "handId",
              participant_id::text AS "participantId", source_state_version::float8 AS "sourceStateVersion",
              decision_request_id::text AS "decisionRequestId", trigger_type AS "triggerType", parent_run_id::text AS "parentRunId",
              replacement_run_id::text AS "replacementRunId", runtime, execution_mode AS "executionMode", lifecycle, termination_reason AS reason
            FROM app_private.agent_runs WHERE owner_id = ${input.owner.databaseOwnerId}::uuid AND
              ((${s.agentRunState === 'thinking'} AND id = ${s.activePlayerRunId}::uuid) OR
               (${s.agentRunState === 'paused'} AND session_id = ${s.sessionId}::uuid AND hand_id = ${s.currentHandId}::uuid
                AND participant_id = ${actor.playerId}::uuid AND source_state_version = ${s.stateVersion}
                AND runtime = 'player' AND execution_mode = 'live' AND lifecycle = 'failed' AND replacement_run_id IS NULL))
            LIMIT 2
          `
            if (runs.length !== 1) return corrupt()
            const parsedRun = runSchema.safeParse(runs[0])
            if (!parsedRun.success) return corrupt()
            const r = parsedRun.data
            const trigger = triggers[r.triggerType as keyof typeof triggers]
            if (
              !trigger ||
              r.sessionId !== s.sessionId ||
              r.handId !== s.currentHandId ||
              r.participantId !== actor.playerId ||
              r.sourceStateVersion !== s.stateVersion ||
              r.replacementRunId !== null ||
              (s.agentRunState === 'thinking' &&
                (!['queued', 'leased', 'running'].includes(r.lifecycle) ||
                  r.decisionRequestId !== s.activeDecisionRequestId))
            )
              return corrupt()
            const run = {
              runId: r.runId,
              decisionRequestId: r.decisionRequestId,
              participantId: r.participantId,
              actorSeatNumber: actor.seatNumber,
              sourceStateVersion: r.sourceStateVersion,
              trigger,
              parentRunId: r.parentRunId,
            }
            if (s.agentRunState === 'paused') {
              if (!r.reason) return corrupt()
              const code = AgentAuditPublicCodeSchema.safeParse(r.reason)
              coordination = {
                state: 'paused',
                run,
                reasonCode: code.success ? code.data : 'technical_error',
              }
            } else coordination = { state: 'thinking', run }
          }
          const result = SessionAiStatusResponseSchema.safeParse({
            sessionId: s.sessionId,
            stateVersion: s.stateVersion,
            eventSeq: s.nextEventSeq - 1,
            lifecycleStatus: s.lifecycleStatus,
            handId: s.currentHandId,
            coordination,
            personas: roster.map((p) => ({
              participantId: p.participantId,
              seatNumber: p.seatNumber,
              personaId: p.personaId,
              personaVersion: p.personaVersion,
              configSnapshotKey: p.configSnapshotKey,
              displayName: p.displayName,
              avatarColor: p.avatarColor,
              backgroundDescription: p.configPayload.backgroundDescription,
              teachingSummary: p.configPayload.teachingSummary,
              style: { ...p.configPayload.style },
            })),
          })
          if (!result.success) return corrupt()
          return result.data
        } catch (error) {
          if (
            error instanceof PersistenceDataCorruptionError ||
            error instanceof UnknownPayloadVersionError ||
            error instanceof SessionReadonlyDiagnosticError
          )
            throw error
          throw new DatabaseOperationError()
        }
      })
    },
  }
}
