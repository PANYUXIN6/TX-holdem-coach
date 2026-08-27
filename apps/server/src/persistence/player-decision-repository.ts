import { createHash, randomUUID } from 'node:crypto'
import type { TransactionSql } from 'postgres'
import { z } from 'zod'
import { canonicalJson, type JsonValue } from '../persisted-json.js'
import { readCurrentAttemptAudit } from '../agents/audit/attempt-audit-codec.js'
import { AgentRunTransitionError } from '../agents/foundation/agent-run-lifecycle.js'
import {
  isRuntimeCommitAuthority,
  type RuntimeCommitAuthority,
} from '../agents/foundation/runtime-ports.js'
import {
  playerCandidateSetSnapshotCodec,
  playerDecisionAuditSnapshotCodec,
  playerModelChoiceCodec,
  playerModelProjectionCodec,
  playerValidatorResultCodec,
} from '../agents/player/player-decision-audit-codec.js'
import {
  certifyPersistedDecisionAuditSnapshotV1,
  isDecisionAuditSnapshotV1,
  type DecisionAuditSnapshotV1,
  type DecisionAuditSnapshotV1Data,
  type PlayerCandidateSetSnapshotV1,
} from '../agents/player/player-decision-audit.js'
import type {
  PlayerBoundedChoiceV1,
  PlayerValidatorResultV1,
} from '../agents/player/player-bounded-choice.js'
import {
  buildPlayerModelProjectionV1,
  type PlayerModelProjectionV1,
} from '../agents/player/player-model-projection.js'
import type { ResolvedOwnerScope } from './owner-scope.js'
import { isResolvedOwnerScope } from './owner-scope.js'
import {
  DatabaseOperationError,
  PersistenceDataCorruptionError,
  PlayerDecisionIntegrityError,
  PlayerDecisionTransitionError,
  RepositoryInputValidationError,
  ResourceNotFoundError,
  UnknownPayloadVersionError,
} from './errors.js'

const UuidSchema = z.string().uuid()
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)
const SafeNonnegativeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
const LockedRunSchema = z.strictObject({
  agentRunId: UuidSchema,
  sessionId: UuidSchema,
  handId: UuidSchema,
  participantId: UuidSchema,
  sourceStateVersion: SafeNonnegativeIntegerSchema,
  decisionRequestId: UuidSchema,
  fencingToken: SafeNonnegativeIntegerSchema.positive(),
})
const DecisionRowSchema = z.strictObject({
  decisionRecordId: UuidSchema,
  agentRunId: UuidSchema,
  sessionId: UuidSchema,
  handId: UuidSchema,
  participantId: UuidSchema,
  sourceStateVersion: SafeNonnegativeIntegerSchema,
  decisionRequestId: UuidSchema,
  status: z.enum(['auditPrepared', 'modelPrepared', 'selected', 'committed']),
  auditPayloadVersion: z.unknown(),
  auditPayload: z.unknown(),
  candidatePayloadVersion: z.unknown(),
  candidatePayload: z.unknown(),
  projectionPayloadVersion: z.unknown(),
  projectionPayload: z.unknown(),
  choicePayloadVersion: z.unknown(),
  choicePayload: z.unknown(),
  validatorPayloadVersion: z.unknown(),
  validatorPayload: z.unknown(),
  acceptedAttemptId: UuidSchema.nullable(),
  commandLedgerId: UuidSchema.nullable(),
  createdAt: z.string().datetime(),
  modelPreparedAt: z.string().datetime().nullable(),
  selectedAt: z.string().datetime().nullable(),
  committedAt: z.string().datetime().nullable(),
})
const AttemptRowSchema = z.strictObject({
  attemptId: UuidSchema,
  lifecycle: z.enum(['started', 'completed', 'failed', 'cancelled', 'stale']),
  accepted: z.boolean(),
  stale: z.boolean(),
  interrupted: z.boolean(),
  errorCategory: z.string().nullable(),
  stage: z.string(),
  fencingToken: SafeNonnegativeIntegerSchema.positive(),
  payloadVersion: z.unknown(),
  payload: z.unknown(),
  startedAt: z.string().datetime(),
})

export interface DecodedPlayerDecisionRecordV1 {
  readonly decisionRecordId: string
  readonly agentRunId: string
  readonly sessionId: string
  readonly handId: string
  readonly participantId: string
  readonly sourceStateVersion: number
  readonly decisionRequestId: string
  readonly status: 'auditPrepared' | 'modelPrepared' | 'selected' | 'committed'
  readonly auditSnapshot: DecisionAuditSnapshotV1Data
  readonly candidateSet: PlayerCandidateSetSnapshotV1
  readonly projection: PlayerModelProjectionV1 | null
  readonly choice: PlayerBoundedChoiceV1 | null
  readonly validatorResult: PlayerValidatorResultV1 | null
  readonly acceptedAttemptId: string | null
  readonly commandLedgerId: string | null
  readonly createdAt: string
  readonly modelPreparedAt: string | null
  readonly selectedAt: string | null
  readonly committedAt: string | null
  readonly [decodedPlayerDecisionRecordBrand]: never
}

