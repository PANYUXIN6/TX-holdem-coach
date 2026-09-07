import {
  HandStatisticsQuerySchema,
  SessionStatisticsQuerySchema,
  type HandStatisticsQuery,
  type SessionStatisticsQuery,
} from '@tx-holdem-coach/contracts'
import type { Sql, TransactionSql } from 'postgres'
import { z } from 'zod'
import type { CompletedHandResult } from '../poker/hand-result.js'
import { currentCompletedHandResultReader } from '../sessions/hand-audit/completed-hand-result-codec.js'
import { completedHandResultMirrorsCheckpoint } from '../sessions/hand-audit/completed-hand-mirrors.js'
import { currentHandStartCheckpointReader } from '../sessions/hand-audit/hand-start-checkpoint-codec.js'
import { currentPrivateEventReader } from '../sessions/authoritative-state/private-event-codec.js'
import { getPrivateEventHandId } from '../sessions/authoritative-state/private-event.js'
import { currentSnapshotReader } from '../sessions/authoritative-state/snapshot-codec.js'
import type {
  CompletedHandHistoryFacts,
  CompletedHandHistoryRosterEntry,
  CommittedPrivateHandEventFact,
} from '../sessions/hand-history/completed-hand-history.js'
import { projectParticipantPresentation } from '../sessions/participant-presentation.js'
import type {
  HistoricalStatisticsPersonaSnapshot,
  StatisticsHandFact,
} from '../sessions/statistics/hand-statistics.js'
import type { StatisticsSessionFact } from '../sessions/statistics/session-statistics.js'
import type { StatisticsFactsReader } from '../sessions/statistics/statistics.js'
import { runDatabaseTransaction } from './database-transaction.js'
import {
  DatabaseOperationError,
  PersistenceDataCorruptionError,
  RepositoryInputValidationError,
  UnknownPayloadVersionError,
} from './errors.js'
import { isResolvedOwnerScope, type ResolvedOwnerScope } from './owner-scope.js'

const SafeNonnegativeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
const PositiveSafeIntegerSchema = SafeNonnegativeIntegerSchema.positive()
const DatabaseTimestampSchema = z.iso.datetime({ precision: 6 })
const HistoricalPersonaIdSchema = z.string().min(1).max(128)
const HistoricalConfigSnapshotKeySchema = z.string().regex(/^[a-f0-9]{64}$/)
const RosterRowSchema = z.strictObject({
  seatNumber: z.number().int().min(0).max(8),
  playerId: z.uuid(),
  participantType: z.enum(['user', 'agent']),
  displayName: z.string().nullable(),
  avatarColor: z.string().nullable(),
  personaId: z.string().nullable(),
  personaVersion: z.number().int().nullable(),
  configSnapshotKey: z.string().nullable(),
})
const EventRowSchema = z.strictObject({
  eventSeq: SafeNonnegativeIntegerSchema,
  privateEventPayloadVersion: z.unknown(),
  privateEventPayload: z.unknown(),
})
const HandRowSchema = z.strictObject({
  handId: z.uuid(),
  sessionId: z.uuid(),
  handNumber: PositiveSafeIntegerSchema,
  startedAt: DatabaseTimestampSchema,
  completedAt: DatabaseTimestampSchema,
  checkpointPayloadVersion: z.unknown(),
  checkpointPayload: z.unknown(),
  completedResultPayloadVersion: z.unknown(),
  completedResultPayload: z.unknown(),
  roster: z.array(z.unknown()),
  events: z.array(z.unknown()),
})
const SessionRowSchema = z.strictObject({
  sessionId: z.uuid(),
  lifecycleStatus: z.literal('ended'),
  currentHandId: z.null(),
  stateVersion: SafeNonnegativeIntegerSchema,
  endedAt: DatabaseTimestampSchema,
  snapshotPayloadVersion: z.unknown(),
  snapshotPayload: z.unknown(),
  roster: z.array(z.unknown()),
})

interface MappedRoster {
  readonly roster: readonly CompletedHandHistoryRosterEntry[]
  readonly aiParticipants: readonly HistoricalStatisticsPersonaSnapshot[]
}

function corruption(): never {
  throw new PersistenceDataCorruptionError('invalidStatisticsFacts')
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const nestedValue of Object.values(value)) deepFreeze(nestedValue)
    Object.freeze(value)
  }
  return value
}

