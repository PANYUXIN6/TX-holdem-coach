import type { Sql } from 'postgres'
import { z } from 'zod'
import {
  COMPLETED_HAND_RESULT_PAYLOAD_VERSION,
  currentCompletedHandResultReader,
} from '../sessions/hand-audit/completed-hand-result-codec.js'
import { completedHandResultMirrorsCheckpoint } from '../sessions/hand-audit/completed-hand-mirrors.js'
import { currentHandStartCheckpointReader } from '../sessions/hand-audit/hand-start-checkpoint-codec.js'
import type {
  CompletedHandHistoryListFact,
  CompletedHandHistoryListFactsReader,
  HistoricalPersonaSnapshot,
} from '../sessions/hand-history/completed-hand-history-list.js'
import { type CompletedHandHistoryListQuery } from '../sessions/hand-history/completed-hand-history-list-query.js'
import {
  DatabaseOperationError,
  PersistenceDataCorruptionError,
  RepositoryInputValidationError,
  UnknownPayloadVersionError,
} from './errors.js'
import { isResolvedOwnerScope, type ResolvedOwnerScope } from './owner-scope.js'

const SafePositiveIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
const CanonicalTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
const ListQuerySchema = z.strictObject({
  from: CanonicalTimestampSchema.nullable(),
  to: CanonicalTimestampSchema.nullable(),
  sessionId: z.uuid().nullable(),
  position: z
    .enum(['UTG', 'UTG+1', 'MP', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'])
    .nullable(),
  result: z.enum(['profit', 'loss', 'even']).nullable(),
  startingHand: z.string().nullable(),
  personaId: z.string().min(1).max(128).nullable(),
  personaVersion: z.number().int().positive().max(2_147_483_647).nullable(),
  personaName: z.string().min(1).max(256).nullable(),
  configSnapshotKey: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  sort: z.enum(['newest', 'oldest']),
  limit: z.number().int().min(1).max(100),
  after: z
    .strictObject({
      startedAt: CanonicalTimestampSchema,
      handId: z.uuid(),
    })
    .nullable(),
})
const ListRosterRowSchema = z.strictObject({
  seatNumber: z.number().int().min(0).max(8),
  playerId: z.uuid(),
  participantType: z.enum(['user', 'agent']),
  displayName: z.string().nullable(),
  avatarColor: z.string().nullable(),
  personaId: z.string().nullable(),
  personaVersion: z.number().int().nullable(),
  configSnapshotKey: z.string().nullable(),
})
const CompletedHandHistoryListRowSchema = z.strictObject({
  handId: z.uuid(),
  sessionId: z.uuid(),
  handNumber: SafePositiveIntegerSchema,
  startedAt: CanonicalTimestampSchema,
  completedAt: CanonicalTimestampSchema,
  checkpointPayloadVersion: z.unknown(),
  checkpointPayload: z.unknown(),
  completedResultPayloadVersion: z.unknown(),
  completedResultPayload: z.unknown(),
  roster: z.array(z.unknown()),
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
  result: CompletedHandHistoryListFact['result'],
): readonly HistoricalPersonaSnapshot[] {
  const parsed = z.array(ListRosterRowSchema).safeParse(rawRoster)
  if (!parsed.success || parsed.data.length !== result.seats.length) {
    return corruption()
  }
  const roster = [...parsed.data].sort(
    (left, right) => left.seatNumber - right.seatNumber,
  )
  const resultSeatByNumber = new Map(
    result.seats.map((seat) => [seat.seatNumber, seat]),
  )
  if (resultSeatByNumber.size !== result.seats.length) return corruption()
  const aiParticipants = roster.flatMap((entry) => {
    const seat = resultSeatByNumber.get(entry.seatNumber)
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
      return []
    }
    if (
      entry.displayName === null ||
      entry.displayName.trim().length === 0 ||
      entry.avatarColor === null ||
      entry.avatarColor.trim().length === 0 ||
      entry.personaId === null ||
      entry.personaId.trim().length === 0 ||
      entry.personaVersion === null ||
      entry.personaVersion <= 0 ||
      entry.configSnapshotKey === null ||
      !/^[a-f0-9]{64}$/.test(entry.configSnapshotKey)
    ) {
      return corruption()
    }
    return [
      {
        seatNumber: entry.seatNumber,
        playerId: entry.playerId,
        personaId: entry.personaId,
        personaVersion: entry.personaVersion,
        displayName: entry.displayName,
        avatarColor: entry.avatarColor,
        configSnapshotKey: entry.configSnapshotKey,
      },
    ]
  })
  if (
    aiParticipants.length !== result.seats.length - 1 ||
    new Set(roster.map((entry) => entry.seatNumber)).size !== roster.length
  ) {
    return corruption()
  }
  return Object.freeze(aiParticipants)
}

function mapFact(rawRow: unknown): CompletedHandHistoryListFact {
  const parsed = CompletedHandHistoryListRowSchema.safeParse(rawRow)
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
  if (
    row.handId !== checkpointRead.value.startedHand.handId ||
    row.handId !== resultRead.value.handId ||
    row.handNumber !== checkpointRead.value.startedHand.handNumber ||
    !completedHandResultMirrorsCheckpoint(
      checkpointRead.value,
      resultRead.value,
    )
  ) {
    return corruption()
  }
  return deepFreeze({
    sessionId: row.sessionId,
    handId: row.handId,
    handNumber: row.handNumber,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    checkpoint: checkpointRead.value,
    result: resultRead.value,
    aiParticipants: mapRoster(row.roster, resultRead.value),
  })
}

async function readRows(
  sql: Sql,
  owner: ResolvedOwnerScope,
  query: CompletedHandHistoryListQuery,
): Promise<readonly unknown[]> {
  const afterStartedAt = query.after?.startedAt ?? null
  const afterHandId = query.after?.handId ?? null
  try {
    return await sql`
      WITH candidate_hands AS (
        SELECT h.*
        FROM app_private.hands AS h
        WHERE h.owner_id = ${owner.databaseOwnerId}::uuid
          AND h.status = 'completed'
          AND (${query.sessionId}::uuid IS NULL OR h.session_id = ${query.sessionId}::uuid)
          AND (${query.from}::timestamptz IS NULL OR h.started_at >= ${query.from}::timestamptz)
          AND (${query.to}::timestamptz IS NULL OR h.started_at < ${query.to}::timestamptz)
          AND (
            h.completed_result_payload_version IS DISTINCT FROM ${COMPLETED_HAND_RESULT_PAYLOAD_VERSION}::integer
            OR NOT (
              jsonb_typeof(h.completed_result_payload -> 'result') = 'object'
              AND jsonb_typeof(h.completed_result_payload -> 'result' -> 'seats') = 'array'
              AND jsonb_typeof(h.completed_result_payload -> 'result' -> 'positions') = 'array'
            )
            OR (
              (
                ${query.position}::text IS NULL
                OR (
                  SELECT count(*)
                  FROM jsonb_array_elements(h.completed_result_payload -> 'result' -> 'positions') AS position
                  WHERE jsonb_typeof(position -> 'seatNumber') = 'number'
                    AND position ->> 'seatNumber' = '0'
                ) <> 1
                OR EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements(h.completed_result_payload -> 'result' -> 'positions') AS position
                  WHERE jsonb_typeof(position -> 'seatNumber') = 'number'
                    AND position ->> 'seatNumber' = '0'
                    AND (
                      jsonb_typeof(position -> 'position') = 'string'
                      AND position ->> 'position' IN (
                        'UTG', 'UTG+1', 'MP', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'
                      )
                    ) IS NOT TRUE
                )
                OR EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements(h.completed_result_payload -> 'result' -> 'positions') AS position
                  WHERE jsonb_typeof(position -> 'seatNumber') = 'number'
                    AND position ->> 'seatNumber' = '0'
                    AND position ->> 'position' = ${query.position}
                )
              )
              AND (
                ${query.startingHand}::text IS NULL
                OR (
                  SELECT count(*)
                  FROM jsonb_array_elements(h.completed_result_payload -> 'result' -> 'seats') AS seat
                  WHERE jsonb_typeof(seat -> 'seatNumber') = 'number'
                    AND seat ->> 'seatNumber' = '0'
                ) <> 1
                OR EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements(h.completed_result_payload -> 'result' -> 'seats') AS seat
                  WHERE jsonb_typeof(seat -> 'seatNumber') = 'number'
                    AND seat ->> 'seatNumber' = '0'
                    AND (
                      seat ->> 'isUser' = 'true'
                      AND jsonb_typeof(seat -> 'isUser') = 'boolean'
                      AND jsonb_typeof(seat -> 'startingHandCategory') = 'string'
                      AND (
                        seat ->> 'startingHandCategory' ~ '^([2-9TJQKA])\\1$'
                        OR (
                          seat ->> 'startingHandCategory' ~ '^[2-9TJQKA][2-9TJQKA][so]$'
                          AND strpos(
                            '23456789TJQKA',
                            left(seat ->> 'startingHandCategory', 1)
                          ) > strpos(
                            '23456789TJQKA',
                            substr(seat ->> 'startingHandCategory', 2, 1)
                          )
                        )
                      )
                    ) IS NOT TRUE
                )
                OR EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements(h.completed_result_payload -> 'result' -> 'seats') AS seat
                  WHERE jsonb_typeof(seat -> 'seatNumber') = 'number'
                    AND seat ->> 'seatNumber' = '0'
                    AND seat ->> 'startingHandCategory' = ${query.startingHand}
                )
              )
              AND (
                ${query.result}::text IS NULL
                OR (
                  SELECT count(*)
                  FROM jsonb_array_elements(h.completed_result_payload -> 'result' -> 'seats') AS seat
                  WHERE jsonb_typeof(seat -> 'seatNumber') = 'number'
                    AND seat ->> 'seatNumber' = '0'
                ) <> 1
                OR EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements(h.completed_result_payload -> 'result' -> 'seats') AS seat
                  WHERE jsonb_typeof(seat -> 'seatNumber') = 'number'
                    AND seat ->> 'seatNumber' = '0'
                    AND (
                      seat ->> 'isUser' = 'true'
                      AND jsonb_typeof(seat -> 'isUser') = 'boolean'
                      AND jsonb_typeof(seat -> 'netChange') = 'number'
                      AND seat ->> 'netChange' ~ '^-?(0|[1-9][0-9]*)$'
                      AND (
                        CASE
                          WHEN jsonb_typeof(seat -> 'netChange') = 'number'
                            AND seat ->> 'netChange' ~ '^-?(0|[1-9][0-9]*)$'
                          THEN (seat ->> 'netChange')::numeric
                        END
                      ) BETWEEN -9007199254740991 AND 9007199254740991
                    ) IS NOT TRUE
                )
                OR EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements(h.completed_result_payload -> 'result' -> 'seats') AS seat
                  WHERE jsonb_typeof(seat -> 'seatNumber') = 'number'
                    AND seat ->> 'seatNumber' = '0'
                    AND (
                      (${query.result} = 'profit' AND (
                        CASE
                          WHEN jsonb_typeof(seat -> 'netChange') = 'number'
                            AND seat ->> 'netChange' ~ '^-?(0|[1-9][0-9]*)$'
                          THEN (seat ->> 'netChange')::numeric
                        END
                      ) > 0)
                      OR (${query.result} = 'loss' AND (
                        CASE
                          WHEN jsonb_typeof(seat -> 'netChange') = 'number'
                            AND seat ->> 'netChange' ~ '^-?(0|[1-9][0-9]*)$'
                          THEN (seat ->> 'netChange')::numeric
                        END
                      ) < 0)
                      OR (${query.result} = 'even' AND (
                        CASE
                          WHEN jsonb_typeof(seat -> 'netChange') = 'number'
                            AND seat ->> 'netChange' ~ '^-?(0|[1-9][0-9]*)$'
                          THEN (seat ->> 'netChange')::numeric
                        END
                      ) = 0)
                    )
                )
              )
              AND (
                (
                  ${query.personaId}::text IS NULL
                  AND ${query.personaVersion}::integer IS NULL
                  AND ${query.personaName}::text IS NULL
                  AND ${query.configSnapshotKey}::text IS NULL
                )
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
            )
          )
          AND (
            ${afterStartedAt}::timestamptz IS NULL
            OR (
              CASE
                WHEN ${query.sort} = 'newest' THEN
                  (h.started_at, h.id) < (${afterStartedAt}::timestamptz, ${afterHandId}::uuid)
                ELSE
                  (h.started_at, h.id) > (${afterStartedAt}::timestamptz, ${afterHandId}::uuid)
              END
            )
          )
        ORDER BY
          CASE WHEN ${query.sort} = 'newest' THEN h.started_at END DESC,
          CASE WHEN ${query.sort} = 'newest' THEN h.id END DESC,
          CASE WHEN ${query.sort} = 'oldest' THEN h.started_at END ASC,
          CASE WHEN ${query.sort} = 'oldest' THEN h.id END ASC
        LIMIT ${query.limit + 1}
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
        ), '[]'::jsonb) AS roster
      FROM candidate_hands AS h
      ORDER BY
        CASE WHEN ${query.sort} = 'newest' THEN h.started_at END DESC,
        CASE WHEN ${query.sort} = 'newest' THEN h.id END DESC,
        CASE WHEN ${query.sort} = 'oldest' THEN h.started_at END ASC,
        CASE WHEN ${query.sort} = 'oldest' THEN h.id END ASC
    `
  } catch {
    throw new DatabaseOperationError()
  }
}

export function createCompletedHandHistoryListFactsRepository(input: {
  readonly sql: Sql
  readonly owner: ResolvedOwnerScope
}): CompletedHandHistoryListFactsReader {
  if (!isResolvedOwnerScope(input.owner)) {
    throw new RepositoryInputValidationError()
  }
  return Object.freeze({
    async listCompletedHandHistoryFacts(query: CompletedHandHistoryListQuery) {
      if (!ListQuerySchema.safeParse(query).success) {
        throw new RepositoryInputValidationError()
      }
      const rows = await readRows(input.sql, input.owner, query)
      return Object.freeze(rows.map(mapFact))
    },
  })
}
