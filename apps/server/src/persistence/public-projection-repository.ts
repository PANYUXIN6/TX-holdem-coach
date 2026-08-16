import type { Sql, TransactionSql } from 'postgres'
import { z } from 'zod'
import type { ResolvedOwnerScope } from './owner-scope.js'
import {
  DatabaseOperationError,
  PersistenceDataCorruptionError,
  RepositoryInputValidationError,
} from './errors.js'
import type { LockedSessionView } from './session-mutation-repository.js'
import { currentPrivateEventReader } from '../sessions/authoritative-state/private-event-codec.js'
import { currentSnapshotReader } from '../sessions/authoritative-state/snapshot-codec-v1.js'
import type {
  CommittedPrivateEventFact,
  ProjectionRosterSeat,
  PublicProjectionFactsRepository,
  ActivePublicProjectionReadPort,
  PublicSessionProjectionFacts,
  PublicProjectionFactsLookup,
} from '../sessions/public-projection/public-projection-facts.js'
import { SESSION_DIAGNOSTIC_CODES } from '../sessions/authoritative-state/recovery-decision.js'

const SafeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
const SessionRowSchema = z.strictObject({
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
})
const RosterRowSchema = z.strictObject({
  seatNumber: z.number().int().min(0).max(8),
  playerId: z.uuid(),
  participantType: z.enum(['user', 'agent']),
  displayName: z.string().nullable(),
  avatarColor: z.string().nullable(),
})
const EventRowSchema = z.strictObject({
  eventSeq: SafeIntegerSchema,
  handId: z.uuid(),
  privateEventPayloadVersion: z.number().int().positive(),
  privateEventPayload: z.unknown(),
})

function corruption(): never {
  throw new PersistenceDataCorruptionError('invalidPublicProjectionFacts')
}

function mapRoster(rows: readonly unknown[]): readonly ProjectionRosterSeat[] {
  const parsed = z.array(RosterRowSchema).safeParse(rows)
  if (!parsed.success) return corruption()
  const roster = parsed.data.map((row) => {
    if (row.seatNumber === 0) {
      if (
        row.participantType !== 'user' ||
        row.displayName !== null ||
        row.avatarColor !== null
      )
        return corruption()
      return {
        seatNumber: 0 as const,
        playerId: row.playerId,
        isUser: true as const,
      }
    }
    if (
      row.participantType !== 'agent' ||
      row.displayName === null ||
      row.avatarColor === null
    )
      return corruption()
    return {
      seatNumber: row.seatNumber,
      playerId: row.playerId,
      isUser: false as const,
      displayName: row.displayName,
      avatarColor: row.avatarColor,
    }
  })
  if (
    roster.length < 6 ||
    roster.length > 9 ||
    roster.some(
      (seat, index) =>
        index > 0 && seat.seatNumber <= roster[index - 1]!.seatNumber,
    )
  )
    return corruption()
  return Object.freeze(roster)
}

function mapEvents(
  rows: readonly unknown[],
): readonly CommittedPrivateEventFact[] {
  const parsed = z.array(EventRowSchema).safeParse(rows)
  if (!parsed.success) return corruption()
  let previous = -1
  return Object.freeze(
    parsed.data.map((row) => {
      const decoded = currentPrivateEventReader.read(
        row.privateEventPayloadVersion,
        row.privateEventPayload,
      )
      if (
        decoded.kind !== 'decoded' ||
        row.eventSeq <= previous ||
        !('handId' in decoded.value || decoded.value.type === 'handStarted')
      )
        return corruption()
      const eventHandId =
        decoded.value.type === 'handStarted'
          ? decoded.value.startedHand.handId
          : decoded.value.handId
      if (eventHandId.toLowerCase() !== row.handId.toLowerCase())
        return corruption()
      previous = row.eventSeq
      return Object.freeze({
        eventSeq: row.eventSeq,
        handId: row.handId,
        event: decoded.value,
      })
    }),
  )
}

function sessionView(row: z.infer<typeof SessionRowSchema>): LockedSessionView {
  return Object.freeze({
    sessionId: row.sessionId,
    lifecycleStatus: row.lifecycleStatus,
    endedAt: row.endedAt,
    stateVersion: row.stateVersion,
    nextEventSeq: row.nextEventSeq,
    currentHandId: row.currentHandId,
    diagnosticCode: row.diagnosticCode as LockedSessionView['diagnosticCode'],
    diagnosedAt: row.diagnosedAt,
    agentRunState: row.agentRunState,
    activePlayerRunId: row.activePlayerRunId,
    activeDecisionRequestId: row.activeDecisionRequestId,
  })
}

export function mapPublicSessionProjectionFacts(
  input: unknown,
): PublicSessionProjectionFacts {
  const parsed = SessionRowSchema.safeParse(input)
  if (!parsed.success) return corruption()
  if (
    parsed.data.lifecycleStatus === 'readonlyDiagnostic' ||
    parsed.data.snapshotPayloadVersion === null ||
    parsed.data.snapshotPayload === null
  ) {
    return corruption()
  }
  const decoded = currentSnapshotReader.read(
    parsed.data.snapshotPayloadVersion,
    parsed.data.snapshotPayload,
  )
  if (decoded.kind !== 'decoded') return corruption()
  return Object.freeze({
    state: decoded.value,
    session: sessionView(parsed.data),
    eventSeq: parsed.data.nextEventSeq - 1,
    newPrivateEvents: Object.freeze([]),
    roster: mapRoster(parsed.data.roster),
    committedCurrentHandEvents: mapEvents(parsed.data.currentHandEvents),
  })
}