function mapRoster(
  rawRoster: readonly unknown[],
  expectedSeats: readonly {
    readonly seatNumber: number
    readonly playerId: string
    readonly isUser: boolean
  }[],
): MappedRoster {
  const parsed = z.array(RosterRowSchema).safeParse(rawRoster)
  if (!parsed.success || parsed.data.length !== expectedSeats.length) {
    return corruption()
  }
  const sorted = [...parsed.data].sort(
    (left, right) => left.seatNumber - right.seatNumber,
  )
  const expected = [...expectedSeats].sort(
    (left, right) => left.seatNumber - right.seatNumber,
  )
  const roster: CompletedHandHistoryRosterEntry[] = []
  const aiParticipants: HistoricalStatisticsPersonaSnapshot[] = []
  for (const [index, entry] of sorted.entries()) {
    const seat = expected[index]
    if (
      seat === undefined ||
      entry.seatNumber !== seat.seatNumber ||
      entry.playerId !== seat.playerId ||
      (entry.participantType === 'user') !== seat.isUser ||
      (entry.participantType === 'user') !== (entry.seatNumber === 0)
    ) {
      return corruption()
    }
    if (entry.participantType === 'user') {
      if (
        entry.displayName !== null ||
        entry.avatarColor !== null ||
        entry.personaId !== null ||
        entry.personaVersion !== null ||
        entry.configSnapshotKey !== null
      ) {
        return corruption()
      }
      const presentation = projectParticipantPresentation({ isUser: true })
      roster.push({
        seatNumber: entry.seatNumber,
        playerId: entry.playerId,
        isUser: true,
        displayName: presentation.displayName,
        avatarColor: presentation.avatarColor,
      })
      continue
    }
    if (
      entry.displayName === null ||
      entry.avatarColor === null ||
      entry.personaId === null ||
      entry.personaVersion === null ||
      entry.configSnapshotKey === null ||
      !HistoricalPersonaIdSchema.safeParse(entry.personaId).success ||
      !Number.isSafeInteger(entry.personaVersion) ||
      entry.personaVersion <= 0 ||
      !HistoricalConfigSnapshotKeySchema.safeParse(entry.configSnapshotKey)
        .success
    ) {
      return corruption()
    }
    const presentation = projectParticipantPresentation({
      isUser: false,
      displayName: entry.displayName,
      avatarColor: entry.avatarColor,
    })
    roster.push({
      seatNumber: entry.seatNumber,
      playerId: entry.playerId,
      isUser: false,
      displayName: presentation.displayName,
      avatarColor: presentation.avatarColor,
    })
    aiParticipants.push({
      seatNumber: entry.seatNumber,
      personaId: entry.personaId,
      personaVersion: entry.personaVersion,
      displayName: entry.displayName,
      configSnapshotKey: entry.configSnapshotKey,
    })
  }
  if (
    roster.filter((entry) => entry.isUser).length !== 1 ||
    new Set(roster.map((entry) => entry.seatNumber)).size !== roster.length
  ) {
    return corruption()
  }
  return deepFreeze({ roster, aiParticipants })
}

function mapEvents(
  rawEvents: readonly unknown[],
  handId: string,
): readonly CommittedPrivateHandEventFact[] {
  const parsed = z.array(EventRowSchema).safeParse(rawEvents)
  if (!parsed.success) return corruption()
  const sorted = [...parsed.data].sort(
    (left, right) => left.eventSeq - right.eventSeq,
  )
  let previousEventSeq = -1
  const events = sorted.map((row) => {
    if (row.eventSeq <= previousEventSeq) return corruption()
    const decoded = currentPrivateEventReader.read(
      row.privateEventPayloadVersion,
      row.privateEventPayload,
    )
    if (decoded.kind === 'unknownVersion') {
      throw new UnknownPayloadVersionError('privateEvent')
    }
    if (decoded.kind === 'invalidPayload') return corruption()
    if (getPrivateEventHandId(decoded.value) !== handId) return corruption()
    previousEventSeq = row.eventSeq
    return Object.freeze({ eventSeq: row.eventSeq, event: decoded.value })
  })
  return Object.freeze(events)
}

