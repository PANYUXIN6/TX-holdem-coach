import type { TransactionSql } from 'postgres'
import { z } from 'zod'
import type { DatabaseClient } from '../db/client.js'
import type {
  PlayerObservationLoadResult,
  PlayerObservationPort,
} from '../agents/player/player-observation-port.js'
import {
  isRuntimeCommitAuthority,
  type RuntimeCommitAuthority,
} from '../agents/foundation/runtime-ports.js'
import { createPlayerDecisionIdentity } from '../sessions/authoritative-state/decision-identity.js'
import { currentPrivateEventReader } from '../sessions/authoritative-state/private-event-codec.js'
import {
  buildPlayerObservationDraft,
  type PlayerObservationEvent,
} from '../sessions/authoritative-state/player-observation-builder.js'
import { certifyPlayerVisibleState } from '../sessions/authoritative-state/player-information-boundary-guard.js'
import { PlayerObservationBoundaryError } from '../sessions/authoritative-state/player-visible-state.js'
import { currentSnapshotReader } from '../sessions/authoritative-state/snapshot-codec.js'
import { runDatabaseTransaction } from './database-transaction.js'
import {
  DatabaseOperationError,
  PersistenceDataCorruptionError,
  RepositoryInputValidationError,
} from './errors.js'
import { isResolvedOwnerScope } from './owner-scope.js'

const UuidSchema = z.string().uuid()
const SafeNonnegativeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)

const SessionObservationRowSchema = z.strictObject({
  lifecycleStatus: z.enum(['active', 'ended', 'readonlyDiagnostic']),
  stateVersion: SafeNonnegativeIntegerSchema,
  nextEventSeq: SafeNonnegativeIntegerSchema,
  currentHandId: UuidSchema.nullable(),
  agentRunState: z.enum(['idle', 'thinking', 'paused']),
  activePlayerRunId: UuidSchema.nullable(),
  activeDecisionRequestId: UuidSchema.nullable(),
})

const RunObservationRowSchema = z.strictObject({
  runtime: z.enum(['player', 'coach']),
  lifecycle: z.enum([
    'queued',
    'leased',
    'running',
    'completed',
    'failed',
    'cancelled',
    'stale',
  ]),
  handId: UuidSchema,
  participantId: UuidSchema.nullable(),
  sourceStateVersion: SafeNonnegativeIntegerSchema.nullable(),
  decisionRequestId: UuidSchema.nullable(),
  leaseOwner: z.string().nullable(),
  fencingToken: SafeNonnegativeIntegerSchema,
  leaseCurrent: z.boolean(),
  deadlineCurrent: z.boolean(),
})

const SnapshotObservationRowSchema = z.strictObject({
  payloadVersion: z.number().int(),
  payload: z.unknown(),
})

const ParticipantObservationRowSchema = z.strictObject({
  participantId: UuidSchema,
  seatNumber: z.number().int().min(0).max(8),
  participantType: z.enum(['user', 'agent']),
})

const EventObservationRowSchema = z.strictObject({
  handId: UuidSchema.nullable(),
  eventSeq: SafeNonnegativeIntegerSchema,
  stateVersionBefore: SafeNonnegativeIntegerSchema,
  stateVersionAfter: SafeNonnegativeIntegerSchema,
  payloadVersion: z.number().int(),
  payload: z.unknown(),
})

const AuthorityTimeObservationRowSchema = z.strictObject({
  leaseCurrent: z.boolean(),
  deadlineCurrent: z.boolean(),
})

const STALE_RESULT = Object.freeze({ kind: 'stale' as const })
const AUTHORITY_LOST_RESULT = Object.freeze({ kind: 'authorityLost' as const })
const RESOURCE_MISSING_RESULT = Object.freeze({
  kind: 'resourceMissing' as const,
})

async function queryRows(
  query: Promise<readonly unknown[]>,
): Promise<readonly unknown[]> {
  try {
    return await query
  } catch {
    throw new DatabaseOperationError()
  }
}

function parseSingleRow<Output>(
  rows: readonly unknown[],
  schema: z.ZodType<Output>,
): Output | null {
  if (rows.length === 0) return null
  if (rows.length !== 1) {
    throw new PersistenceDataCorruptionError('invalidPlayerObservation')
  }
  const parsed = schema.safeParse(rows[0])
  if (!parsed.success) {
    throw new PersistenceDataCorruptionError('invalidPlayerObservation')
  }
  return parsed.data
}

