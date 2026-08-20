import type { Sql, TransactionSql } from 'postgres'
import { z } from 'zod'
import {
  createConfigSnapshotKey,
  deepFreeze,
  PERSONA_CONFIG_PAYLOAD_VERSION,
  PersonaConfigPayloadSchema,
} from '../personas/config.js'
import type { DeepReadonly, PersonaConfigPayload } from '../personas/config.js'
import {
  DatabaseOperationError,
  PersistenceDataCorruptionError,
  RepositoryInputValidationError,
  ResourceNotFoundError,
  UnknownPayloadVersionError,
} from './errors.js'
import { isResolvedOwnerScope, type ResolvedOwnerScope } from './owner-scope.js'

const UuidSchema = z.string().uuid()
const SessionLifecycleStatusSchema = z.enum([
  'active',
  'ended',
  'readonlyDiagnostic',
])

const DatabaseTimestampSchema = z.iso.datetime({ precision: 6 })

interface SessionRecord {
  readonly id: string
  readonly lifecycleStatus: 'active' | 'ended' | 'readonlyDiagnostic'
  readonly stateVersion: number
  readonly nextEventSeq: number
  readonly currentHandId: string | null
  readonly agentRunState: 'idle' | 'thinking' | 'paused'
  readonly activePlayerRunId: string | null
  readonly activeDecisionRequestId: string | null
  readonly createdAt: string
  readonly endedAt: string | null
  readonly updatedAt: string
}

const SessionRecordSchema = z.strictObject({
  id: UuidSchema,
  lifecycleStatus: SessionLifecycleStatusSchema,
  stateVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  nextEventSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  currentHandId: UuidSchema.nullable(),
  agentRunState: z.enum(['idle', 'thinking', 'paused']),
  activePlayerRunId: UuidSchema.nullable(),
  activeDecisionRequestId: UuidSchema.nullable(),
  createdAt: DatabaseTimestampSchema,
  endedAt: DatabaseTimestampSchema.nullable(),
  updatedAt: DatabaseTimestampSchema,
})

function parseSessionRecord(row: unknown): SessionRecord {
  const result = SessionRecordSchema.safeParse(row)
  if (!result.success) {
    throw new PersistenceDataCorruptionError('invalidPayload')
  }
  return deepFreeze(result.data)
}

async function querySessionRecords(
  query: Promise<readonly unknown[]>,
): Promise<readonly SessionRecord[]> {
  let rows: readonly unknown[]
  try {
    rows = await query
  } catch {
    throw new DatabaseOperationError()
  }
  return rows.map(parseSessionRecord)
}

function createSessionRecordProjection(sql: Sql) {
  return sql`
    id::text AS "id",
    lifecycle_status AS "lifecycleStatus",
    state_version::float8 AS "stateVersion",
    next_event_seq::float8 AS "nextEventSeq",
    current_hand_id::text AS "currentHandId",
    agent_run_state AS "agentRunState",
    active_player_run_id::text AS "activePlayerRunId",
    active_decision_request_id::text AS "activeDecisionRequestId",
    to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
    CASE WHEN ended_at IS NULL THEN NULL ELSE
      to_char(ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    END AS "endedAt",
    to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt"
  `
}

export async function findLatestEndedSessionForRosterReuse(
  sql: Sql,
  owner: ResolvedOwnerScope,
): Promise<SessionRecord | null> {
  if (!isResolvedOwnerScope(owner)) throw new RepositoryInputValidationError()
  const projection = createSessionRecordProjection(sql)
  const rows = await querySessionRecords(sql`
    SELECT ${projection}
    FROM app_private.sessions
    WHERE owner_id = ${owner.databaseOwnerId}::uuid
      AND lifecycle_status = 'ended'
    ORDER BY ended_at DESC, id DESC
    LIMIT 1
  `)

  return rows[0] ?? null
}

interface SessionAgentSnapshotRow {
  readonly hasAgent: boolean
  readonly participantId: string | null
  readonly seatNumber: number | null
  readonly displayName: string | null
  readonly avatarColor: string | null
  readonly personaId: string | null
  readonly personaVersion: number | null
  readonly configSnapshotKey: string | null
  readonly configPayloadVersion: number | null
  readonly configPayload: unknown
}

export interface SessionAgentSnapshot {
  readonly participantId: string
  readonly seatNumber: number
  readonly displayName: string
  readonly avatarColor: string
  readonly personaId: string
  readonly personaVersion: number
  readonly configSnapshotKey: string
  readonly configPayloadVersion: 1
  readonly configPayload: DeepReadonly<PersonaConfigPayload>
}

