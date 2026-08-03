import type { Sql, TransactionSql } from 'postgres'
import { z } from 'zod'
import {
  AgentMemoryPayloadV1Schema,
  canonicalJson,
  createConfigSnapshotKey,
  deepFreeze,
  MEMORY_PAYLOAD_VERSION,
  PERSONA_CONFIG_PAYLOAD_VERSION,
  PersonaConfigPayloadV1Schema,
} from '../personas/config.js'
import type {
  AgentMemoryPayloadV1,
  DeepReadonly,
  PersonaConfigPayloadV1,
} from '../personas/config.js'
import {
  ActiveSessionConflictError,
  DatabaseOperationError,
  PersistenceDataCorruptionError,
  RepositoryInputValidationError,
  ResourceNotFoundError,
  UnknownPayloadVersionError,
} from './errors.js'
import {
  isResolvedOwnerScope,
  resolveOwnerScope,
  type OwnerScope,
  type ResolvedOwnerScope,
} from './owner-scope.js'

const UuidSchema = z.string().uuid()
const POSTGRES_TEXT_OID = 25
const SessionLifecycleStatusSchema = z.enum([
  'active',
  'ended',
  'readonlyDiagnostic',
])

const microsecondTimestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/

function isValidMicrosecondTimestamp(value: string): boolean {
  const match = microsecondTimestampPattern.exec(value)
  if (match === null) {
    return false
  }

  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number)
  if (
    year === undefined ||
    year < 1 ||
    month === undefined ||
    month < 1 ||
    month > 12 ||
    day === undefined ||
    day < 1 ||
    hour === undefined ||
    hour > 23 ||
    minute === undefined ||
    minute > 59 ||
    second === undefined ||
    second > 59
  ) {
    return false
  }

  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return day <= daysInMonth
}

export const HistoricalSessionCursorSchema = z.strictObject({
  updatedAt: z.string().refine(isValidMicrosecondTimestamp),
  id: UuidSchema,
})

export type HistoricalSessionCursor = Readonly<
  z.infer<typeof HistoricalSessionCursorSchema>
>

export const HistoricalSessionPageRequestSchema = z.strictObject({
  limit: z.number().int().min(1).max(100),
  cursor: HistoricalSessionCursorSchema.optional(),
})

export type HistoricalSessionPageRequest = z.infer<
  typeof HistoricalSessionPageRequestSchema
>

export interface SessionRecord {
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

export interface HistoricalSessionPage {
  readonly sessions: readonly SessionRecord[]
  readonly nextCursor: HistoricalSessionCursor | null
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
  createdAt: z.string().refine(isValidMicrosecondTimestamp),
  endedAt: z.string().refine(isValidMicrosecondTimestamp).nullable(),
  updatedAt: z.string().refine(isValidMicrosecondTimestamp),
})

type OwnerScopeInput = OwnerScope | ResolvedOwnerScope

async function getResolvedOwner(
  sql: Sql,
  ownerScope: OwnerScopeInput,
): Promise<ResolvedOwnerScope> {
  return isResolvedOwnerScope(ownerScope)
    ? ownerScope
    : resolveOwnerScope(sql, ownerScope)
}

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

export async function findActiveSession(
  sql: Sql,
  ownerScope: OwnerScopeInput,
): Promise<SessionRecord | null> {
  const owner = await getResolvedOwner(sql, ownerScope)
  const projection = createSessionRecordProjection(sql)
  const rows = await querySessionRecords(sql`
    SELECT ${projection}
    FROM app_private.sessions
    WHERE owner_id = ${owner.databaseOwnerId}::uuid
      AND lifecycle_status = 'active'
    LIMIT 2
  `)

  if (rows.length > 1) {
    throw new PersistenceDataCorruptionError('invalidRoster')
  }
  return rows[0] ?? null
}

export async function getSessionById(
  sql: Sql,
  ownerScope: OwnerScopeInput,
  sessionId: string,
): Promise<SessionRecord | null> {
  const parsedSessionId = UuidSchema.safeParse(sessionId)
  if (!parsedSessionId.success) {
    throw new RepositoryInputValidationError()
  }
  const owner = await getResolvedOwner(sql, ownerScope)
  const projection = createSessionRecordProjection(sql)
  const rows = await querySessionRecords(sql`
    SELECT ${projection}
    FROM app_private.sessions
    WHERE owner_id = ${owner.databaseOwnerId}::uuid
      AND id = ${parsedSessionId.data}::uuid
    LIMIT 1
  `)

  return rows[0] ?? null
}

