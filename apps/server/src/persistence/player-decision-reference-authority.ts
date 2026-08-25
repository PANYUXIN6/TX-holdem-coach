import type { TransactionSql } from 'postgres'
import { z } from 'zod'
import type { PlayerDecisionReferencePort } from '../agents/player/player-decision-reference-port.js'
import type { DatabaseClient } from '../db/client.js'
import {
  PERSONA_CONFIG_PAYLOAD_VERSION,
  PersonaConfigPayloadSchema,
  createConfigSnapshotKey,
} from '../personas/config.js'
import { currentHandStartCheckpointReader } from '../sessions/hand-audit/hand-start-checkpoint-codec.js'
import { isPlayerVisibleState } from '../sessions/authoritative-state/player-information-boundary-guard.js'
import { runDatabaseTransaction } from './database-transaction.js'
import {
  DatabaseOperationError,
  PersistenceDataCorruptionError,
  RepositoryInputValidationError,
  UnknownPayloadVersionError,
} from './errors.js'
import { isResolvedOwnerScope } from './owner-scope.js'

const UuidSchema = z.string().uuid()
const SafeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)

const SessionRowSchema = z.strictObject({
  lifecycleStatus: z.enum(['active', 'ended', 'readonlyDiagnostic']),
  currentHandId: UuidSchema.nullable(),
  stateVersion: SafeIntegerSchema,
})

const ReferenceRowSchema = z.strictObject({
  handId: UuidSchema,
  handNumber: SafeIntegerSchema.positive(),
  handStatus: z.enum(['inProgress', 'completed', 'aborted']),
  checkpointPayloadVersion: z.unknown(),
  checkpointPayload: z.unknown(),
  participantId: UuidSchema,
  participantSeatNumber: z.number().int().min(0).max(8),
  participantType: z.enum(['user', 'agent']),
  personaId: z.string(),
  personaVersion: z.number().int(),
  configSnapshotKey: z.string().regex(/^[a-f0-9]{64}$/),
  configPayloadVersion: z.unknown(),
  configPayload: z.unknown(),
})

const STALE = Object.freeze({ kind: 'stale' as const })
const MISSING = Object.freeze({ kind: 'resourceMissing' as const })

async function queryRows(
  query: Promise<readonly unknown[]>,
): Promise<readonly unknown[]> {
  try {
    return await query
  } catch {
    throw new DatabaseOperationError()
  }
}