declare const decodedPlayerDecisionRecordBrand: unique symbol

const decodedPlayerDecisionRecords = new WeakSet<object>()

export function isDecodedPlayerDecisionRecordV1(
  value: unknown,
): value is DecodedPlayerDecisionRecordV1 {
  return (
    typeof value === 'object' &&
    value !== null &&
    decodedPlayerDecisionRecords.has(value)
  )
}

declare const selectedReceiptBrand: unique symbol
export interface PlayerSelectedDecisionReceiptV1 {
  readonly decisionRecordId: string
  readonly agentRunId: string
  readonly binding: DecisionAuditSnapshotV1Data['binding']
  readonly candidateSetSha256: string
  readonly choice: PlayerBoundedChoiceV1
  readonly choiceSha256: string
  readonly acceptedAttemptId: string
  readonly [selectedReceiptBrand]: never
}

const selectedReceipts = new WeakSet<object>()

export type PlayerDecisionResumeState =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'auditPrepared'
      readonly record: DecodedPlayerDecisionRecordV1
    }
  | {
      readonly kind: 'modelPrepared'
      readonly record: DecodedPlayerDecisionRecordV1
    }
  | {
      readonly kind: 'selected'
      readonly record: DecodedPlayerDecisionRecordV1
    }
  | {
      readonly kind: 'committed'
      readonly record: DecodedPlayerDecisionRecordV1
    }
  | {
      readonly kind: 'inflightUnknown'
      readonly decisionRecordId: string
    }