function mapHandFact(
  rawRow: unknown,
  owner: ResolvedOwnerScope,
): StatisticsHandFact {
  const parsed = HandRowSchema.safeParse(rawRow)
  if (!parsed.success) return corruption()
  const row = parsed.data
  const checkpointRead = currentHandStartCheckpointReader.read(
    row.checkpointPayloadVersion,
    row.checkpointPayload,
  )
  if (checkpointRead.kind === 'unknownVersion') {
    throw new UnknownPayloadVersionError('handStartCheckpoint')
  }
  if (checkpointRead.kind === 'invalidPayload') return corruption()
  const resultRead = currentCompletedHandResultReader.read(
    row.completedResultPayloadVersion,
    row.completedResultPayload,
  )
  if (resultRead.kind === 'unknownVersion') {
    throw new UnknownPayloadVersionError('completedHandResult')
  }
  if (resultRead.kind === 'invalidPayload') return corruption()
  const checkpoint = checkpointRead.value
  const result: CompletedHandResult = resultRead.value
  if (
    row.handId !== checkpoint.startedHand.handId ||
    row.handId !== result.handId ||
    row.handNumber !== checkpoint.startedHand.handNumber ||
    !completedHandResultMirrorsCheckpoint(checkpoint, result)
  ) {
    return corruption()
  }
  const roster = mapRoster(row.roster, result.seats)
  return deepFreeze({
    history: {
      ownerId: owner.ownerId,
      sessionId: row.sessionId,
      handId: row.handId,
      handNumber: row.handNumber,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      checkpoint,
      result,
      roster: roster.roster,
      events: mapEvents(row.events, row.handId),
    } satisfies CompletedHandHistoryFacts,
    aiParticipants: roster.aiParticipants,
  })
}

function mapSessionFact(rawRow: unknown): StatisticsSessionFact {
  const parsed = SessionRowSchema.safeParse(rawRow)
  if (!parsed.success) return corruption()
  const row = parsed.data
  if (row.snapshotPayloadVersion === null || row.snapshotPayload === null) {
    return corruption()
  }
  const snapshot = currentSnapshotReader.read(
    row.snapshotPayloadVersion,
    row.snapshotPayload,
  )
  if (snapshot.kind === 'unknownVersion') {
    throw new UnknownPayloadVersionError('privateTableState')
  }
  if (snapshot.kind === 'invalidPayload') return corruption()
  const roster = mapRoster(row.roster, snapshot.value.poker.seats)
  return deepFreeze({
    sessionId: row.sessionId,
    lifecycleStatus: row.lifecycleStatus,
    currentHandId: row.currentHandId,
    stateVersion: row.stateVersion,
    state: snapshot.value,
    roster: roster.roster,
    aiParticipants: roster.aiParticipants,
  })
}