function parseSingle<Output>(
  rows: readonly unknown[],
  schema: z.ZodType<Output>,
): Output | null {
  if (rows.length === 0) return null
  if (rows.length !== 1) {
    throw new PersistenceDataCorruptionError('invalidPlayerDecisionReference')
  }
  const parsed = schema.safeParse(rows[0])
  if (!parsed.success) {
    throw new PersistenceDataCorruptionError('invalidPlayerDecisionReference')
  }
  return parsed.data
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

async function loadReference(
  transaction: TransactionSql,
  input: Parameters<PlayerDecisionReferencePort['load']>[0],
): Promise<Awaited<ReturnType<PlayerDecisionReferencePort['load']>>> {
  const identity = input.observation.identity
  const sessionRows = await queryRows(transaction`
    SELECT
      lifecycle_status AS "lifecycleStatus",
      current_hand_id::text AS "currentHandId",
      state_version::float8 AS "stateVersion"
    FROM app_private.sessions
    WHERE id = ${identity.sessionId}::uuid
      AND owner_id = ${input.owner.databaseOwnerId}::uuid
    FOR SHARE
  `)
  const session = parseSingle(sessionRows, SessionRowSchema)
  if (session === null) return MISSING
  if (
    session.lifecycleStatus !== 'active' ||
    session.currentHandId !== identity.handId ||
    session.stateVersion !== identity.stateVersion
  ) {
    return STALE
  }

  const referenceRows = await queryRows(transaction`
    SELECT
      hand.id::text AS "handId",
      hand.hand_number::float8 AS "handNumber",
      hand.status AS "handStatus",
      hand.hand_start_checkpoint_payload_version AS "checkpointPayloadVersion",
      hand.hand_start_checkpoint_payload AS "checkpointPayload",
      participant.id::text AS "participantId",
      participant.seat_number AS "participantSeatNumber",
      participant.participant_type AS "participantType",
      agent.persona_id AS "personaId",
      agent.persona_version AS "personaVersion",
      agent.config_snapshot_key AS "configSnapshotKey",
      agent.config_payload_version AS "configPayloadVersion",
      agent.config_payload AS "configPayload"
    FROM app_private.hands AS hand
    INNER JOIN app_private.session_participants AS participant
      ON participant.id = ${identity.actorParticipantId}::uuid
      AND participant.session_id = hand.session_id
      AND participant.owner_id = hand.owner_id
    INNER JOIN app_private.session_agents AS agent
      ON agent.participant_id = participant.id
      AND agent.session_id = participant.session_id
      AND agent.owner_id = participant.owner_id
    WHERE hand.id = ${identity.handId}::uuid
      AND hand.session_id = ${identity.sessionId}::uuid
      AND hand.owner_id = ${input.owner.databaseOwnerId}::uuid
    FOR SHARE OF hand, participant, agent
  `)
  const row = parseSingle(referenceRows, ReferenceRowSchema)
  if (row === null) return STALE
  if (
    row.handStatus !== 'inProgress' ||
    row.handId !== identity.handId ||
    row.participantId !== identity.actorParticipantId ||
    row.participantType !== 'agent' ||
    row.participantSeatNumber !== identity.actorSeat
  ) {
    return STALE
  }

  const checkpointRead = currentHandStartCheckpointReader.read(
    row.checkpointPayloadVersion,
    row.checkpointPayload,
  )
  if (checkpointRead.kind === 'unknownVersion') {
    throw new UnknownPayloadVersionError('handStartCheckpoint')
  }
  if (checkpointRead.kind === 'invalidPayload') {
    throw new PersistenceDataCorruptionError('invalidPlayerDecisionReference')
  }
  const checkpoint = checkpointRead.value
  const checkpointActor = checkpoint.stateBeforeStartCommand.poker.seats.find(
    (seat) => seat.seatNumber === identity.actorSeat,
  )
  if (
    checkpoint.startedHand.handId !== identity.handId ||
    checkpoint.startedHand.handNumber !== row.handNumber ||
    checkpointActor?.playerId !== identity.actorParticipantId ||
    checkpointActor.isUser
  ) {
    throw new PersistenceDataCorruptionError('invalidPlayerDecisionReference')
  }

  if (row.configPayloadVersion !== PERSONA_CONFIG_PAYLOAD_VERSION) {
    if (
      typeof row.configPayloadVersion === 'number' &&
      Number.isSafeInteger(row.configPayloadVersion) &&
      row.configPayloadVersion > 0
    ) {
      throw new UnknownPayloadVersionError('personaConfig')
    }
    throw new PersistenceDataCorruptionError('invalidPlayerDecisionReference')
  }
  const config = PersonaConfigPayloadSchema.safeParse(row.configPayload)
  if (
    !config.success ||
    config.data.personaId !== row.personaId ||
    config.data.personaVersion !== row.personaVersion ||
    createConfigSnapshotKey(PERSONA_CONFIG_PAYLOAD_VERSION, config.data) !==
      row.configSnapshotKey
  ) {
    throw new PersistenceDataCorruptionError('invalidPlayerDecisionReference')
  }

  return deepFreeze({
    kind: 'ready' as const,
    reference: {
      sessionId: identity.sessionId,
      handId: identity.handId,
      actorParticipantId: identity.actorParticipantId,
      actorSeat: identity.actorSeat,
      pokerRuleSetVersion: checkpoint.pokerRuleSetVersion,
      handNumber: checkpoint.startedHand.handNumber,
      configSnapshotKey: row.configSnapshotKey,
      personaId: config.data.personaId,
      personaVersion: config.data.personaVersion,
      personaPolicy: { ...config.data.style },
    },
  })
}

export function createPostgresPlayerDecisionReferencePort(input: {
  readonly database: DatabaseClient
}): PlayerDecisionReferencePort {
  if (
    typeof input.database !== 'object' ||
    input.database === null ||
    typeof input.database.sql !== 'function'
  ) {
    throw new RepositoryInputValidationError()
  }
  const sql = input.database.sql
  return Object.freeze({
    async load(loadInput: Parameters<PlayerDecisionReferencePort['load']>[0]) {
      if (
        !isResolvedOwnerScope(loadInput.owner) ||
        !isPlayerVisibleState(loadInput.observation)
      ) {
        throw new RepositoryInputValidationError()
      }
      return runDatabaseTransaction(sql, (transaction) =>
        loadReference(transaction, loadInput),
      )
    },
  })
}
