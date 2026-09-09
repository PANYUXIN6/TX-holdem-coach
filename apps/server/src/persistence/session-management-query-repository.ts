import type { Sql, TransactionSql } from 'postgres'
import { z } from 'zod'
import { currentSnapshotReader } from '../sessions/authoritative-state/snapshot-codec.js'
import { currentHandStartCheckpointReader } from '../sessions/hand-audit/hand-start-checkpoint-codec.js'
import type {
  SessionManagementFact,
  SessionManagementFactsReader,
} from '../sessions/data-management/session-management.js'
import type { NormalizedSessionManagementQuery } from '../sessions/data-management/session-management-query.js'
import { runDatabaseTransaction } from './database-transaction.js'
import {
  DatabaseOperationError,
  PersistenceDataCorruptionError,
  RepositoryInputValidationError,
  UnknownPayloadVersionError,
} from './errors.js'
import { isResolvedOwnerScope, type ResolvedOwnerScope } from './owner-scope.js'

const TimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
const SafeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
const RosterRowSchema = z.strictObject({
  participantId: z.uuid(),
  participantType: z.enum(['user', 'agent']),
  seatNumber: z.number().int().min(0).max(8),
  displayName: z.string().nullable(),
  avatarColor: z.string().nullable(),
  personaId: z.string().nullable(),
  personaVersion: z.number().int().nullable(),
  configSnapshotKey: z.string().nullable(),
})
const SessionRowSchema = z.strictObject({
  sessionId: z.uuid(),
  lifecycle: z.enum(['active', 'ended', 'readonlyDiagnostic']),
  createdAt: TimestampSchema,
  endedAt: TimestampSchema.nullable(),
  stateVersion: SafeIntegerSchema,
  currentHandId: z.uuid().nullable(),
  completedHandCount: SafeIntegerSchema,
  snapshotPayloadVersion: z.unknown(),
  snapshotPayload: z.unknown(),
  checkpointPayloadVersion: z.unknown(),
  checkpointPayload: z.unknown(),
  roster: z.array(z.unknown()),
})
const QuerySchema = z.strictObject({
  lifecycle: z.enum(['all', 'active', 'ended', 'readonlyDiagnostic']),
  from: TimestampSchema.nullable(),
  to: TimestampSchema.nullable(),
  sort: z.enum(['newest', 'oldest']),
  limit: z.number().int().min(1).max(100),
  after: z
    .strictObject({ createdAt: TimestampSchema, sessionId: z.uuid() })
    .nullable(),
})

function corruption(): never {
  throw new PersistenceDataCorruptionError('invalidSessionManagementQuery')
}

