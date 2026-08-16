import type { Sql, TransactionSql } from 'postgres'
import { z } from 'zod'
import { SESSION_DIAGNOSTIC_CODES } from '../sessions/authoritative-state/recovery-decision.js'
import {
  assertRosterSnapshotsUseActiveModels,
  isPreparedCurrentCatalogRoster,
} from '../sessions/roster-preparation.js'
import {
  ActiveModelConfigurationSchema,
  AgentMemoryPayloadSchema,
  canonicalJson,
  createConfigSnapshotKey,
  MEMORY_PAYLOAD_VERSION,
  PERSONA_CONFIG_PAYLOAD_VERSION,
  PersonaConfigPayloadSchema,
} from '../personas/config.js'
import {
  ActiveSessionConflictError,
  DatabaseOperationError,
  OwnerScopeResolutionError,
  RepositoryInputValidationError,
  RosterSourceChangedError,
  SessionCreationTransitionError,
  UnknownPayloadVersionError,
} from './errors.js'
import { isResolvedOwnerScope, type ResolvedOwnerScope } from './owner-scope.js'
import { readSessionAgentSnapshots } from './session-repository.js'
import type { LockedSessionView } from './session-mutation-repository.js'
import {
  INITIAL_AGENT_MEMORY,
  type LatestEndedRosterPreflight,
  type PreparedCurrentCatalogRoster,
  type SessionRosterAgentInput,
  type StableIdentityGraph,
} from '../sessions/roster-preparation.js'

const POSTGRES_TEXT_OID = 25

const LockedOwnerRowSchema = z.strictObject({
  databaseOwnerId: z.uuid().transform((value) => value.toLowerCase()),
})
const ActiveSessionIdRowSchema = z.strictObject({
  sessionId: z.uuid().transform((value) => value.toLowerCase()),
})
const LockedSessionRowSchema = z.strictObject({
  sessionId: z.uuid().transform((value) => value.toLowerCase()),
  lifecycleStatus: z.enum(['active', 'ended', 'readonlyDiagnostic']),
  endedAt: z.string().nullable(),
  stateVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  nextEventSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  currentHandId: z.uuid().nullable(),
  diagnosticCode: z.enum(SESSION_DIAGNOSTIC_CODES).nullable(),
  diagnosedAt: z.string().nullable(),
  agentRunState: z.enum(['idle', 'thinking', 'paused']),
  activePlayerRunId: z.uuid().nullable(),
  activeDecisionRequestId: z.uuid().nullable(),
})
const LatestEndedPreflightSchema = z.strictObject({
  sourceSessionId: z.uuid().transform((value) => value.toLowerCase()),
  aiSeatNumbers: z.array(z.number().int().min(1).max(8)).min(5).max(8),
})
const StableIdentityGraphSchema = z.strictObject({
  sessionId: z.uuid().transform((value) => value.toLowerCase()),
  userParticipantId: z.uuid().transform((value) => value.toLowerCase()),
  agentParticipants: z
    .array(
      z.strictObject({
        seatNumber: z.number().int().min(1).max(8),
        agentParticipantId: z.uuid().transform((value) => value.toLowerCase()),
      }),
    )
    .min(5)
    .max(8),
})
const LockedEndedSessionRowSchema = z.strictObject({
  sessionId: z.uuid().transform((value) => value.toLowerCase()),
  lifecycleStatus: z.enum(['active', 'ended', 'readonlyDiagnostic']),
})

declare const lockedOwnerForSessionCreationBrand: unique symbol
declare const lockedRosterForSessionCreationBrand: unique symbol
declare const lockedActiveSessionForCreationBrand: unique symbol

export interface LockedOwnerForSessionCreation {
  readonly owner: ResolvedOwnerScope
  readonly [lockedOwnerForSessionCreationBrand]: never
}

export interface LockedSessionRosterForCreation {
  readonly owner: ResolvedOwnerScope
  readonly sessionId: string
  readonly userParticipantId: string
  readonly agentParticipants: readonly {
    readonly seatNumber: number
    readonly participantId: string
  }[]
  readonly [lockedRosterForSessionCreationBrand]: never
}

export interface LockedActiveSessionForCreation {
  readonly session: LockedSessionView
  readonly [lockedActiveSessionForCreationBrand]: never
}