async function readHandBatch(
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
  query: HandStatisticsQuery,
  after: { readonly startedAt: string; readonly handId: string } | null,
  batchSize: number,
): Promise<readonly unknown[]> {
  try {
    return await transaction`
      WITH candidate_hands AS (
        SELECT h.*
        FROM app_private.hands AS h
        WHERE h.owner_id = ${owner.databaseOwnerId}::uuid
          AND h.status = 'completed'
          AND (${query.sessionId}::uuid IS NULL OR h.session_id = ${query.sessionId}::uuid)
          AND (${query.from}::timestamptz IS NULL OR h.started_at >= ${query.from}::timestamptz)
          AND (${query.to}::timestamptz IS NULL OR h.started_at < ${query.to}::timestamptz)
          AND (
            (${query.personaId}::text IS NULL
              AND ${query.personaVersion}::integer IS NULL
              AND ${query.personaName}::text IS NULL
              AND ${query.configSnapshotKey}::text IS NULL)
            OR EXISTS (
              SELECT 1
              FROM app_private.session_agents AS agent
              JOIN app_private.session_participants AS participant
                ON participant.id = agent.participant_id
                AND participant.session_id = agent.session_id
                AND participant.owner_id = agent.owner_id
              WHERE agent.session_id = h.session_id
                AND agent.owner_id = h.owner_id
                AND participant.participant_type = 'agent'
                AND (${query.personaId}::text IS NULL OR agent.persona_id = ${query.personaId})
                AND (${query.personaVersion}::integer IS NULL OR agent.persona_version = ${query.personaVersion}::integer)
                AND (${query.personaName}::text IS NULL OR agent.display_name = ${query.personaName})
                AND (${query.configSnapshotKey}::text IS NULL OR agent.config_snapshot_key = ${query.configSnapshotKey})
            )
          )
          AND (
            ${after?.startedAt ?? null}::timestamptz IS NULL
            OR (h.started_at, h.id) > (
              ${after?.startedAt ?? null}::timestamptz,
              ${after?.handId ?? null}::uuid
            )
          )
        ORDER BY h.started_at ASC, h.id ASC
        LIMIT ${batchSize}
      )
      SELECT
        h.id::text AS "handId",
        h.session_id::text AS "sessionId",
        h.hand_number::float8 AS "handNumber",
        to_char(h.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "startedAt",
        to_char(h.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "completedAt",
        h.hand_start_checkpoint_payload_version AS "checkpointPayloadVersion",
        h.hand_start_checkpoint_payload AS "checkpointPayload",
        h.completed_result_payload_version AS "completedResultPayloadVersion",
        h.completed_result_payload AS "completedResultPayload",
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'seatNumber', participant.seat_number,
            'playerId', participant.id::text,
            'participantType', participant.participant_type,
            'displayName', agent.display_name,
            'avatarColor', agent.avatar_color,
            'personaId', agent.persona_id,
            'personaVersion', agent.persona_version,
            'configSnapshotKey', agent.config_snapshot_key
          ) ORDER BY participant.seat_number)
          FROM app_private.session_participants AS participant
          LEFT JOIN app_private.session_agents AS agent
            ON agent.participant_id = participant.id
            AND agent.session_id = participant.session_id
            AND agent.owner_id = participant.owner_id
          WHERE participant.session_id = h.session_id
            AND participant.owner_id = h.owner_id
        ), '[]'::jsonb) AS roster,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'eventSeq', event.event_seq::float8,
            'privateEventPayloadVersion', event.private_event_payload_version,
            'privateEventPayload', event.private_event_payload
          ) ORDER BY event.event_seq)
          FROM app_private.session_events AS event
          WHERE event.hand_id = h.id
            AND event.session_id = h.session_id
            AND event.owner_id = h.owner_id
        ), '[]'::jsonb) AS events
      FROM candidate_hands AS h
      ORDER BY h.started_at ASC, h.id ASC
    `
  } catch {
    throw new DatabaseOperationError()
  }
}

async function readSessionBatch(
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
  query: SessionStatisticsQuery,
  after: { readonly endedAt: string; readonly sessionId: string } | null,
  batchSize: number,
): Promise<readonly unknown[]> {
  try {
    return await transaction`
      WITH candidate_sessions AS (
        SELECT s.*
        FROM app_private.sessions AS s
        WHERE s.owner_id = ${owner.databaseOwnerId}::uuid
          AND s.lifecycle_status = 'ended'
          AND (${query.sessionId}::uuid IS NULL OR s.id = ${query.sessionId}::uuid)
          AND (${query.from}::timestamptz IS NULL OR s.ended_at >= ${query.from}::timestamptz)
          AND (${query.to}::timestamptz IS NULL OR s.ended_at < ${query.to}::timestamptz)
          AND (
            (${query.personaId}::text IS NULL
              AND ${query.personaVersion}::integer IS NULL
              AND ${query.personaName}::text IS NULL
              AND ${query.configSnapshotKey}::text IS NULL)
            OR EXISTS (
              SELECT 1
              FROM app_private.session_agents AS agent
              JOIN app_private.session_participants AS participant
                ON participant.id = agent.participant_id
                AND participant.session_id = agent.session_id
                AND participant.owner_id = agent.owner_id
              WHERE agent.session_id = s.id
                AND agent.owner_id = s.owner_id
                AND participant.participant_type = 'agent'
                AND (${query.personaId}::text IS NULL OR agent.persona_id = ${query.personaId})
                AND (${query.personaVersion}::integer IS NULL OR agent.persona_version = ${query.personaVersion}::integer)
                AND (${query.personaName}::text IS NULL OR agent.display_name = ${query.personaName})
                AND (${query.configSnapshotKey}::text IS NULL OR agent.config_snapshot_key = ${query.configSnapshotKey})
            )
          )
          AND (
            ${after?.endedAt ?? null}::timestamptz IS NULL
            OR (s.ended_at, s.id) > (
              ${after?.endedAt ?? null}::timestamptz,
              ${after?.sessionId ?? null}::uuid
            )
          )
        ORDER BY s.ended_at ASC, s.id ASC
        LIMIT ${batchSize}
      )
      SELECT
        s.id::text AS "sessionId",
        s.lifecycle_status AS "lifecycleStatus",
        s.current_hand_id::text AS "currentHandId",
        s.state_version::float8 AS "stateVersion",
        snapshot.private_table_state_payload_version AS "snapshotPayloadVersion",
        snapshot.private_table_state_payload AS "snapshotPayload",
        to_char(s.ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "endedAt",
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'seatNumber', participant.seat_number,
            'playerId', participant.id::text,
            'participantType', participant.participant_type,
            'displayName', agent.display_name,
            'avatarColor', agent.avatar_color,
            'personaId', agent.persona_id,
            'personaVersion', agent.persona_version,
            'configSnapshotKey', agent.config_snapshot_key
          ) ORDER BY participant.seat_number)
          FROM app_private.session_participants AS participant
          LEFT JOIN app_private.session_agents AS agent
            ON agent.participant_id = participant.id
            AND agent.session_id = participant.session_id
            AND agent.owner_id = participant.owner_id
          WHERE participant.session_id = s.id
            AND participant.owner_id = s.owner_id
        ), '[]'::jsonb) AS roster
      FROM candidate_sessions AS s
      LEFT JOIN app_private.session_snapshots AS snapshot
        ON snapshot.session_id = s.id
        AND snapshot.owner_id = s.owner_id
      ORDER BY s.ended_at ASC, s.id ASC
    `
  } catch {
    throw new DatabaseOperationError()
  }
}

