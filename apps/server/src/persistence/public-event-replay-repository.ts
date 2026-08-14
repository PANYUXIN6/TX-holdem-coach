import type { Sql } from 'postgres'
import { z } from 'zod'
import type { ResolvedOwnerScope } from './owner-scope.js'
import {
  DatabaseOperationError,
  PersistenceDataCorruptionError,
  RepositoryInputValidationError,
} from './errors.js'
import { SESSION_DIAGNOSTIC_CODES } from '../sessions/authoritative-state/recovery-decision.js'
import type {
  PublicEventReplayRepository,
  PublicEventStreamBootstrap,
  PublicEventStreamHead,
} from '../sessions/public-projection/public-event-replay.js'
import type { StoredPublicEventRow } from '../sessions/public-projection/public-event-protocol.js'
import { mapPublicSessionProjectionFacts } from './public-projection-repository.js'

const SafeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
const HeadRowSchema = z.strictObject({
  sessionId: z.uuid(),
  lifecycleStatus: z.enum(['active', 'ended', 'readonlyDiagnostic']),
  nextEventSeq: SafeIntegerSchema,
})
const BootstrapRowSchema = z.strictObject({
  sessionId: z.uuid(),
  lifecycleStatus: z.enum(['active', 'ended', 'readonlyDiagnostic']),
  endedAt: z.string().nullable(),
  stateVersion: SafeIntegerSchema,
  nextEventSeq: SafeIntegerSchema,
  currentHandId: z.uuid().nullable(),
  diagnosticCode: z.enum(SESSION_DIAGNOSTIC_CODES).nullable(),
  diagnosedAt: z.string().nullable(),
  agentRunState: z.enum(['idle', 'thinking', 'paused']),
  activePlayerRunId: z.uuid().nullable(),
  activeDecisionRequestId: z.uuid().nullable(),
  snapshotPayloadVersion: z.number().int().positive().nullable(),
  snapshotPayload: z.unknown().nullable(),
  roster: z.array(z.unknown()),
  currentHandEvents: z.array(z.unknown()),
  totalEventCount: SafeIntegerSchema,
  minimumEventSeq: SafeIntegerSchema.nullable(),
  maximumEventSeq: SafeIntegerSchema.nullable(),
})
const ReplayRowSchema = z.strictObject({
  eventId: z.uuid(),
  sessionId: z.uuid(),
  eventSeq: SafeIntegerSchema,
  stateVersionAfter: SafeIntegerSchema,
  protocolVersion: z.number().int().positive(),
  publicEventPayload: z.unknown(),
})

function corruption(): never {
  throw new PersistenceDataCorruptionError('invalidPublicEventReplay')
}

function parseSessionId(sessionId: string): void {
  if (!z.uuid().safeParse(sessionId).success) {
    throw new RepositoryInputValidationError()
  }
}

function mapHead(input: unknown): PublicEventStreamHead {
  const row = HeadRowSchema.safeParse(input)
  if (!row.success || row.data.nextEventSeq <= 0) return corruption()
  return Object.freeze({
    sessionId: row.data.sessionId,
    lifecycleStatus: row.data.lifecycleStatus,
    highWatermark: row.data.nextEventSeq - 1,
  })
}

function mapBootstrap(input: unknown): PublicEventStreamBootstrap {
  const row = BootstrapRowSchema.safeParse(input)
  if (!row.success || row.data.nextEventSeq <= 0) return corruption()
  if (row.data.lifecycleStatus === 'readonlyDiagnostic') {
    if (row.data.diagnosticCode === null || row.data.diagnosedAt === null) {
      return corruption()
    }
    return Object.freeze({ kind: 'readonlyDiagnostic' })
  }
  if (row.data.diagnosticCode !== null || row.data.diagnosedAt !== null) {
    return corruption()
  }
  const {
    totalEventCount,
    minimumEventSeq,
    maximumEventSeq,
    ...projectionRow
  } = row.data
  return Object.freeze({
    kind: 'ready',
    facts: mapPublicSessionProjectionFacts(projectionRow),
    highWatermark: row.data.nextEventSeq - 1,
    totalEventCount,
    minimumEventSeq: minimumEventSeq ?? -1,
    maximumEventSeq: maximumEventSeq ?? -1,
  })
}