export interface PlayerDecisionRepository {
  createAuditPrepared(
    transaction: TransactionSql,
    owner: ResolvedOwnerScope,
    authority: RuntimeCommitAuthority<'player'>,
    input: { readonly snapshot: DecisionAuditSnapshotV1 },
  ): Promise<{
    readonly decisionRecordId: string
    readonly status: 'auditPrepared'
  }>
  markModelPrepared(
    transaction: TransactionSql,
    owner: ResolvedOwnerScope,
    authority: RuntimeCommitAuthority<'player'>,
    input: {
      readonly decisionRecordId: string
      readonly snapshotSha256: string
      readonly candidateSetSha256: string
      readonly projection: PlayerModelProjectionV1
    },
  ): Promise<{ readonly status: 'modelPrepared' }>
  markSelected(
    transaction: TransactionSql,
    owner: ResolvedOwnerScope,
    authority: RuntimeCommitAuthority<'player'>,
    input: {
      readonly decisionRecordId: string
      readonly acceptedAttemptId: string
      readonly candidateSetSha256: string
      readonly choice: PlayerBoundedChoiceV1
      readonly validatorResult: PlayerValidatorResultV1
    },
  ): Promise<{ readonly status: 'selected' }>
  readSelectedReceipt(
    transaction: TransactionSql,
    owner: ResolvedOwnerScope,
    authority: RuntimeCommitAuthority<'player'>,
    input: {
      readonly decisionRecordId: string
      readonly expectedChoice: PlayerBoundedChoiceV1
    },
  ): Promise<PlayerSelectedDecisionReceiptV1>
  readForCommitValidation(
    transaction: TransactionSql,
    owner: ResolvedOwnerScope,
    input: {
      readonly decisionRecordId: string
      readonly agentRunId: string
      readonly sessionId: string
    },
  ): Promise<DecodedPlayerDecisionRecordV1>
  lockForCommitValidation(
    transaction: TransactionSql,
    owner: ResolvedOwnerScope,
    input: {
      readonly decisionRecordId: string
      readonly agentRunId: string
      readonly sessionId: string
    },
  ): Promise<DecodedPlayerDecisionRecordV1>
  readForResume(
    transaction: TransactionSql,
    owner: ResolvedOwnerScope,
    authority: RuntimeCommitAuthority<'player'>,
  ): Promise<PlayerDecisionResumeState>
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

function sha256(value: JsonValue): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

function rebuildPersistedProjection(
  record: DecodedPlayerDecisionRecordV1,
  authority: RuntimeCommitAuthority<'player'>,
): PlayerModelProjectionV1 {
  const certifiedSnapshot = certifyPersistedDecisionAuditSnapshotV1({
    snapshot: record.auditSnapshot,
    authority,
    expected: {
      sessionId: record.sessionId,
      handId: record.handId,
      participantId: record.participantId,
      sourceStateVersion: record.sourceStateVersion,
      decisionRequestId: record.decisionRequestId,
    },
  })
  return buildPlayerModelProjectionV1(certifiedSnapshot)
}

async function queryRows(
  query: Promise<readonly unknown[]>,
): Promise<readonly unknown[]> {
  try {
    return await query
  } catch {
    throw new DatabaseOperationError()
  }
}

function requireSingle<T>(
  rows: readonly unknown[],
  schema: z.ZodType<T>,
  missing: 'authority' | 'resource' | 'transition' = 'resource',
): T {
  if (rows.length === 0) {
    if (missing === 'authority') {
      throw new AgentRunTransitionError('agent_run_fencing_rejected')
    }
    if (missing === 'transition') throw new PlayerDecisionTransitionError()
    throw new ResourceNotFoundError()
  }
  const parsed = z.array(schema).safeParse(rows)
  if (!parsed.success || parsed.data.length !== 1) {
    throw new PersistenceDataCorruptionError('invalidPlayerDecision')
  }
  return parsed.data[0]!
}

async function lockRun(
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
  authority: RuntimeCommitAuthority<'player'>,
): Promise<z.infer<typeof LockedRunSchema>> {
  if (
    !isResolvedOwnerScope(owner) ||
    !isRuntimeCommitAuthority(authority, 'player')
  ) {
    throw new RepositoryInputValidationError()
  }
  const rows = await queryRows(transaction`
    SELECT
      id::text AS "agentRunId",
      session_id::text AS "sessionId",
      hand_id::text AS "handId",
      participant_id::text AS "participantId",
      source_state_version::float8 AS "sourceStateVersion",
      decision_request_id::text AS "decisionRequestId",
      fencing_token::float8 AS "fencingToken"
    FROM app_private.agent_runs
    WHERE id = ${authority.runId}::uuid
      AND owner_id = ${owner.databaseOwnerId}::uuid
      AND runtime = 'player'
      AND lifecycle = 'running'
      AND lease_owner = ${authority.leaseOwner}
      AND fencing_token = ${authority.fencingToken}::bigint
      AND lease_expires_at > clock_timestamp()
      AND deadline_at > clock_timestamp()
    FOR UPDATE
  `)
  return requireSingle(rows, LockedRunSchema, 'authority')
}

async function lockDecision(
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
  run: z.infer<typeof LockedRunSchema>,
  decisionRecordId?: string,
): Promise<z.infer<typeof DecisionRowSchema>> {
  const rows = await queryRows(transaction`
    SELECT
      id::text AS "decisionRecordId",
      agent_run_id::text AS "agentRunId",
      session_id::text AS "sessionId",
      hand_id::text AS "handId",
      participant_id::text AS "participantId",
      source_state_version::float8 AS "sourceStateVersion",
      decision_request_id::text AS "decisionRequestId",
      status,
      decision_audit_snapshot_payload_version AS "auditPayloadVersion",
      decision_audit_snapshot_payload AS "auditPayload",
      candidate_set_payload_version AS "candidatePayloadVersion",
      candidate_set_payload AS "candidatePayload",
      model_projection_payload_version AS "projectionPayloadVersion",
      model_projection_payload AS "projectionPayload",
      model_choice_payload_version AS "choicePayloadVersion",
      model_choice_payload AS "choicePayload",
      validator_result_payload_version AS "validatorPayloadVersion",
      validator_result_payload AS "validatorPayload",
      accepted_attempt_id::text AS "acceptedAttemptId",
      command_ledger_id::text AS "commandLedgerId",
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
      CASE WHEN model_prepared_at IS NULL THEN NULL ELSE
        to_char(model_prepared_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS "modelPreparedAt",
      CASE WHEN selected_at IS NULL THEN NULL ELSE
        to_char(selected_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS "selectedAt",
      CASE WHEN committed_at IS NULL THEN NULL ELSE
        to_char(committed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS "committedAt"
    FROM app_private.player_decisions
    WHERE agent_run_id = ${run.agentRunId}::uuid
      AND owner_id = ${owner.databaseOwnerId}::uuid
      AND session_id = ${run.sessionId}::uuid
      AND (${decisionRecordId ?? null}::uuid IS NULL OR id = ${decisionRecordId ?? null}::uuid)
    FOR UPDATE
  `)
  const row = requireSingle(rows, DecisionRowSchema)
  if (
    row.handId !== run.handId ||
    row.participantId !== run.participantId ||
    row.sourceStateVersion !== run.sourceStateVersion ||
    row.decisionRequestId !== run.decisionRequestId
  ) {
    throw new PersistenceDataCorruptionError('invalidPlayerDecision')
  }
  return row
}

function readPayload<T>(input: {
  readonly payloadKind:
    | 'playerDecisionAuditSnapshot'
    | 'playerDecisionCandidateSet'
    | 'playerDecisionModelProjection'
    | 'playerDecisionModelChoice'
    | 'playerDecisionValidatorResult'
  readonly version: unknown
  readonly payload: unknown
  readonly reader: (
    version: number | null,
    payload: unknown,
  ) =>
    | { readonly kind: 'decoded'; readonly value: T }
    | { readonly kind: 'unknownVersion' }
    | { readonly kind: 'invalidPayload' }
}): T {
  const version =
    typeof input.version === 'number' && Number.isSafeInteger(input.version)
      ? input.version
      : null
  const read = input.reader(version, input.payload)
  if (read.kind === 'unknownVersion') {
    throw new UnknownPayloadVersionError(input.payloadKind)
  }
  if (read.kind === 'invalidPayload') {
    throw new PersistenceDataCorruptionError('invalidPlayerDecision')
  }
  return read.value
}

function decodeDecisionRow(
  row: z.infer<typeof DecisionRowSchema>,
): DecodedPlayerDecisionRecordV1 {
  const auditSnapshot = readPayload({
    payloadKind: 'playerDecisionAuditSnapshot',
    version: row.auditPayloadVersion,
    payload: row.auditPayload,
    reader: playerDecisionAuditSnapshotCodec.read,
  })
  const candidateSet = readPayload({
    payloadKind: 'playerDecisionCandidateSet',
    version: row.candidatePayloadVersion,
    payload: row.candidatePayload,
    reader: playerCandidateSetSnapshotCodec.read,
  })
  const projection =
    row.projectionPayloadVersion === null && row.projectionPayload === null
      ? null
      : readPayload({
          payloadKind: 'playerDecisionModelProjection',
          version: row.projectionPayloadVersion,
          payload: row.projectionPayload,
          reader: playerModelProjectionCodec.read,
        })
  const choice =
    row.choicePayloadVersion === null && row.choicePayload === null
      ? null
      : readPayload({
          payloadKind: 'playerDecisionModelChoice',
          version: row.choicePayloadVersion,
          payload: row.choicePayload,
          reader: playerModelChoiceCodec.read,
        })
  const validatorResult =
    row.validatorPayloadVersion === null && row.validatorPayload === null
      ? null
      : readPayload({
          payloadKind: 'playerDecisionValidatorResult',
          version: row.validatorPayloadVersion,
          payload: row.validatorPayload,
          reader: playerValidatorResultCodec.read,
        })
  const { snapshotSha256, ...snapshotWithoutHash } = auditSnapshot
  const { candidateSetSha256, ...candidateSetWithoutHash } = candidateSet
  if (
    (row.status === 'auditPrepared' &&
      (projection !== null ||
        choice !== null ||
        validatorResult !== null ||
        row.acceptedAttemptId !== null ||
        row.modelPreparedAt !== null ||
        row.selectedAt !== null ||
        row.commandLedgerId !== null ||
        row.committedAt !== null)) ||
    (row.status === 'modelPrepared' &&
      (projection === null ||
        choice !== null ||
        validatorResult !== null ||
        row.acceptedAttemptId !== null ||
        row.modelPreparedAt === null ||
        row.selectedAt !== null ||
        row.commandLedgerId !== null ||
        row.committedAt !== null)) ||
    (row.status === 'selected' &&
      (projection === null ||
        choice === null ||
        validatorResult === null ||
        row.acceptedAttemptId === null ||
        row.modelPreparedAt === null ||
        row.selectedAt === null ||
        row.commandLedgerId !== null ||
        row.committedAt !== null)) ||
    (row.status === 'committed' &&
      (projection === null ||
        choice === null ||
        validatorResult === null ||
        row.acceptedAttemptId === null ||
        row.modelPreparedAt === null ||
        row.selectedAt === null ||
        row.commandLedgerId === null ||
        row.committedAt === null ||
        Date.parse(row.committedAt) < Date.parse(row.selectedAt)))
  ) {
    throw new PersistenceDataCorruptionError('invalidPlayerDecision')
  }
  if (
    snapshotSha256 !== sha256(snapshotWithoutHash as unknown as JsonValue) ||
    candidateSetSha256 !==
      sha256(candidateSetWithoutHash as unknown as JsonValue) ||
    auditSnapshot.candidates.candidateSetSha256 !==
      candidateSet.candidateSetSha256 ||
    canonicalJson(auditSnapshot.candidates as unknown as JsonValue) !==
      canonicalJson(candidateSet as unknown as JsonValue) ||
    (choice !== null &&
      !candidateSet.candidates.some(
        ({ candidateId }) => candidateId === choice.candidateActionId,
      )) ||
    (choice !== null &&
      validatorResult !== null &&
      (validatorResult.candidateSetSha256 !== candidateSetSha256 ||
        validatorResult.choiceSha256 !==
          sha256(choice as unknown as JsonValue)))
  ) {
    throw new PlayerDecisionIntegrityError()
  }
  const decoded = deepFreeze({
    decisionRecordId: row.decisionRecordId,
    agentRunId: row.agentRunId,
    sessionId: row.sessionId,
    handId: row.handId,
    participantId: row.participantId,
    sourceStateVersion: row.sourceStateVersion,
    decisionRequestId: row.decisionRequestId,
    status: row.status,
    auditSnapshot,
    candidateSet,
    projection,
    choice,
    validatorResult,
    acceptedAttemptId: row.acceptedAttemptId,
    commandLedgerId: row.commandLedgerId,
    createdAt: row.createdAt,
    modelPreparedAt: row.modelPreparedAt,
    selectedAt: row.selectedAt,
    committedAt: row.committedAt,
  }) as DecodedPlayerDecisionRecordV1
  decodedPlayerDecisionRecords.add(decoded)
  return decoded
}

async function requireAcceptedAttempt(
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
  run: z.infer<typeof LockedRunSchema>,
  attemptId: string,
): Promise<z.infer<typeof AttemptRowSchema>> {
  const rows = await queryRows(transaction`
    SELECT
      id::text AS "attemptId",
      lifecycle,
      accepted,
      stale,
      interrupted,
      error_category AS "errorCategory",
      stage,
      fencing_token::float8 AS "fencingToken",
      attempt_payload_version AS "payloadVersion",
      attempt_payload AS "payload",
      to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startedAt"
    FROM app_private.agent_attempts
    WHERE id = ${attemptId}::uuid
      AND agent_run_id = ${run.agentRunId}::uuid
      AND owner_id = ${owner.databaseOwnerId}::uuid
      AND session_id = ${run.sessionId}::uuid
    FOR UPDATE
  `)
  const attempt = requireSingle(rows, AttemptRowSchema)
  const audit = readCurrentAttemptAudit(
    attempt.lifecycle,
    attempt.payloadVersion,
    attempt.payload,
  )
  if (audit.kind !== 'decoded') {
    throw new PersistenceDataCorruptionError('invalidAgentAttemptAudit')
  }
  if (
    attempt.lifecycle !== 'completed' ||
    !attempt.accepted ||
    attempt.stale ||
    attempt.interrupted ||
    attempt.stage !== 'player.bounded-choice' ||
    audit.value.lifecycle !== 'completed' ||
    audit.value.validationStatus !== 'valid'
  ) {
    throw new PlayerDecisionTransitionError()
  }
  return attempt
}

export function createPlayerDecisionRepository(): PlayerDecisionRepository {
  const repository: PlayerDecisionRepository = {
    async createAuditPrepared(transaction, owner, authority, input) {
      if (!isDecisionAuditSnapshotV1(input.snapshot)) {
        throw new RepositoryInputValidationError()
      }
      const run = await lockRun(transaction, owner, authority)
      const binding = input.snapshot.binding
      if (
        run.agentRunId !== authority.runId ||
        run.sessionId !== binding.sessionId ||
        run.handId !== binding.handId ||
        run.participantId !== binding.actorParticipantId ||
        run.sourceStateVersion !== binding.stateVersion ||
        run.decisionRequestId !== binding.decisionRequestId
      ) {
        throw new AgentRunTransitionError('agent_run_fencing_rejected')
      }
      const existing = await queryRows(transaction`
        SELECT id FROM app_private.player_decisions
        WHERE agent_run_id = ${run.agentRunId}::uuid
        FOR UPDATE
      `)
      if (existing.length !== 0) throw new PlayerDecisionTransitionError()
      const audit = playerDecisionAuditSnapshotCodec.encode(input.snapshot)
      const candidates = playerCandidateSetSnapshotCodec.encode(
        input.snapshot.candidates,
      )
      const decisionRecordId = randomUUID()
      const inserted = await queryRows(transaction`
        INSERT INTO app_private.player_decisions (
          id, agent_run_id, owner_id, session_id, hand_id, participant_id,
          source_state_version, decision_request_id, runtime, record_version,
          status, decision_audit_snapshot_payload_version,
          decision_audit_snapshot_payload, candidate_set_payload_version,
          candidate_set_payload
        ) VALUES (
          ${decisionRecordId}::uuid, ${run.agentRunId}::uuid,
          ${owner.databaseOwnerId}::uuid, ${run.sessionId}::uuid,
          ${run.handId}::uuid, ${run.participantId}::uuid,
          ${run.sourceStateVersion}::bigint, ${run.decisionRequestId}::uuid,
          'player', 1, 'auditPrepared', ${audit.payloadVersion},
          ${transaction.json(audit.payload as unknown as JsonValue)},
          ${candidates.payloadVersion},
          ${transaction.json(candidates.payload as unknown as JsonValue)}
        )
        RETURNING id::text AS "decisionRecordId"
      `)
      const returned = requireSingle(
        inserted,
        z.strictObject({ decisionRecordId: UuidSchema }),
      )
      if (returned.decisionRecordId !== decisionRecordId) {
        throw new PersistenceDataCorruptionError('invalidPlayerDecision')
      }
      return Object.freeze({
        decisionRecordId,
        status: 'auditPrepared' as const,
      })
    },

    async markModelPrepared(transaction, owner, authority, input) {
      const parsed = z
        .strictObject({
          decisionRecordId: UuidSchema,
          snapshotSha256: Sha256Schema,
          candidateSetSha256: Sha256Schema,
        })
        .safeParse({
          decisionRecordId: input.decisionRecordId,
          snapshotSha256: input.snapshotSha256,
          candidateSetSha256: input.candidateSetSha256,
        })
      if (!parsed.success) throw new RepositoryInputValidationError()
      const run = await lockRun(transaction, owner, authority)
      const row = await lockDecision(
        transaction,
        owner,
        run,
        parsed.data.decisionRecordId,
      )
      const decoded = decodeDecisionRow(row)
      if (
        decoded.status !== 'auditPrepared' ||
        decoded.auditSnapshot.snapshotSha256 !== parsed.data.snapshotSha256 ||
        decoded.candidateSet.candidateSetSha256 !==
          parsed.data.candidateSetSha256
      ) {
        throw new PlayerDecisionTransitionError()
      }
      const projection = playerModelProjectionCodec.encode(input.projection)
      const expectedProjection = rebuildPersistedProjection(decoded, authority)
      if (
        canonicalJson(projection.payload as unknown as JsonValue) !==
        canonicalJson(expectedProjection as unknown as JsonValue)
      ) {
        throw new PlayerDecisionTransitionError()
      }
      const updated = await queryRows(transaction`
        UPDATE app_private.player_decisions
        SET status = 'modelPrepared',
            model_projection_payload_version = ${projection.payloadVersion},
            model_projection_payload = ${transaction.json(
              projection.payload as unknown as JsonValue,
            )},
            model_prepared_at = clock_timestamp(),
            updated_at = clock_timestamp()
        WHERE id = ${parsed.data.decisionRecordId}::uuid
          AND status = 'auditPrepared'
        RETURNING status
      `)
      requireSingle(
        updated,
        z.strictObject({ status: z.literal('modelPrepared') }),
        'transition',
      )
      return Object.freeze({ status: 'modelPrepared' as const })
    },

    async markSelected(transaction, owner, authority, input) {
      const parsed = z
        .strictObject({
          decisionRecordId: UuidSchema,
          acceptedAttemptId: UuidSchema,
          candidateSetSha256: Sha256Schema,
        })
        .safeParse({
          decisionRecordId: input.decisionRecordId,
          acceptedAttemptId: input.acceptedAttemptId,
          candidateSetSha256: input.candidateSetSha256,
        })
      if (!parsed.success) throw new RepositoryInputValidationError()
      const run = await lockRun(transaction, owner, authority)
      const row = await lockDecision(
        transaction,
        owner,
        run,
        parsed.data.decisionRecordId,
      )
      const decoded = decodeDecisionRow(row)
      if (
        decoded.status !== 'modelPrepared' ||
        decoded.candidateSet.candidateSetSha256 !==
          parsed.data.candidateSetSha256
      ) {
        throw new PlayerDecisionTransitionError()
      }
      await requireAcceptedAttempt(
        transaction,
        owner,
        run,
        parsed.data.acceptedAttemptId,
      )
      const choice = playerModelChoiceCodec.encode(input.choice)
      const validator = playerValidatorResultCodec.encode(input.validatorResult)
      if (
        validator.payload.candidateSetSha256 !==
          parsed.data.candidateSetSha256 ||
        validator.payload.choiceSha256 !==
          sha256(choice.payload as unknown as JsonValue) ||
        !decoded.candidateSet.candidates.some(
          ({ candidateId }) => candidateId === choice.payload.candidateActionId,
        )
      ) {
        throw new PlayerDecisionTransitionError()
      }
      const updated = await queryRows(transaction`
        UPDATE app_private.player_decisions
        SET status = 'selected',
            model_choice_payload_version = ${choice.payloadVersion},
            model_choice_payload = ${transaction.json(
              choice.payload as unknown as JsonValue,
            )},
            validator_result_payload_version = ${validator.payloadVersion},
            validator_result_payload = ${transaction.json(
              validator.payload as unknown as JsonValue,
            )},
            accepted_attempt_id = ${parsed.data.acceptedAttemptId}::uuid,
            selected_at = clock_timestamp(),
            updated_at = clock_timestamp()
        WHERE id = ${parsed.data.decisionRecordId}::uuid
          AND status = 'modelPrepared'
        RETURNING status
      `)
      requireSingle(
        updated,
        z.strictObject({ status: z.literal('selected') }),
        'transition',
      )
      return Object.freeze({ status: 'selected' as const })
    },

    async readForCommitValidation(transaction, owner, input) {
      if (!isResolvedOwnerScope(owner)) {
        throw new RepositoryInputValidationError()
      }
      const parsed = z
        .strictObject({
          decisionRecordId: UuidSchema,
          agentRunId: UuidSchema,
          sessionId: UuidSchema,
        })
        .safeParse(input)
      if (!parsed.success) throw new RepositoryInputValidationError()
      const rows = await queryRows(transaction`
        SELECT
          id::text AS "decisionRecordId",
          agent_run_id::text AS "agentRunId",
          session_id::text AS "sessionId",
          hand_id::text AS "handId",
          participant_id::text AS "participantId",
          source_state_version::float8 AS "sourceStateVersion",
          decision_request_id::text AS "decisionRequestId",
          status,
          decision_audit_snapshot_payload_version AS "auditPayloadVersion",
          decision_audit_snapshot_payload AS "auditPayload",
          candidate_set_payload_version AS "candidatePayloadVersion",
          candidate_set_payload AS "candidatePayload",
          model_projection_payload_version AS "projectionPayloadVersion",
          model_projection_payload AS "projectionPayload",
          model_choice_payload_version AS "choicePayloadVersion",
          model_choice_payload AS "choicePayload",
          validator_result_payload_version AS "validatorPayloadVersion",
          validator_result_payload AS "validatorPayload",
          accepted_attempt_id::text AS "acceptedAttemptId",
          command_ledger_id::text AS "commandLedgerId",
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
          CASE WHEN model_prepared_at IS NULL THEN NULL ELSE
            to_char(model_prepared_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS "modelPreparedAt",
          CASE WHEN selected_at IS NULL THEN NULL ELSE
            to_char(selected_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS "selectedAt",
          CASE WHEN committed_at IS NULL THEN NULL ELSE
            to_char(committed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS "committedAt"
        FROM app_private.player_decisions
        WHERE id = ${parsed.data.decisionRecordId}::uuid
          AND agent_run_id = ${parsed.data.agentRunId}::uuid
          AND owner_id = ${owner.databaseOwnerId}::uuid
          AND session_id = ${parsed.data.sessionId}::uuid
      `)
      return decodeDecisionRow(requireSingle(rows, DecisionRowSchema))
    },

    async lockForCommitValidation(transaction, owner, input) {
      if (!isResolvedOwnerScope(owner)) {
        throw new RepositoryInputValidationError()
      }
      const parsed = z
        .strictObject({
          decisionRecordId: UuidSchema,
          agentRunId: UuidSchema,
          sessionId: UuidSchema,
        })
        .safeParse(input)
      if (!parsed.success) throw new RepositoryInputValidationError()
      const rows = await queryRows(transaction`
        SELECT id::text AS "decisionRecordId"
        FROM app_private.player_decisions
        WHERE id = ${parsed.data.decisionRecordId}::uuid
          AND agent_run_id = ${parsed.data.agentRunId}::uuid
          AND owner_id = ${owner.databaseOwnerId}::uuid
          AND session_id = ${parsed.data.sessionId}::uuid
        FOR UPDATE
      `)
      requireSingle(rows, z.strictObject({ decisionRecordId: UuidSchema }))
      return repository.readForCommitValidation(transaction, owner, parsed.data)
    },

    async readSelectedReceipt(transaction, owner, authority, input) {
      const parsedId = UuidSchema.safeParse(input.decisionRecordId)
      if (!parsedId.success) throw new RepositoryInputValidationError()
      const expectedChoice = playerModelChoiceCodec.encode(input.expectedChoice)
      const run = await lockRun(transaction, owner, authority)
      const row = await lockDecision(transaction, owner, run, parsedId.data)
      const decoded = decodeDecisionRow(row)
      if (
        decoded.status !== 'selected' ||
        decoded.choice === null ||
        decoded.validatorResult === null ||
        decoded.acceptedAttemptId === null ||
        canonicalJson(decoded.choice as JsonValue) !==
          canonicalJson(expectedChoice.payload as JsonValue)
      ) {
        throw new PlayerDecisionTransitionError()
      }
      await requireAcceptedAttempt(
        transaction,
        owner,
        run,
        decoded.acceptedAttemptId,
      )
      const receipt = deepFreeze({
        decisionRecordId: decoded.decisionRecordId,
        agentRunId: decoded.agentRunId,
        binding: decoded.auditSnapshot.binding,
        candidateSetSha256: decoded.candidateSet.candidateSetSha256,
        choice: decoded.choice,
        choiceSha256: decoded.validatorResult.choiceSha256,
        acceptedAttemptId: decoded.acceptedAttemptId,
      }) as PlayerSelectedDecisionReceiptV1
      selectedReceipts.add(receipt)
      return receipt
    },

    async readForResume(transaction, owner, authority) {
      const run = await lockRun(transaction, owner, authority)
      const rows = await queryRows(transaction`
        SELECT
          id::text AS "decisionRecordId",
          agent_run_id::text AS "agentRunId",
          session_id::text AS "sessionId",
          hand_id::text AS "handId",
          participant_id::text AS "participantId",
          source_state_version::float8 AS "sourceStateVersion",
          decision_request_id::text AS "decisionRequestId",
          status,
          decision_audit_snapshot_payload_version AS "auditPayloadVersion",
          decision_audit_snapshot_payload AS "auditPayload",
          candidate_set_payload_version AS "candidatePayloadVersion",
          candidate_set_payload AS "candidatePayload",
          model_projection_payload_version AS "projectionPayloadVersion",
          model_projection_payload AS "projectionPayload",
          model_choice_payload_version AS "choicePayloadVersion",
          model_choice_payload AS "choicePayload",
          validator_result_payload_version AS "validatorPayloadVersion",
          validator_result_payload AS "validatorPayload",
          accepted_attempt_id::text AS "acceptedAttemptId",
          command_ledger_id::text AS "commandLedgerId",
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
          CASE WHEN model_prepared_at IS NULL THEN NULL ELSE
            to_char(model_prepared_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS "modelPreparedAt",
          CASE WHEN selected_at IS NULL THEN NULL ELSE
            to_char(selected_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS "selectedAt",
          CASE WHEN committed_at IS NULL THEN NULL ELSE
            to_char(committed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS "committedAt"
        FROM app_private.player_decisions
        WHERE agent_run_id = ${run.agentRunId}::uuid
          AND owner_id = ${owner.databaseOwnerId}::uuid
          AND session_id = ${run.sessionId}::uuid
        FOR UPDATE
      `)
      if (rows.length === 0) return Object.freeze({ kind: 'none' as const })
      const row = requireSingle(rows, DecisionRowSchema)
      const record = decodeDecisionRow(row)
      if (
        record.projection !== null &&
        canonicalJson(record.projection as unknown as JsonValue) !==
          canonicalJson(
            rebuildPersistedProjection(
              record,
              authority,
            ) as unknown as JsonValue,
          )
      ) {
        throw new PersistenceDataCorruptionError('invalidPlayerDecision')
      }
      if (
        record.status === 'auditPrepared' ||
        record.status === 'modelPrepared'
      ) {
        const stagePreparedAt =
          record.status === 'modelPrepared'
            ? record.modelPreparedAt
            : record.createdAt
        if (stagePreparedAt === null) {
          throw new PersistenceDataCorruptionError('invalidPlayerDecision')
        }
        const attempts = await queryRows(transaction`
          SELECT
            id::text AS "attemptId", lifecycle, accepted, stale, interrupted,
            error_category AS "errorCategory", stage,
            fencing_token::float8 AS "fencingToken",
            attempt_payload_version AS "payloadVersion",
            attempt_payload AS "payload",
            to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startedAt"
          FROM app_private.agent_attempts
          WHERE agent_run_id = ${run.agentRunId}::uuid
            AND owner_id = ${owner.databaseOwnerId}::uuid
            AND session_id = ${run.sessionId}::uuid
            AND fencing_token < ${authority.fencingToken}::bigint
            AND lifecycle = 'stale'
            AND interrupted
            AND error_category = 'lease_replaced'
            AND stage = 'player.bounded-choice'
            AND started_at >= ${stagePreparedAt}::timestamptz
          FOR UPDATE
        `)
        const parsedAttempts = z.array(AttemptRowSchema).safeParse(attempts)
        if (!parsedAttempts.success) {
          throw new PersistenceDataCorruptionError('invalidAgentAttemptAudit')
        }
        if (parsedAttempts.data.length > 0) {
          if (record.status === 'auditPrepared') {
            throw new PersistenceDataCorruptionError('invalidPlayerDecision')
          }
          return Object.freeze({
            kind: 'inflightUnknown' as const,
            decisionRecordId: record.decisionRecordId,
          })
        }
      }
      if (record.status === 'selected' || record.status === 'committed') {
        if (record.acceptedAttemptId === null) {
          throw new PersistenceDataCorruptionError('invalidPlayerDecision')
        }
        await requireAcceptedAttempt(
          transaction,
          owner,
          run,
          record.acceptedAttemptId,
        )
      }
      return Object.freeze({ kind: record.status, record })
    },
  }
  return Object.freeze(repository)
}

export function isPlayerSelectedDecisionReceiptV1(
  value: unknown,
): value is PlayerSelectedDecisionReceiptV1 {
  return (
    typeof value === 'object' && value !== null && selectedReceipts.has(value)
  )
}
