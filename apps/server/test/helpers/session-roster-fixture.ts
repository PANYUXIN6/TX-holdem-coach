import type { PersonaCatalog } from '../../src/personas/catalog.js'
import type { Sql, TransactionSql } from 'postgres'
import { z } from 'zod'
import {
  AgentMemoryPayloadSchema,
  canonicalJson,
  createConfigSnapshotKey,
  deepFreeze,
  MEMORY_PAYLOAD_VERSION,
  PERSONA_CONFIG_PAYLOAD_VERSION,
  PersonaConfigPayloadSchema,
  type AgentMemoryPayload,
  type PersonaConfigPayload,
} from '../../src/personas/config.js'
import {
  ActiveSessionConflictError,
  DatabaseOperationError,
  RepositoryInputValidationError,
  ResourceNotFoundError,
  UnknownPayloadVersionError,
} from '../../src/persistence/errors.js'
import {
  isResolvedOwnerScope,
  resolveOwnerScope,
  type OwnerScope,
  type ResolvedOwnerScope,
} from '../../src/persistence/owner-scope.js'
import {
  findLatestEndedSessionForRosterReuse,
  readSessionAgentSnapshots,
} from '../../src/persistence/session-repository.js'
import {
  assertRosterSnapshotsUseActiveModels,
  prepareCurrentCatalogRoster,
  type CurrentCatalogRosterIdentityGraph,
  type StableIdentityGraph,
} from '../../src/sessions/roster-preparation.js'
import { ActiveModelConfigurationSchema } from '../../src/personas/config.js'

const POSTGRES_TEXT_OID = 25
const UuidSchema = z.string().uuid()

export interface InitialAgentMemoryInput {
  readonly currentRevision: number
  readonly currentPayloadVersion: number
  readonly currentPayload: AgentMemoryPayload
  readonly revision: number
  readonly revisionPayloadVersion: number
  readonly revisionPayload: AgentMemoryPayload
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
  readonly configPayload: PersonaConfigPayload
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
  const current = AgentMemoryPayloadSchema.safeParse(memory.currentPayload)
  const revision = AgentMemoryPayloadSchema.safeParse(memory.revisionPayload)
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
    const payload = PersonaConfigPayloadSchema.safeParse(agent.configPayload)
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

export async function prepareCurrentCatalogRosterSnapshot(
  sql: Sql,
  ownerScope: OwnerScope,
  catalog: PersonaCatalog,
  identityGraph: CurrentCatalogRosterIdentityGraph,
): Promise<InsertSessionRosterSnapshotInput> {
  const owner = await resolveOwnerScope(sql, ownerScope)
  const prepared = prepareCurrentCatalogRoster(catalog, identityGraph)
  return deepFreeze({
    owner,
    sessionId: prepared.sessionId,
    userParticipantId: prepared.userParticipantId,
    agents: prepared.agents,
  })
}

export async function prepareLatestEndedRosterSnapshotForReuse(
  sql: Sql,
  ownerScope: OwnerScope,
  identityGraph: StableIdentityGraph,
): Promise<InsertSessionRosterSnapshotInput> {
  const owner = await resolveOwnerScope(sql, ownerScope)
  const result = z
    .strictObject({
      sessionId: z.string().uuid(),
      userParticipantId: z.string().uuid(),
      agentParticipants: z
        .array(
          z.strictObject({
            seatNumber: z.number().int().min(1).max(8),
            agentParticipantId: z.string().uuid(),
          }),
        )
        .min(5)
        .max(8),
    })
    .safeParse(identityGraph)
  if (!result.success) throw new RepositoryInputValidationError()
  const identifiers = [
    result.data.sessionId,
    result.data.userParticipantId,
    ...result.data.agentParticipants.map(
      (participant) => participant.agentParticipantId,
    ),
  ]
  const seats = result.data.agentParticipants.map(
    (participant) => participant.seatNumber,
  )
  if (
    new Set(identifiers).size !== identifiers.length ||
    new Set(seats).size !== seats.length
  ) {
    throw new RepositoryInputValidationError()
  }
  const latestEndedSession = await findLatestEndedSessionForRosterReuse(
    sql,
    owner,
  )
  if (latestEndedSession === null) throw new ResourceNotFoundError()
  const snapshots = await readSessionAgentSnapshots(
    sql,
    owner,
    latestEndedSession.id,
  )
  if (snapshots.length !== result.data.agentParticipants.length) {
    throw new RepositoryInputValidationError()
  }
  assertRosterSnapshotsUseActiveModels(
    snapshots,
    ActiveModelConfigurationSchema,
  )
  const participantsBySeat = new Map(
    result.data.agentParticipants.map((participant) => [
      participant.seatNumber,
      participant.agentParticipantId,
    ]),
  )
  return deepFreeze({
    owner,
    sessionId: result.data.sessionId,
    userParticipantId: result.data.userParticipantId,
    agents: snapshots.map((snapshot) => {
      const agentParticipantId = participantsBySeat.get(snapshot.seatNumber)
      if (agentParticipantId === undefined) {
        throw new RepositoryInputValidationError()
      }
      return deepFreeze({
        seatNumber: snapshot.seatNumber,
        agentParticipantId,
        displayName: snapshot.displayName,
        avatarColor: snapshot.avatarColor,
        personaId: snapshot.personaId,
        personaVersion: snapshot.personaVersion,
        configSnapshotKey: snapshot.configSnapshotKey,
        configPayloadVersion: snapshot.configPayloadVersion,
        configPayload: snapshot.configPayload,
        initialMemory: INITIAL_AGENT_MEMORY,
      })
    }),
  })
}