export function createPublicEventReplayRepository(input: {
  readonly sql: Sql
  readonly owner: ResolvedOwnerScope
}): PublicEventReplayRepository {
  return Object.freeze({
    async readHead(sessionId: string) {
      parseSessionId(sessionId)
      let rows: readonly unknown[]
      try {
        rows = await input.sql`
          SELECT s.id::text AS "sessionId",
            s.lifecycle_status AS "lifecycleStatus",
            s.next_event_seq::float8 AS "nextEventSeq"
          FROM app_private.sessions s
          WHERE s.id = ${sessionId}::uuid
            AND s.owner_id = ${input.owner.databaseOwnerId}::uuid
          LIMIT 2
        `
      } catch {
        throw new DatabaseOperationError()
      }
      if (rows.length === 0) return null
      if (rows.length !== 1) return corruption()
      return mapHead(rows[0])
    },
    async readBootstrap(sessionId: string) {
      parseSessionId(sessionId)
      let rows: readonly unknown[]
      try {
        rows = await input.sql`
          SELECT
            s.id::text AS "sessionId",
            s.lifecycle_status AS "lifecycleStatus",
            s.ended_at::text AS "endedAt",
            s.state_version::float8 AS "stateVersion",
            s.next_event_seq::float8 AS "nextEventSeq",
            s.current_hand_id::text AS "currentHandId",
            s.diagnostic_code AS "diagnosticCode",
            s.diagnosed_at::text AS "diagnosedAt",
            s.agent_run_state AS "agentRunState",
            s.active_player_run_id::text AS "activePlayerRunId",
            s.active_decision_request_id::text AS "activeDecisionRequestId",
            ss.private_table_state_payload_version AS "snapshotPayloadVersion",
            ss.private_table_state_payload AS "snapshotPayload",
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'seatNumber', p.seat_number,
                'playerId', p.id::text,
                'participantType', p.participant_type,
                'displayName', a.display_name,
                'avatarColor', a.avatar_color
              ) ORDER BY p.seat_number)
              FROM app_private.session_participants p
              LEFT JOIN app_private.session_agents a
                ON a.participant_id = p.id
                AND a.session_id = p.session_id
                AND a.owner_id = p.owner_id
              WHERE p.session_id = s.id AND p.owner_id = s.owner_id
            ), '[]'::jsonb) AS roster,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'eventSeq', e.event_seq::float8,
                'handId', e.hand_id::text,
                'privateEventPayloadVersion', e.private_event_payload_version,
                'privateEventPayload', e.private_event_payload
              ) ORDER BY e.event_seq)
              FROM app_private.session_events e
              WHERE e.session_id = s.id
                AND e.owner_id = s.owner_id
                AND e.hand_id = s.current_hand_id
            ), '[]'::jsonb) AS "currentHandEvents",
            (SELECT count(*)::float8
              FROM app_private.session_events e
              WHERE e.session_id = s.id AND e.owner_id = s.owner_id
            ) AS "totalEventCount",
            (SELECT min(e.event_seq)::float8
              FROM app_private.session_events e
              WHERE e.session_id = s.id AND e.owner_id = s.owner_id
            ) AS "minimumEventSeq",
            (SELECT max(e.event_seq)::float8
              FROM app_private.session_events e
              WHERE e.session_id = s.id AND e.owner_id = s.owner_id
            ) AS "maximumEventSeq"
          FROM app_private.sessions s
          LEFT JOIN app_private.session_snapshots ss
            ON ss.session_id = s.id AND ss.owner_id = s.owner_id
          WHERE s.id = ${sessionId}::uuid
            AND s.owner_id = ${input.owner.databaseOwnerId}::uuid
          LIMIT 2
        `
      } catch {
        throw new DatabaseOperationError()
      }
      if (rows.length === 0) return null
      if (rows.length !== 1) return corruption()
      return mapBootstrap(rows[0])
    },
    async readReplayPage({
      sessionId,
      fromEventSeq,
      throughEventSeq,
    }: {
      readonly sessionId: string
      readonly fromEventSeq: number
      readonly throughEventSeq: number
    }) {
      parseSessionId(sessionId)
      if (
        !SafeIntegerSchema.safeParse(fromEventSeq).success ||
        !SafeIntegerSchema.safeParse(throughEventSeq).success ||
        fromEventSeq > throughEventSeq
      ) {
        throw new RepositoryInputValidationError()
      }
      let rows: readonly unknown[]
      try {
        rows = await input.sql`
          SELECT e.id::text AS "eventId", e.session_id::text AS "sessionId",
            e.event_seq::float8 AS "eventSeq",
            e.state_version_after::float8 AS "stateVersionAfter",
            e.protocol_version AS "protocolVersion",
            e.public_event_payload AS "publicEventPayload"
          FROM app_private.session_events e
          JOIN app_private.sessions s
            ON s.id = e.session_id AND s.owner_id = e.owner_id
          WHERE e.session_id = ${sessionId}::uuid
            AND e.owner_id = ${input.owner.databaseOwnerId}::uuid
            AND e.event_seq >= ${fromEventSeq}::bigint
            AND e.event_seq <= ${throughEventSeq}::bigint
          ORDER BY e.event_seq ASC
        `
      } catch {
        throw new DatabaseOperationError()
      }
      if (rows.length === 0) return null
      const parsed = z.array(ReplayRowSchema).safeParse(rows)
      if (!parsed.success) return corruption()
      return parsed.data satisfies readonly StoredPublicEventRow[]
    },
  })
}