function parseSessionAgentSnapshot(
  row: SessionAgentSnapshotRow,
): SessionAgentSnapshot {
  if (!row.hasAgent) {
    throw new PersistenceDataCorruptionError('invalidRoster')
  }
  if (row.configPayloadVersion !== PERSONA_CONFIG_PAYLOAD_VERSION) {
    throw new UnknownPayloadVersionError('personaConfig')
  }
  const payloadResult = PersonaConfigPayloadSchema.safeParse(row.configPayload)
  if (!payloadResult.success) {
    throw new PersistenceDataCorruptionError('invalidPayload')
  }
  const scalarResult = z
    .strictObject({
      participantId: UuidSchema,
      seatNumber: z.number().int().min(1).max(8),
      displayName: z.string().min(1),
      avatarColor: z.string().min(1),
      personaId: z.string().min(1),
      personaVersion: z.literal(1),
      configSnapshotKey: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .safeParse({
      participantId: row.participantId,
      seatNumber: row.seatNumber,
      displayName: row.displayName,
      avatarColor: row.avatarColor,
      personaId: row.personaId,
      personaVersion: row.personaVersion,
      configSnapshotKey: row.configSnapshotKey,
    })
  if (!scalarResult.success) {
    throw new PersistenceDataCorruptionError('invalidRoster')
  }

  const payload = payloadResult.data
  const scalar = scalarResult.data
  if (
    scalar.personaId !== payload.personaId ||
    scalar.personaVersion !== payload.personaVersion ||
    scalar.displayName !== payload.name ||
    scalar.avatarColor !== payload.avatarColor
  ) {
    throw new PersistenceDataCorruptionError('mirrorMismatch')
  }
  if (
    createConfigSnapshotKey(PERSONA_CONFIG_PAYLOAD_VERSION, payload) !==
    scalar.configSnapshotKey
  ) {
    throw new PersistenceDataCorruptionError('snapshotKeyMismatch')
  }

  return deepFreeze({
    ...scalar,
    configPayloadVersion: PERSONA_CONFIG_PAYLOAD_VERSION,
    configPayload: payload,
  })
}

export async function readSessionAgentSnapshots(
  sql: Sql | TransactionSql,
  owner: ResolvedOwnerScope,
  sessionId: string,
): Promise<readonly SessionAgentSnapshot[]> {
  const parsedSessionId = UuidSchema.safeParse(sessionId)
  if (!isResolvedOwnerScope(owner) || !parsedSessionId.success) {
    throw new RepositoryInputValidationError()
  }
  let rows: readonly SessionAgentSnapshotRow[]
  try {
    rows = await sql<SessionAgentSnapshotRow[]>`
      WITH target_session AS (
        SELECT id, owner_id
        FROM app_private.sessions
        WHERE id = ${parsedSessionId.data}::uuid
          AND owner_id = ${owner.databaseOwnerId}::uuid
      )
      SELECT
        (agent.participant_id IS NOT NULL) AS "hasAgent",
        participant.id::text AS "participantId",
        participant.seat_number AS "seatNumber",
        agent.display_name AS "displayName",
        agent.avatar_color AS "avatarColor",
        agent.persona_id AS "personaId",
        agent.persona_version AS "personaVersion",
        agent.config_snapshot_key AS "configSnapshotKey",
        agent.config_payload_version AS "configPayloadVersion",
        agent.config_payload AS "configPayload"
      FROM target_session
      LEFT JOIN app_private.session_participants AS participant
        ON participant.session_id = target_session.id
        AND participant.owner_id = target_session.owner_id
        AND participant.participant_type = 'agent'
      LEFT JOIN app_private.session_agents AS agent
        ON agent.participant_id = participant.id
        AND agent.session_id = participant.session_id
        AND agent.owner_id = participant.owner_id
      ORDER BY participant.seat_number ASC
    `
  } catch {
    throw new DatabaseOperationError()
  }

  if (rows.length === 0) {
    throw new ResourceNotFoundError()
  }
  if (
    rows.length < 5 ||
    rows.length > 8 ||
    rows.some((row) => row.participantId === null)
  ) {
    throw new PersistenceDataCorruptionError('invalidRoster')
  }

  const snapshots = rows.map(parseSessionAgentSnapshot)
  if (
    new Set(snapshots.map((snapshot) => snapshot.seatNumber)).size !==
      snapshots.length ||
    new Set(snapshots.map((snapshot) => snapshot.personaId)).size !==
      snapshots.length
  ) {
    throw new PersistenceDataCorruptionError('invalidRoster')
  }

  return deepFreeze(snapshots)
}