const READONLY_DIAGNOSTIC_FACTS = Object.freeze({
  kind: 'readonlyDiagnostic' as const,
})

function mapLookup(input: unknown): PublicProjectionFactsLookup {
  const parsed = SessionRowSchema.safeParse(input)
  if (!parsed.success) return corruption()
  const hasDiagnostic =
    parsed.data.diagnosticCode !== null && parsed.data.diagnosedAt !== null
  if (parsed.data.lifecycleStatus === 'readonlyDiagnostic') {
    if (!hasDiagnostic) return corruption()
    return READONLY_DIAGNOSTIC_FACTS
  }
  if (hasDiagnostic) return corruption()
  return mapPublicSessionProjectionFacts(parsed.data)
}

async function readRows(
  sql: Sql | TransactionSql,
  owner: ResolvedOwnerScope,
  filter:
    | { readonly kind: 'active' }
    | { readonly kind: 'id'; readonly sessionId: string },
): Promise<readonly unknown[]> {
  try {
    return await sql`
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
            ON a.participant_id = p.id AND a.session_id = p.session_id AND a.owner_id = p.owner_id
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
        ), '[]'::jsonb) AS "currentHandEvents"
      FROM app_private.sessions s
      LEFT JOIN app_private.session_snapshots ss
        ON ss.session_id = s.id AND ss.owner_id = s.owner_id
      WHERE s.owner_id = ${owner.databaseOwnerId}::uuid
        AND (${filter.kind === 'active' ? true : false}::boolean = false
          OR s.lifecycle_status = 'active')
        AND (${filter.kind === 'id' ? filter.sessionId : null}::uuid IS NULL
          OR s.id = ${filter.kind === 'id' ? filter.sessionId : null}::uuid)
      LIMIT 2
    `
  } catch {
    throw new DatabaseOperationError()
  }
}

export function createPublicProjectionFactsRepository(input: {
  readonly sql: Sql
  readonly owner: ResolvedOwnerScope
}): PublicProjectionFactsRepository {
  return Object.freeze({
    async findActive() {
      const rows = await readRows(input.sql, input.owner, { kind: 'active' })
      if (rows.length === 0) return null
      if (rows.length !== 1) return corruption()
      return mapLookup(rows[0])
    },
    async getById(sessionId: string) {
      if (!z.uuid().safeParse(sessionId).success)
        throw new RepositoryInputValidationError()
      const rows = await readRows(input.sql, input.owner, {
        kind: 'id',
        sessionId,
      })
      if (rows.length === 0) return null
      if (rows.length !== 1) return corruption()
      return mapLookup(rows[0])
    },
  })
}

export function createTransactionPublicProjectionReadPort(
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
): ActivePublicProjectionReadPort {
  const port: ActivePublicProjectionReadPort = {
    async readRoster(sessionId: string) {
      let rows: readonly unknown[]
      try {
        rows = await transaction`
          SELECT p.seat_number AS "seatNumber", p.id::text AS "playerId",
            p.participant_type AS "participantType", a.display_name AS "displayName",
            a.avatar_color AS "avatarColor"
          FROM app_private.session_participants p
          LEFT JOIN app_private.session_agents a
            ON a.participant_id = p.id AND a.session_id = p.session_id AND a.owner_id = p.owner_id
          WHERE p.session_id = ${sessionId}::uuid AND p.owner_id = ${owner.databaseOwnerId}::uuid
          ORDER BY p.seat_number
        `
      } catch {
        throw new DatabaseOperationError()
      }
      return mapRoster(rows)
    },
    async readCurrentHandEvents(input: {
      readonly sessionId: string
      readonly handId: string
      readonly beforeEventSeq: number
    }) {
      const { sessionId, handId, beforeEventSeq } = input
      let rows: readonly unknown[]
      try {
        rows = await transaction`
          SELECT event_seq::float8 AS "eventSeq", hand_id::text AS "handId",
            private_event_payload_version AS "privateEventPayloadVersion",
            private_event_payload AS "privateEventPayload"
          FROM app_private.session_events
          WHERE session_id = ${sessionId}::uuid AND owner_id = ${owner.databaseOwnerId}::uuid
            AND hand_id = ${handId}::uuid AND event_seq < ${beforeEventSeq}::bigint
          ORDER BY event_seq
        `
      } catch {
        throw new DatabaseOperationError()
      }
      return mapEvents(rows)
    },
    async readFacts(sessionId: string) {
      if (!z.uuid().safeParse(sessionId).success) {
        throw new RepositoryInputValidationError()
      }
      const rows = await readRows(transaction, owner, { kind: 'id', sessionId })
      if (rows.length === 0) return null
      if (rows.length !== 1) return corruption()
      return mapPublicSessionProjectionFacts(rows[0])
    },
  }
  return Object.freeze(port)
}