function validBatchSize(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= 100
}

async function configureReadOnlyRepeatableRead(
  transaction: TransactionSql,
): Promise<void> {
  try {
    await transaction`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`
  } catch {
    throw new DatabaseOperationError()
  }
}

export function createStatisticsFactsRepository(input: {
  readonly sql: Sql
  readonly owner: ResolvedOwnerScope
  readonly batchSize?: number
}): StatisticsFactsReader {
  const batchSize = input.batchSize ?? 50
  if (!isResolvedOwnerScope(input.owner) || !validBatchSize(batchSize)) {
    throw new RepositoryInputValidationError()
  }
  const reader: StatisticsFactsReader = {
    async scanHandFacts(query, consume) {
      if (!HandStatisticsQuerySchema.safeParse(query).success) {
        throw new RepositoryInputValidationError()
      }
      await runDatabaseTransaction(input.sql, async (transaction) => {
        await configureReadOnlyRepeatableRead(transaction)
        let after: {
          readonly startedAt: string
          readonly handId: string
        } | null = null
        for (;;) {
          const rows = await readHandBatch(
            transaction,
            input.owner,
            query,
            after,
            batchSize,
          )
          if (rows.length === 0) return
          const facts = rows.map((row) => mapHandFact(row, input.owner))
          const last = facts.at(-1)
          if (last === undefined) return invalidBatch()
          after = {
            startedAt: last.history.startedAt,
            handId: last.history.handId,
          }
          for (const fact of facts) await consume(fact)
        }
      })
    },
    async scanSessionFacts(query, consume) {
      if (!SessionStatisticsQuerySchema.safeParse(query).success) {
        throw new RepositoryInputValidationError()
      }
      await runDatabaseTransaction(input.sql, async (transaction) => {
        await configureReadOnlyRepeatableRead(transaction)
        let after: {
          readonly endedAt: string
          readonly sessionId: string
        } | null = null
        for (;;) {
          const rows = await readSessionBatch(
            transaction,
            input.owner,
            query,
            after,
            batchSize,
          )
          if (rows.length === 0) return
          const facts = rows.map(mapSessionFact)
          const last = facts.at(-1)
          if (last === undefined) return invalidBatch()
          const rawLast = SessionRowSchema.safeParse(rows.at(-1))
          if (!rawLast.success) return invalidBatch()
          after = {
            endedAt: rawLast.data.endedAt,
            sessionId: last.sessionId,
          }
          for (const fact of facts) await consume(fact)
        }
      })
    },
  }
  return Object.freeze(reader)
}

function invalidBatch(): never {
  throw new PersistenceDataCorruptionError('invalidStatisticsFacts')
}