function decodeObservationEvents(
  rows: readonly unknown[],
): readonly PlayerObservationEvent[] {
  return rows.flatMap((row) => {
    const parsed = EventObservationRowSchema.safeParse(row)
    if (!parsed.success || parsed.data.handId === null) {
      throw new PersistenceDataCorruptionError('invalidPlayerObservation')
    }
    const decoded = currentPrivateEventReader.read(
      parsed.data.payloadVersion,
      parsed.data.payload,
    )
    if (decoded.kind !== 'decoded') {
      throw new PersistenceDataCorruptionError('invalidPlayerObservation')
    }
    // Agent lifecycle events share the hand stream but do not advance the
    // authoritative poker state. The observation chain is intentionally the
    // contiguous state-transition history that the replay certifies.
    if (
      decoded.value.type !== 'handStarted' &&
      decoded.value.type !== 'actionCommitted'
    ) {
      if (parsed.data.stateVersionBefore !== parsed.data.stateVersionAfter) {
        throw new PersistenceDataCorruptionError('invalidPlayerObservation')
      }
      return []
    }
    return Object.freeze({
      handId: parsed.data.handId,
      eventSeq: parsed.data.eventSeq,
      stateVersionBefore: parsed.data.stateVersionBefore,
      stateVersionAfter: parsed.data.stateVersionAfter,
      event: decoded.value,
    })
  })
}

