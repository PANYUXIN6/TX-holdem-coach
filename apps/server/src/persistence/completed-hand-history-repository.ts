import type { Sql } from 'postgres'
import { z } from 'zod'
import type { CompletedHandResult } from '../poker/hand-result.js'
import { currentCompletedHandResultReader } from '../sessions/hand-audit/completed-hand-result-codec.js'
import { completedHandResultMirrorsCheckpoint } from '../sessions/hand-audit/completed-hand-mirrors.js'
import { currentHandStartCheckpointReader } from '../sessions/hand-audit/hand-start-checkpoint-codec.js'
import { currentPrivateEventReader } from '../sessions/authoritative-state/private-event-codec.js'
import { getPrivateEventHandId } from '../sessions/authoritative-state/private-event.js'
import type {
  CompletedHandHistoryFacts,
  CompletedHandHistoryFactsReader,
  CompletedHandHistoryRosterEntry,
  CommittedPrivateHandEventFact,
} from '../sessions/hand-history/completed-hand-history.js'
import { projectParticipantPresentation } from '../sessions/participant-presentation.js'
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
const RosterRowSchema = z.strictObject({
  seatNumber: z.number().int().min(0).max(8),
  playerId: z.uuid(),
  participantType: z.enum(['user', 'agent']),
  displayName: z.string().nullable(),
  avatarColor: z.string().nullable(),
})
const EventRowSchema = z.strictObject({
  eventSeq: SafeNonnegativeIntegerSchema,
  privateEventPayloadVersion: z.unknown(),
  privateEventPayload: z.unknown(),
})
const CompletedHandHistoryRowSchema = z.strictObject({
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

function corruption(): never {
  throw new PersistenceDataCorruptionError('invalidCompletedHandHistory')
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
  result: CompletedHandResult,
): readonly CompletedHandHistoryRosterEntry[] {
  const parsed = z.array(RosterRowSchema).safeParse(rawRoster)
  if (!parsed.success || parsed.data.length !== result.seats.length) {
    return corruption()
  }
  const sorted = [...parsed.data].sort(
    (left, right) => left.seatNumber - right.seatNumber,
  )
  const roster = sorted.map((entry, index) => {
    const seat = result.seats[index]
    if (
      seat === undefined ||
      entry.seatNumber !== seat.seatNumber ||
      entry.playerId !== seat.playerId ||
      (entry.participantType === 'user') !== seat.isUser ||
      (entry.participantType === 'user') !== (entry.seatNumber === 0) ||
      (entry.participantType === 'user' &&
        (entry.displayName !== null || entry.avatarColor !== null)) ||
      (entry.participantType === 'agent' &&
        (entry.displayName === null || entry.avatarColor === null))
    ) {
      return corruption()
    }
    const presentation =
      entry.participantType === 'user'
        ? projectParticipantPresentation({ isUser: true })
        : projectParticipantPresentation({
            isUser: false,
            displayName: entry.displayName ?? corruption(),
            avatarColor: entry.avatarColor ?? corruption(),
          })
    return {
      seatNumber: entry.seatNumber,
      playerId: entry.playerId,
      isUser: entry.participantType === 'user',
      displayName: presentation.displayName,
      avatarColor: presentation.avatarColor,
    } as const
  })
  if (
    roster.filter((entry) => entry.isUser).length !== 1 ||
    new Set(roster.map((entry) => entry.seatNumber)).size !== roster.length
  ) {
    return corruption()
  }
  return Object.freeze(roster)
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

function mapFacts(
  rawRow: unknown,
  owner: ResolvedOwnerScope,
): CompletedHandHistoryFacts {
  const parsed = CompletedHandHistoryRowSchema.safeParse(rawRow)
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
  const result = resultRead.value
  if (
    row.handId !== checkpoint.startedHand.handId ||
    row.handId !== result.handId ||
    row.handNumber !== checkpoint.startedHand.handNumber ||
    !completedHandResultMirrorsCheckpoint(checkpoint, result)
  ) {
    return corruption()
  }
  return deepFreeze({
    ownerId: owner.ownerId,
    sessionId: row.sessionId,
    handId: row.handId,
    handNumber: row.handNumber,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    checkpoint,
    result,
    roster: mapRoster(row.roster, result),
    events: mapEvents(row.events, row.handId),
  })
}

async function readCompletedHistoryRow(
  sql: Sql,
  owner: ResolvedOwnerScope,
  handId: string,
): Promise<readonly unknown[]> {
  try {
    return await sql`
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
            'seatNumber', p.seat_number,
            'playerId', p.id::text,
            'participantType', p.participant_type,
            'displayName', a.display_name,
            'avatarColor', a.avatar_color
          ) ORDER BY p.seat_number)
          FROM app_private.session_participants AS p
          LEFT JOIN app_private.session_agents AS a
            ON a.participant_id = p.id
            AND a.session_id = p.session_id
            AND a.owner_id = p.owner_id
          WHERE p.session_id = h.session_id
            AND p.owner_id = h.owner_id
        ), '[]'::jsonb) AS roster,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'eventSeq', e.event_seq::float8,
            'privateEventPayloadVersion', e.private_event_payload_version,
            'privateEventPayload', e.private_event_payload
          ) ORDER BY e.event_seq)
          FROM app_private.session_events AS e
          WHERE e.hand_id = h.id
            AND e.session_id = h.session_id
            AND e.owner_id = h.owner_id
        ), '[]'::jsonb) AS events
      FROM app_private.hands AS h
      WHERE h.id = ${handId}::uuid
        AND h.owner_id = ${owner.databaseOwnerId}::uuid
        AND h.status = 'completed'
      LIMIT 2
    `
  } catch {
    throw new DatabaseOperationError()
  }
}

export function createCompletedHandHistoryFactsRepository(input: {
  readonly sql: Sql
  readonly owner: ResolvedOwnerScope
}): CompletedHandHistoryFactsReader {
  if (!isResolvedOwnerScope(input.owner)) {
    throw new RepositoryInputValidationError()
  }
  return Object.freeze({
    async readCompletedHandHistoryFacts(handId: string) {
      if (!z.uuid().safeParse(handId).success) {
        throw new RepositoryInputValidationError()
      }
      const rows = await readCompletedHistoryRow(input.sql, input.owner, handId)
      if (rows.length === 0) return null
      if (rows.length !== 1) return corruption()
      return mapFacts(rows[0], input.owner)
    },
  })
}