export type ActiveSessionCreationCheck =
  | { readonly kind: 'noActiveSession' }
  | {
      readonly kind: 'activeSession'
      readonly reference: LockedActiveSessionForCreation
    }

export interface InsertedSessionSeed {
  readonly owner: ResolvedOwnerScope
  readonly sessionId: string
  readonly userParticipantId: string
  readonly agentParticipants: readonly {
    readonly seatNumber: number
    readonly participantId: string
  }[]
}

interface InsertSessionRosterSnapshotInput {
  readonly owner: ResolvedOwnerScope
  readonly sessionId: string
  readonly userParticipantId: string
  readonly agents: readonly SessionRosterAgentInput[]
}

function validateInitialMemory(
  memory: SessionRosterAgentInput['initialMemory'],
): void {
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
    ids.some((id) => !z.string().uuid().safeParse(id).success) ||
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
      agent.avatarColor !== payload.data.avatarColor ||
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

async function insertSessionRosterSnapshot(
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

export interface SessionCreationRepository {
  lockOwnerForSessionCreation(
    transaction: TransactionSql,
    owner: ResolvedOwnerScope,
  ): Promise<LockedOwnerForSessionCreation>
  checkActiveSessionForCreation(
    transaction: TransactionSql,
    owner: LockedOwnerForSessionCreation,
  ): Promise<ActiveSessionCreationCheck>
  acceptCurrentCatalogRosterForCreation(
    transaction: TransactionSql,
    owner: LockedOwnerForSessionCreation,
    prepared: PreparedCurrentCatalogRoster,
  ): Promise<LockedSessionRosterForCreation>
  lockLatestEndedRosterForCreation(
    transaction: TransactionSql,
    owner: LockedOwnerForSessionCreation,
    preflight: LatestEndedRosterPreflight,
    identityGraph: StableIdentityGraph,
  ): Promise<LockedSessionRosterForCreation>
  insertLockedSessionRoster(
    transaction: TransactionSql,
    roster: LockedSessionRosterForCreation,
  ): Promise<InsertedSessionSeed>
}

export function createSessionCreationRepository(): SessionCreationRepository {
  const repositoryIdentity = Object.freeze({})
  type OwnerPhase =
    | 'ownerLocked'
    | 'activeCheckedNoConflict'
    | 'rosterIssued'
    | 'rosterFailed'
    | 'activeConflict'
  interface OwnerMetadata {
    readonly transaction: TransactionSql
    readonly owner: ResolvedOwnerScope
    readonly repositoryIdentity: object
    phase: OwnerPhase
  }
  interface RosterMetadata {
    readonly transaction: TransactionSql
    readonly repositoryIdentity: object
    readonly input: InsertSessionRosterSnapshotInput
    consumed: boolean
  }
  const ownerMetadata = new WeakMap<
    LockedOwnerForSessionCreation,
    OwnerMetadata
  >()
  const rosterMetadata = new WeakMap<
    LockedSessionRosterForCreation,
    RosterMetadata
  >()

  const executeRows = async (
    operation: () => PromiseLike<readonly unknown[]>,
  ): Promise<readonly unknown[]> => {
    try {
      return await operation()
    } catch {
      throw new DatabaseOperationError()
    }
  }

  const getOwnerMetadata = (
    transaction: TransactionSql,
    lockedOwner: LockedOwnerForSessionCreation,
    expectedPhase: OwnerPhase,
  ): OwnerMetadata => {
    const metadata =
      typeof lockedOwner === 'object' && lockedOwner !== null
        ? ownerMetadata.get(lockedOwner)
        : undefined
    if (metadata === undefined) {
      throw new RepositoryInputValidationError()
    }
    if (
      metadata.repositoryIdentity !== repositoryIdentity ||
      metadata.transaction !== transaction ||
      metadata.phase !== expectedPhase
    ) {
      throw new SessionCreationTransitionError()
    }
    return metadata
  }

  const lockOwnerForSessionCreation = async (
    transaction: TransactionSql,
    owner: ResolvedOwnerScope,
  ): Promise<LockedOwnerForSessionCreation> => {
    if (typeof transaction !== 'function' || !isResolvedOwnerScope(owner)) {
      throw new RepositoryInputValidationError()
    }
    const rows = await executeRows(
      () => transaction`
      SELECT id::text AS "databaseOwnerId"
      FROM app_private.owners
      WHERE id = ${owner.databaseOwnerId}::uuid
      FOR UPDATE
    `,
    )
    const parsed = z.array(LockedOwnerRowSchema).safeParse(rows)
    if (
      !parsed.success ||
      parsed.data.length !== 1 ||
      parsed.data[0]?.databaseOwnerId !== owner.databaseOwnerId
    ) {
      throw new OwnerScopeResolutionError()
    }
    const locked = Object.freeze({ owner }) as LockedOwnerForSessionCreation
    ownerMetadata.set(locked, {
      transaction,
      owner,
      repositoryIdentity,
      phase: 'ownerLocked',
    })
    return locked
  }

  const checkActiveSessionForCreation = async (
    transaction: TransactionSql,
    lockedOwner: LockedOwnerForSessionCreation,
  ): Promise<ActiveSessionCreationCheck> => {
    const metadata = getOwnerMetadata(transaction, lockedOwner, 'ownerLocked')
    while (true) {
      const idRows = await executeRows(
        () => transaction`
        SELECT id::text AS "sessionId"
        FROM app_private.sessions
        WHERE owner_id = ${metadata.owner.databaseOwnerId}::uuid
          AND lifecycle_status = 'active'
        ORDER BY id ASC
        LIMIT 2
      `,
      )
      const parsedIds = z.array(ActiveSessionIdRowSchema).safeParse(idRows)
      if (!parsedIds.success || parsedIds.data.length > 1) {
        throw new DatabaseOperationError()
      }
      const activeId = parsedIds.data[0]?.sessionId
      if (activeId === undefined) {
        metadata.phase = 'activeCheckedNoConflict'
        return Object.freeze({ kind: 'noActiveSession' })
      }

      const sessionRows = await executeRows(
        () => transaction`
        SELECT
          id::text AS "sessionId",
          lifecycle_status AS "lifecycleStatus",
          CASE WHEN ended_at IS NULL THEN NULL ELSE
            to_char(ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
          END AS "endedAt",
          state_version::float8 AS "stateVersion",
          next_event_seq::float8 AS "nextEventSeq",
          current_hand_id::text AS "currentHandId",
          diagnostic_code AS "diagnosticCode",
          CASE WHEN diagnosed_at IS NULL THEN NULL ELSE
            to_char(diagnosed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
          END AS "diagnosedAt",
          agent_run_state AS "agentRunState",
          active_player_run_id::text AS "activePlayerRunId",
          active_decision_request_id::text AS "activeDecisionRequestId"
        FROM app_private.sessions
        WHERE id = ${activeId}::uuid
          AND owner_id = ${metadata.owner.databaseOwnerId}::uuid
        FOR UPDATE
      `,
      )
      if (sessionRows.length === 0) {
        continue
      }
      const parsedSession = LockedSessionRowSchema.safeParse(sessionRows[0])
      if (sessionRows.length !== 1 || !parsedSession.success) {
        throw new DatabaseOperationError()
      }
      if (parsedSession.data.lifecycleStatus !== 'active') {
        continue
      }
      const hasBothPlayerPointers =
        parsedSession.data.activePlayerRunId !== null &&
        parsedSession.data.activeDecisionRequestId !== null
      const hasNeitherPlayerPointer =
        parsedSession.data.activePlayerRunId === null &&
        parsedSession.data.activeDecisionRequestId === null
      if (
        parsedSession.data.endedAt !== null ||
        parsedSession.data.diagnosticCode !== null ||
        parsedSession.data.diagnosedAt !== null ||
        (parsedSession.data.agentRunState === 'thinking'
          ? !hasBothPlayerPointers
          : !hasNeitherPlayerPointer)
      ) {
        throw new DatabaseOperationError()
      }
      metadata.phase = 'activeConflict'
      const reference = Object.freeze({
        session: Object.freeze(parsedSession.data) as LockedSessionView,
      }) as LockedActiveSessionForCreation
      return Object.freeze({ kind: 'activeSession', reference })
    }
  }

  const acceptCurrentCatalogRosterForCreation = async (
    transaction: TransactionSql,
    lockedOwner: LockedOwnerForSessionCreation,
    prepared: PreparedCurrentCatalogRoster,
  ): Promise<LockedSessionRosterForCreation> => {
    const metadata = getOwnerMetadata(
      transaction,
      lockedOwner,
      'activeCheckedNoConflict',
    )
    if (!isPreparedCurrentCatalogRoster(prepared)) {
      throw new RepositoryInputValidationError()
    }
    const ownerRows = await executeRows(
      () => transaction`
      SELECT id::text AS "databaseOwnerId"
      FROM app_private.owners
      WHERE id = ${metadata.owner.databaseOwnerId}::uuid
    `,
    )
    const parsedOwner = z.array(LockedOwnerRowSchema).safeParse(ownerRows)
    if (
      !parsedOwner.success ||
      parsedOwner.data.length !== 1 ||
      parsedOwner.data[0]?.databaseOwnerId !== metadata.owner.databaseOwnerId
    ) {
      throw new OwnerScopeResolutionError()
    }
    const input: InsertSessionRosterSnapshotInput = Object.freeze({
      owner: metadata.owner,
      sessionId: prepared.sessionId,
      userParticipantId: prepared.userParticipantId,
      agents: prepared.agents,
    })
    const lockedRoster = Object.freeze({
      owner: metadata.owner,
      sessionId: prepared.sessionId,
      userParticipantId: prepared.userParticipantId,
      agentParticipants: Object.freeze(
        prepared.agents.map((agent) =>
          Object.freeze({
            seatNumber: agent.seatNumber,
            participantId: agent.agentParticipantId,
          }),
        ),
      ),
    }) as LockedSessionRosterForCreation
    metadata.phase = 'rosterIssued'
    rosterMetadata.set(lockedRoster, {
      transaction,
      repositoryIdentity,
      input,
      consumed: false,
    })
    return lockedRoster
  }

  const lockLatestEndedRosterForCreation = async (
    transaction: TransactionSql,
    lockedOwner: LockedOwnerForSessionCreation,
    preflight: LatestEndedRosterPreflight,
    identityGraph: StableIdentityGraph,
  ): Promise<LockedSessionRosterForCreation> => {
    const metadata = getOwnerMetadata(
      transaction,
      lockedOwner,
      'activeCheckedNoConflict',
    )
    const parsedPreflight = LatestEndedPreflightSchema.safeParse(preflight)
    const parsedIdentity = StableIdentityGraphSchema.safeParse(identityGraph)
    if (!parsedPreflight.success || !parsedIdentity.success) {
      throw new RepositoryInputValidationError()
    }
    const normalizedPreflightSeats = [
      ...parsedPreflight.data.aiSeatNumbers,
    ].sort((left, right) => left - right)
    const normalizedParticipants = [
      ...parsedIdentity.data.agentParticipants,
    ].sort((left, right) => left.seatNumber - right.seatNumber)
    const identifiers = [
      parsedIdentity.data.sessionId,
      parsedIdentity.data.userParticipantId,
      ...normalizedParticipants.map(
        (participant) => participant.agentParticipantId,
      ),
    ]
    if (
      new Set(normalizedPreflightSeats).size !==
        normalizedPreflightSeats.length ||
      new Set(normalizedParticipants.map((value) => value.seatNumber)).size !==
        normalizedParticipants.length ||
      new Set(identifiers).size !== identifiers.length ||
      normalizedPreflightSeats.length !== normalizedParticipants.length ||
      normalizedPreflightSeats.some(
        (seatNumber, index) =>
          seatNumber !== normalizedParticipants[index]?.seatNumber,
      )
    ) {
      throw new RepositoryInputValidationError()
    }

    try {
      const readLatestEndedId = async (): Promise<string | null> => {
        const rows = await executeRows(
          () => transaction`
          SELECT id::text AS "sessionId"
          FROM app_private.sessions
          WHERE owner_id = ${metadata.owner.databaseOwnerId}::uuid
            AND lifecycle_status = 'ended'
          ORDER BY ended_at DESC, id DESC
          LIMIT 1
        `,
        )
        const parsed = z.array(ActiveSessionIdRowSchema).safeParse(rows)
        if (!parsed.success || parsed.data.length > 1) {
          throw new DatabaseOperationError()
        }
        return parsed.data[0]?.sessionId ?? null
      }

      if (
        (await readLatestEndedId()) !== parsedPreflight.data.sourceSessionId
      ) {
        throw new RosterSourceChangedError()
      }
      const sourceRows = await executeRows(
        () => transaction`
        SELECT
          id::text AS "sessionId",
          lifecycle_status AS "lifecycleStatus"
        FROM app_private.sessions
        WHERE id = ${parsedPreflight.data.sourceSessionId}::uuid
          AND owner_id = ${metadata.owner.databaseOwnerId}::uuid
        FOR UPDATE
      `,
      )
      const parsedSource = z
        .array(LockedEndedSessionRowSchema)
        .safeParse(sourceRows)
      if (
        !parsedSource.success ||
        parsedSource.data.length !== 1 ||
        parsedSource.data[0]?.sessionId !==
          parsedPreflight.data.sourceSessionId ||
        parsedSource.data[0]?.lifecycleStatus !== 'ended' ||
        (await readLatestEndedId()) !== parsedPreflight.data.sourceSessionId
      ) {
        throw new RosterSourceChangedError()
      }
      const snapshots = await readSessionAgentSnapshots(
        transaction as unknown as Sql,
        metadata.owner,
        parsedPreflight.data.sourceSessionId,
      )
      assertRosterSnapshotsUseActiveModels(
        snapshots,
        ActiveModelConfigurationSchema,
      )
      if (
        snapshots.length !== normalizedParticipants.length ||
        snapshots.some(
          (snapshot, index) =>
            snapshot.seatNumber !== normalizedPreflightSeats[index],
        )
      ) {
        throw new RosterSourceChangedError()
      }
      const agents = snapshots.map((snapshot, index) => ({
        seatNumber: snapshot.seatNumber,
        agentParticipantId:
          normalizedParticipants[index]?.agentParticipantId ?? '',
        displayName: snapshot.displayName,
        avatarColor: snapshot.avatarColor,
        personaId: snapshot.personaId,
        personaVersion: snapshot.personaVersion,
        configSnapshotKey: snapshot.configSnapshotKey,
        configPayloadVersion: snapshot.configPayloadVersion,
        configPayload: snapshot.configPayload,
        initialMemory: INITIAL_AGENT_MEMORY,
      }))
      const input: InsertSessionRosterSnapshotInput = Object.freeze({
        owner: metadata.owner,
        sessionId: parsedIdentity.data.sessionId,
        userParticipantId: parsedIdentity.data.userParticipantId,
        agents: Object.freeze(agents),
      })
      const lockedRoster = Object.freeze({
        owner: metadata.owner,
        sessionId: input.sessionId,
        userParticipantId: input.userParticipantId,
        agentParticipants: Object.freeze(
          normalizedParticipants.map((participant) =>
            Object.freeze({
              seatNumber: participant.seatNumber,
              participantId: participant.agentParticipantId,
            }),
          ),
        ),
      }) as LockedSessionRosterForCreation
      metadata.phase = 'rosterIssued'
      rosterMetadata.set(lockedRoster, {
        transaction,
        repositoryIdentity,
        input,
        consumed: false,
      })
      return lockedRoster
    } catch (error) {
      metadata.phase = 'rosterFailed'
      throw error
    }
  }

  const insertLockedSessionRoster = async (
    transaction: TransactionSql,
    roster: LockedSessionRosterForCreation,
  ): Promise<InsertedSessionSeed> => {
    const metadata =
      typeof roster === 'object' && roster !== null
        ? rosterMetadata.get(roster)
        : undefined
    if (metadata === undefined) {
      throw new RepositoryInputValidationError()
    }
    if (
      metadata.repositoryIdentity !== repositoryIdentity ||
      metadata.transaction !== transaction ||
      metadata.consumed
    ) {
      throw new SessionCreationTransitionError()
    }
    metadata.consumed = true
    await insertSessionRosterSnapshot(transaction, metadata.input)
    return Object.freeze({
      owner: metadata.input.owner,
      sessionId: metadata.input.sessionId,
      userParticipantId: metadata.input.userParticipantId,
      agentParticipants: roster.agentParticipants,
    })
  }

  return Object.freeze({
    lockOwnerForSessionCreation,
    checkActiveSessionForCreation,
    acceptCurrentCatalogRosterForCreation,
    lockLatestEndedRosterForCreation,
    insertLockedSessionRoster,
  })
}