function mapRoster(raw: readonly unknown[]) {
  const parsed = z.array(RosterRowSchema).safeParse(raw)
  if (!parsed.success) return corruption()
  const sorted = [...parsed.data].sort(
    (left, right) => left.seatNumber - right.seatNumber,
  )
  if (
    sorted.length < 6 ||
    sorted.length > 9 ||
    new Set(sorted.map(({ seatNumber }) => seatNumber)).size !==
      sorted.length ||
    sorted.filter(({ participantType }) => participantType === 'user')
      .length !== 1
  ) {
    return corruption()
  }
  return Object.freeze(
    sorted.map((entry) => {
      if (entry.participantType === 'user') {
        if (
          entry.seatNumber !== 0 ||
          entry.displayName !== null ||
          entry.avatarColor !== null ||
          entry.personaId !== null ||
          entry.personaVersion !== null ||
          entry.configSnapshotKey !== null
        ) {
          return corruption()
        }
        return Object.freeze({
          kind: 'user' as const,
          participantId: entry.participantId,
          seatNumber: 0 as const,
        })
      }
      if (
        entry.seatNumber === 0 ||
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
      return Object.freeze({
        kind: 'ai' as const,
        participantId: entry.participantId,
        seatNumber: entry.seatNumber,
        personaId: entry.personaId,
        personaVersion: entry.personaVersion,
        displayName: entry.displayName,
        avatarColor: entry.avatarColor,
        configSnapshotKey: entry.configSnapshotKey,
      })
    }),
  )
}

function mapRow(raw: unknown): SessionManagementFact {
  const parsed = SessionRowSchema.safeParse(raw)
  if (!parsed.success) return corruption()
  const row = parsed.data
  const roster = mapRoster(row.roster)
  if (row.lifecycle === 'readonlyDiagnostic') {
    return Object.freeze({
      ...row,
      roster,
      initialStacks: null,
      state: null,
    })
  }
  const snapshot = currentSnapshotReader.read(
    row.snapshotPayloadVersion,
    row.snapshotPayload,
  )
  if (snapshot.kind === 'unknownVersion') {
    throw new UnknownPayloadVersionError('privateTableState')
  }
  if (snapshot.kind === 'invalidPayload') return corruption()
  const checkpoint = currentHandStartCheckpointReader.read(
    row.checkpointPayloadVersion,
    row.checkpointPayload,
  )
  if (checkpoint.kind === 'unknownVersion') {
    throw new UnknownPayloadVersionError('handStartCheckpoint')
  }
  if (
    checkpoint.kind === 'invalidPayload' ||
    checkpoint.value.startedHand.handNumber !== 1
  ) {
    return corruption()
  }
  return Object.freeze({
    ...row,
    roster,
    initialStacks: Object.freeze(
      checkpoint.value.stateBeforeStartCommand.poker.seats.map((seat) =>
        Object.freeze({
          participantId: seat.playerId,
          seatNumber: seat.seatNumber,
          stack: seat.stack,
        }),
      ),
    ),
    state: snapshot.value,
  })
}

async function readRows(
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
  query: NormalizedSessionManagementQuery,
): Promise<readonly unknown[]> {
  try {
    return await transaction.unsafe(
      `
      WITH candidate_sessions AS (
        SELECT s.*
        FROM app_private.sessions AS s
        WHERE s.owner_id = $1::uuid
          AND ($2::text = 'all' OR s.lifecycle_status::text = $2::text)
          AND ($3::timestamptz IS NULL OR s.created_at >= $3::timestamptz)
          AND ($4::timestamptz IS NULL OR s.created_at < $4::timestamptz)
          AND (
            $5::text IS NULL
            OR (
              $6::text = 'newest'
              AND (
                to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') < $5::text
                OR (
                  to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') = $5::text
                  AND s.id < $7::uuid
                )
              )
            )
            OR (
              $6::text = 'oldest'
              AND (
                to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') > $5::text
                OR (
                  to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') = $5::text
                  AND s.id > $7::uuid
                )
              )
            )
          )
        ORDER BY
          CASE WHEN $6::text = 'newest' THEN to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END DESC,
          CASE WHEN $6::text = 'newest' THEN s.id END DESC,
          CASE WHEN $6::text = 'oldest' THEN to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END ASC,
          CASE WHEN $6::text = 'oldest' THEN s.id END ASC
        LIMIT $8::int
      )
      SELECT
        s.id::text AS "sessionId",
        s.lifecycle_status AS lifecycle,
        to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
        CASE WHEN s.ended_at IS NULL THEN NULL ELSE to_char(s.ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS "endedAt",
        s.state_version::float8 AS "stateVersion",
        s.current_hand_id::text AS "currentHandId",
        (SELECT count(*)::float8 FROM app_private.hands AS counted WHERE counted.session_id = s.id AND counted.owner_id = s.owner_id AND counted.status = 'completed') AS "completedHandCount",
        snapshot.private_table_state_payload_version AS "snapshotPayloadVersion",
        snapshot.private_table_state_payload AS "snapshotPayload",
        first_hand.hand_start_checkpoint_payload_version AS "checkpointPayloadVersion",
        first_hand.hand_start_checkpoint_payload AS "checkpointPayload",
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'participantId', participant.id::text,
            'participantType', participant.participant_type,
            'seatNumber', participant.seat_number,
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
          WHERE participant.session_id = s.id AND participant.owner_id = s.owner_id
        ), '[]'::jsonb) AS roster
      FROM candidate_sessions AS s
      LEFT JOIN app_private.session_snapshots AS snapshot
        ON snapshot.session_id = s.id AND snapshot.owner_id = s.owner_id
      LEFT JOIN app_private.hands AS first_hand
        ON first_hand.session_id = s.id AND first_hand.owner_id = s.owner_id AND first_hand.hand_number = 1
      ORDER BY
        CASE WHEN $6::text = 'newest' THEN to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END DESC,
        CASE WHEN $6::text = 'newest' THEN s.id END DESC,
        CASE WHEN $6::text = 'oldest' THEN to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END ASC,
        CASE WHEN $6::text = 'oldest' THEN s.id END ASC
      `,
      [
        owner.databaseOwnerId,
        query.lifecycle,
        query.from,
        query.to,
        query.after?.createdAt ?? null,
        query.sort,
        query.after?.sessionId ?? null,
        query.limit + 1,
      ],
    )
  } catch {
    throw new DatabaseOperationError()
  }
}

export function createSessionManagementFactsRepository(input: {
  readonly sql: Sql
  readonly owner: ResolvedOwnerScope
}): SessionManagementFactsReader {
  if (!isResolvedOwnerScope(input.owner)) {
    throw new RepositoryInputValidationError()
  }
  return Object.freeze({
    async listSessionManagementFacts(query: NormalizedSessionManagementQuery) {
      if (!QuerySchema.safeParse(query).success) {
        throw new RepositoryInputValidationError()
      }
      return runDatabaseTransaction(input.sql, async (transaction) => {
        await transaction`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`
        const rows = await readRows(transaction, input.owner, query)
        return Object.freeze({
          items: Object.freeze(rows.slice(0, query.limit).map(mapRow)),
          hasMore: rows.length > query.limit,
        })
      })
    },
  })
}