export async function findLatestEndedSessionForRosterReuse(
  sql: Sql,
  ownerScope: OwnerScopeInput,
): Promise<SessionRecord | null> {
  const owner = await getResolvedOwner(sql, ownerScope)
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

export async function listHistoricalSessions(
  sql: Sql,
  ownerScope: OwnerScopeInput,
  request: HistoricalSessionPageRequest,
): Promise<HistoricalSessionPage> {
  const parsedRequest = HistoricalSessionPageRequestSchema.safeParse(request)
  if (!parsedRequest.success) {
    throw new RepositoryInputValidationError()
  }
  const owner = await getResolvedOwner(sql, ownerScope)
  const rowLimit = parsedRequest.data.limit + 1
  const cursor = parsedRequest.data.cursor
  const projection = createSessionRecordProjection(sql)
  const query =
    cursor === undefined
      ? sql`
          SELECT ${projection}
          FROM app_private.sessions
          WHERE owner_id = ${owner.databaseOwnerId}::uuid
            AND lifecycle_status IN ('ended', 'readonlyDiagnostic')
          ORDER BY updated_at DESC, id DESC
          LIMIT ${rowLimit}
        `
      : sql`
          SELECT ${projection}
          FROM app_private.sessions
          WHERE owner_id = ${owner.databaseOwnerId}::uuid
            AND lifecycle_status IN ('ended', 'readonlyDiagnostic')
            AND (
              updated_at < ${cursor.updatedAt}::timestamptz
              OR (updated_at = ${cursor.updatedAt}::timestamptz AND id < ${cursor.id}::uuid)
            )
          ORDER BY updated_at DESC, id DESC
          LIMIT ${rowLimit}
        `
  const records = await querySessionRecords(query)
  const pageRecords = records.slice(0, parsedRequest.data.limit)
  const lastRecord = pageRecords.at(-1)
  const nextCursor =
    records.length > parsedRequest.data.limit && lastRecord !== undefined
      ? deepFreeze({ updatedAt: lastRecord.updatedAt, id: lastRecord.id })
      : null

  return deepFreeze({ sessions: pageRecords, nextCursor })
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
  readonly configPayload: DeepReadonly<PersonaConfigPayloadV1>
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
  const payloadResult = PersonaConfigPayloadV1Schema.safeParse(
    row.configPayload,
  )
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
      personaVersion: z.number().int().positive(),
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
  sql: Sql,
  ownerScope: OwnerScopeInput,
  sessionId: string,
): Promise<readonly SessionAgentSnapshot[]> {
  const parsedSessionId = UuidSchema.safeParse(sessionId)
  if (!parsedSessionId.success) {
    throw new RepositoryInputValidationError()
  }
  const owner = await getResolvedOwner(sql, ownerScope)
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

export interface InitialAgentMemoryInput {
  readonly currentRevision: number
  readonly currentPayloadVersion: number
  readonly currentPayload: AgentMemoryPayloadV1
  readonly revision: number
  readonly revisionPayloadVersion: number
  readonly revisionPayload: AgentMemoryPayloadV1
}

export interface SessionRosterAgentInput {
  readonly seatNumber: number
  readonly agentParticipantId: string
  readonly displayName: string
  readonly avatarColor: string
  readonly personaId: string
  readonly personaVersion: number
  readonly configSnapshotKey: string
  readonly configPayloadVersion: number
  readonly configPayload: PersonaConfigPayloadV1
  readonly initialMemory: InitialAgentMemoryInput
}

export interface InsertSessionRosterSnapshotInput {
  readonly owner: ResolvedOwnerScope
  readonly sessionId: string
  readonly userParticipantId: string
  readonly agents: readonly SessionRosterAgentInput[]
}

export const INITIAL_AGENT_MEMORY: InitialAgentMemoryInput = deepFreeze({
  currentRevision: 0,
  currentPayloadVersion: MEMORY_PAYLOAD_VERSION,
  currentPayload: {},
  revision: 0,
  revisionPayloadVersion: MEMORY_PAYLOAD_VERSION,
  revisionPayload: {},
})

function validateInitialMemory(memory: InitialAgentMemoryInput): void {
  const current = AgentMemoryPayloadV1Schema.safeParse(memory.currentPayload)
  const revision = AgentMemoryPayloadV1Schema.safeParse(memory.revisionPayload)
  if (
    memory.currentRevision !== 0 ||
    memory.revision !== 0 ||
    memory.currentPayloadVersion !== MEMORY_PAYLOAD_VERSION ||
    memory.revisionPayloadVersion !== MEMORY_PAYLOAD_VERSION ||
    !current.success ||
    !revision.success ||
    canonicalJson(current.data) !== canonicalJson(revision.data)
  ) {
    throw new RepositoryInputValidationError()
  }
}

function validateRosterInput(input: InsertSessionRosterSnapshotInput): void {
  if (!isResolvedOwnerScope(input.owner)) {
    throw new RepositoryInputValidationError()
  }

  const ids = [
    input.sessionId,
    input.userParticipantId,
    ...input.agents.map((agent) => agent.agentParticipantId),
  ]
  if (
    input.agents.length < 5 ||
    input.agents.length > 8 ||
    ids.some((id) => !UuidSchema.safeParse(id).success) ||
    new Set(ids).size !== ids.length ||
    new Set(input.agents.map((agent) => agent.seatNumber)).size !==
      input.agents.length ||
    new Set(input.agents.map((agent) => agent.personaId)).size !==
      input.agents.length
  ) {
    throw new RepositoryInputValidationError()
  }

  for (const agent of input.agents) {
    if (
      !Number.isInteger(agent.seatNumber) ||
      agent.seatNumber < 1 ||
      agent.seatNumber > 8
    ) {
      throw new RepositoryInputValidationError()
    }
    if (agent.configPayloadVersion !== PERSONA_CONFIG_PAYLOAD_VERSION) {
      throw new UnknownPayloadVersionError('personaConfig')
    }
    const payload = PersonaConfigPayloadV1Schema.safeParse(agent.configPayload)
    if (!payload.success) {
      throw new RepositoryInputValidationError()
    }
    if (
      agent.personaId !== payload.data.personaId ||
      agent.personaVersion !== payload.data.personaVersion ||
      agent.displayName !== payload.data.name ||
      agent.avatarColor !== payload.data.avatarColor
    ) {
      throw new RepositoryInputValidationError()
    }
    if (
      createConfigSnapshotKey(agent.configPayloadVersion, payload.data) !==
      agent.configSnapshotKey
    ) {
      throw new RepositoryInputValidationError()
    }
    validateInitialMemory(agent.initialMemory)
  }
}

function getPostgresConstraint(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'constraint_name' in error &&
    typeof error.constraint_name === 'string'
  ) {
    return error.constraint_name
  }
  return undefined
}

export async function insertSessionRosterSnapshot(
  transaction: TransactionSql,
  input: InsertSessionRosterSnapshotInput,
): Promise<void> {
  validateRosterInput(input)

  const ownerId = input.owner.databaseOwnerId
  const participantRows = [
    {
      id: input.userParticipantId,
      session_id: input.sessionId,
      owner_id: ownerId,
      participant_type: 'user',
      seat_number: 0,
    },
    ...input.agents.map((agent) => ({
      id: agent.agentParticipantId,
      session_id: input.sessionId,
      owner_id: ownerId,
      participant_type: 'agent',
      seat_number: agent.seatNumber,
    })),
  ]
  const agentRows = input.agents.map((agent) => ({
    participant_id: agent.agentParticipantId,
    session_id: input.sessionId,
    owner_id: ownerId,
    display_name: agent.displayName,
    avatar_color: agent.avatarColor,
    persona_id: agent.personaId,
    persona_version: agent.personaVersion,
    config_snapshot_key: agent.configSnapshotKey,
    current_memory_revision: agent.initialMemory.currentRevision,
    config_payload_version: agent.configPayloadVersion,
    config_payload: agent.configPayload,
    memory_payload_version: agent.initialMemory.currentPayloadVersion,
    memory_payload: agent.initialMemory.currentPayload,
  }))
  const memoryRows = input.agents.map((agent) => ({
    participant_id: agent.agentParticipantId,
    session_id: input.sessionId,
    owner_id: ownerId,
    revision: agent.initialMemory.revision,
    memory_payload_version: agent.initialMemory.revisionPayloadVersion,
    memory_payload: agent.initialMemory.revisionPayload,
  }))
  const agentRowsJson = transaction.typed(
    JSON.stringify(agentRows),
    POSTGRES_TEXT_OID,
  )
  const memoryRowsJson = transaction.typed(
    JSON.stringify(memoryRows),
    POSTGRES_TEXT_OID,
  )

  try {
    await transaction`
      INSERT INTO app_private.sessions (
        id,
        owner_id,
        lifecycle_status,
        state_version,
        next_event_seq,
        current_hand_id,
        agent_run_state,
        active_player_run_id,
        active_decision_request_id,
        ended_at
      ) VALUES (
        ${input.sessionId}::uuid,
        ${ownerId}::uuid,
        'active',
        0,
        0,
        NULL,
        'idle',
        NULL,
        NULL,
        NULL
      )
    `
    await transaction`
      INSERT INTO app_private.session_participants ${transaction(
        participantRows,
        'id',
        'session_id',
        'owner_id',
        'participant_type',
        'seat_number',
      )}
    `
    await transaction`
      INSERT INTO app_private.session_agents (
        participant_id,
        session_id,
        owner_id,
        display_name,
        avatar_color,
        persona_id,
        persona_version,
        config_snapshot_key,
        current_memory_revision,
        config_payload_version,
        config_payload,
        memory_payload_version,
        memory_payload
      )
      SELECT
        participant_id,
        session_id,
        owner_id,
        display_name,
        avatar_color,
        persona_id,
        persona_version,
        config_snapshot_key,
        current_memory_revision,
        config_payload_version,
        config_payload,
        memory_payload_version,
        memory_payload
      FROM jsonb_populate_recordset(
        NULL::app_private.session_agents,
        ${agentRowsJson}::jsonb
      )
    `
    await transaction`
      INSERT INTO app_private.agent_memory_revisions (
        participant_id,
        session_id,
        owner_id,
        revision,
        memory_payload_version,
        memory_payload
      )
      SELECT
        participant_id,
        session_id,
        owner_id,
        revision,
        memory_payload_version,
        memory_payload
      FROM jsonb_populate_recordset(
        NULL::app_private.agent_memory_revisions,
        ${memoryRowsJson}::jsonb
      )
    `
  } catch (error) {
    if (getPostgresConstraint(error) === 'sessions_one_active_per_owner') {
      throw new ActiveSessionConflictError()
    }
    throw new DatabaseOperationError()
  }
}