export async function loadPlayerObservationInTransaction(
  transaction: TransactionSql,
  authority: RuntimeCommitAuthority<'player'>,
  owner: Parameters<PlayerObservationPort['load']>[0]['owner'],
  identity: Parameters<PlayerObservationPort['load']>[0]['identity'],
): Promise<PlayerObservationLoadResult> {
  const sessionRows = await queryRows(transaction`
    SELECT
      lifecycle_status AS "lifecycleStatus",
      state_version::float8 AS "stateVersion",
      next_event_seq::float8 AS "nextEventSeq",
      current_hand_id::text AS "currentHandId",
      agent_run_state AS "agentRunState",
      active_player_run_id::text AS "activePlayerRunId",
      active_decision_request_id::text AS "activeDecisionRequestId"
    FROM app_private.sessions
    WHERE id = ${identity.sessionId}::uuid
      AND owner_id = ${owner.databaseOwnerId}::uuid
    FOR SHARE
  `)
  const session = parseSingleRow(sessionRows, SessionObservationRowSchema)
  if (session === null) return RESOURCE_MISSING_RESULT
  if (
    session.lifecycleStatus !== 'active' ||
    session.currentHandId !== identity.handId ||
    session.stateVersion !== identity.stateVersion ||
    session.activeDecisionRequestId !== identity.decisionRequestId
  ) {
    return STALE_RESULT
  }
  if (
    session.agentRunState !== 'thinking' ||
    session.activePlayerRunId !== authority.runId
  ) {
    return AUTHORITY_LOST_RESULT
  }
  if (session.nextEventSeq <= 0) {
    throw new PersistenceDataCorruptionError('invalidPlayerObservation')
  }

  const runRows = await queryRows(transaction`
    SELECT
      runtime,
      lifecycle,
      hand_id::text AS "handId",
      participant_id::text AS "participantId",
      source_state_version::float8 AS "sourceStateVersion",
      decision_request_id::text AS "decisionRequestId",
      lease_owner AS "leaseOwner",
      fencing_token::float8 AS "fencingToken",
      (lease_expires_at > clock_timestamp()) AS "leaseCurrent",
      (deadline_at > clock_timestamp()) AS "deadlineCurrent"
    FROM app_private.agent_runs
    WHERE id = ${authority.runId}::uuid
      AND owner_id = ${owner.databaseOwnerId}::uuid
      AND session_id = ${identity.sessionId}::uuid
    FOR SHARE
  `)
  const run = parseSingleRow(runRows, RunObservationRowSchema)
  if (run === null) return AUTHORITY_LOST_RESULT
  if (
    run.runtime !== 'player' ||
    run.lifecycle !== 'running' ||
    run.leaseOwner !== authority.leaseOwner ||
    run.fencingToken !== authority.fencingToken ||
    !run.leaseCurrent ||
    !run.deadlineCurrent
  ) {
    return AUTHORITY_LOST_RESULT
  }
  if (
    run.handId !== identity.handId ||
    run.participantId !== identity.actorParticipantId ||
    run.sourceStateVersion !== identity.stateVersion ||
    run.decisionRequestId !== identity.decisionRequestId
  ) {
    return STALE_RESULT
  }

  const snapshotRows = await queryRows(transaction`
    SELECT
      private_table_state_payload_version AS "payloadVersion",
      private_table_state_payload AS "payload"
    FROM app_private.session_snapshots
    WHERE session_id = ${identity.sessionId}::uuid
      AND owner_id = ${owner.databaseOwnerId}::uuid
  `)
  const snapshotRow = parseSingleRow(snapshotRows, SnapshotObservationRowSchema)
  if (snapshotRow === null) {
    throw new PersistenceDataCorruptionError('invalidPlayerObservation')
  }
  const decodedSnapshot = currentSnapshotReader.read(
    snapshotRow.payloadVersion,
    snapshotRow.payload,
  )
  if (decodedSnapshot.kind !== 'decoded') {
    throw new PersistenceDataCorruptionError('invalidPlayerObservation')
  }
  const state = decodedSnapshot.value
  if (
    state.stateVersion !== session.stateVersion ||
    state.poker.pokerPhase !== 'inHand' ||
    state.poker.hand === null ||
    state.poker.hand.handId !== session.currentHandId
  ) {
    throw new PersistenceDataCorruptionError('invalidPlayerObservation')
  }
  const participantRows = await queryRows(transaction`
    SELECT
      id::text AS "participantId",
      seat_number AS "seatNumber",
      participant_type AS "participantType"
    FROM app_private.session_participants
    WHERE id = ${identity.actorParticipantId}::uuid
      AND session_id = ${identity.sessionId}::uuid
      AND owner_id = ${owner.databaseOwnerId}::uuid
  `)
  const participant = parseSingleRow(
    participantRows,
    ParticipantObservationRowSchema,
  )
  if (
    participant === null ||
    participant.participantId !== identity.actorParticipantId ||
    participant.participantType !== 'agent'
  ) {
    throw new PersistenceDataCorruptionError('invalidPlayerObservation')
  }
  if (participant.seatNumber !== identity.actorSeat) return STALE_RESULT
  if (state.poker.hand.currentActorSeatNumber !== participant.seatNumber) {
    throw new PersistenceDataCorruptionError('invalidPlayerObservation')
  }

  const latestSessionEventSeq = session.nextEventSeq - 1
  const eventRows = await queryRows(transaction`
    SELECT
      hand_id::text AS "handId",
      event_seq::float8 AS "eventSeq",
      state_version_before::float8 AS "stateVersionBefore",
      state_version_after::float8 AS "stateVersionAfter",
      private_event_payload_version AS "payloadVersion",
      private_event_payload AS "payload"
    FROM app_private.session_events
    WHERE session_id = ${identity.sessionId}::uuid
      AND owner_id = ${owner.databaseOwnerId}::uuid
      AND hand_id = ${identity.handId}::uuid
      AND event_seq <= ${latestSessionEventSeq}::bigint
    ORDER BY event_seq ASC
  `)
  const events = decodeObservationEvents(eventRows)
  const asOfEventSeq = events.at(-1)?.eventSeq
  if (asOfEventSeq === undefined) {
    throw new PersistenceDataCorruptionError('invalidPlayerObservation')
  }
  try {
    const draft = buildPlayerObservationDraft({
      state,
      events,
      identity,
      actor: {
        participantId: participant.participantId,
        seatNumber: participant.seatNumber,
        participantType: 'agent',
      },
      asOfEventSeq,
    })
    const observation = certifyPlayerVisibleState(draft)
    const authorityTimeRows = await queryRows(transaction`
      SELECT
        (lease_expires_at > clock_timestamp()) AS "leaseCurrent",
        (deadline_at > clock_timestamp()) AS "deadlineCurrent"
      FROM app_private.agent_runs
      WHERE id = ${authority.runId}::uuid
        AND owner_id = ${owner.databaseOwnerId}::uuid
        AND session_id = ${identity.sessionId}::uuid
    `)
    const authorityTime = parseSingleRow(
      authorityTimeRows,
      AuthorityTimeObservationRowSchema,
    )
    if (
      authorityTime === null ||
      !authorityTime.leaseCurrent ||
      !authorityTime.deadlineCurrent
    ) {
      return AUTHORITY_LOST_RESULT
    }
    return Object.freeze({ kind: 'ready' as const, observation })
  } catch (error) {
    if (error instanceof PlayerObservationBoundaryError) {
      throw new PersistenceDataCorruptionError('invalidPlayerObservation')
    }
    throw error
  }
}

export function createPostgresPlayerObservationPort(input: {
  readonly authority: RuntimeCommitAuthority<'player'>
  readonly database: DatabaseClient
}): PlayerObservationPort {
  if (
    !isRuntimeCommitAuthority(input.authority, 'player') ||
    typeof input.database !== 'object' ||
    input.database === null ||
    typeof input.database.sql !== 'function'
  ) {
    throw new RepositoryInputValidationError()
  }
  const authority = input.authority
  const sql = input.database.sql
  return Object.freeze({
    async load(loadInput: Parameters<PlayerObservationPort['load']>[0]) {
      if (!isResolvedOwnerScope(loadInput.owner)) {
        throw new RepositoryInputValidationError()
      }
      let identity
      try {
        identity = createPlayerDecisionIdentity(loadInput.identity)
      } catch {
        throw new RepositoryInputValidationError()
      }
      return runDatabaseTransaction(sql, (transaction) =>
        loadPlayerObservationInTransaction(
          transaction,
          authority,
          loadInput.owner,
          identity,
        ),
      )
    },
  })
}
