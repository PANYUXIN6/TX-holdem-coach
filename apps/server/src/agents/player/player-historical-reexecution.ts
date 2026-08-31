import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { DatabaseClient } from '../../db/client.js'
import type { JsonValue } from '../../persisted-json.js'
import { currentExecutionBudgetAuditReader } from '../audit/execution-budget-audit-codec.js'
import { currentRunConfigurationAuditReader } from '../audit/run-configuration-audit-codec.js'
import {
  decodeFrozenPlayerModelInputV1,
  hashFrozenPlayerModelInputV1,
  type FrozenPlayerModelInputV1,
} from './player-frozen-model-input.js'
import {
  playerCandidateSetSnapshotCodec,
  playerDecisionAuditSnapshotCodec,
  playerModelProjectionCodec,
} from './player-decision-audit-codec.js'
import { hashPlayerModelProjectionV1 } from './player-model-projection.js'
import type { ResolvedOwnerScope } from '../../persistence/owner-scope.js'
import {
  DatabaseOperationError,
  PersistenceDataCorruptionError,
  ResourceNotFoundError,
} from '../../persistence/errors.js'

const UuidSchema = z.string().uuid()
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)
const SafeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
const HistoricalSourceRowSchema = z.strictObject({
  sourceRunId: UuidSchema,
  sourceDecisionId: UuidSchema,
  sessionId: UuidSchema,
  handId: UuidSchema,
  participantId: UuidSchema,
  sourceStateVersion: SafeIntegerSchema,
  decisionRequestId: UuidSchema,
  executionMode: z.enum(['live', 'historicalReexecution']),
  lifecycle: z.string(),
  runtimeDefinitionVersion: z.number().int().positive(),
  runConfigPayloadVersion: z.unknown(),
  runConfigPayload: z.unknown(),
  budgetPayloadVersion: z.unknown(),
  budgetPayload: z.unknown(),
  status: z.enum(['auditPrepared', 'modelPrepared', 'selected', 'committed']),
  auditPayloadVersion: z.unknown(),
  auditPayload: z.unknown(),
  candidatePayloadVersion: z.unknown(),
  candidatePayload: z.unknown(),
  projectionPayloadVersion: z.unknown(),
  projectionPayload: z.unknown(),
  memoryRevision: SafeIntegerSchema,
  memoryPayloadVersion: z.literal(1),
  memorySha256: Sha256Schema,
  frozenModelInputPayloadVersion: z.literal(1).nullable(),
  frozenModelInputPayload: z.unknown().nullable(),
  frozenModelInputSha256: Sha256Schema.nullable(),
})

const ExistingHistoricalRowSchema = z.strictObject({
  runId: UuidSchema,
  decisionId: UuidSchema,
  sourceDecisionId: UuidSchema,
})

const HistoricalReexecutionSourceInputSchema = z.strictObject({
  sourceRunId: UuidSchema,
  sourceDecisionId: UuidSchema,
  executionMode: z.enum(['live', 'historicalReexecution']),
  status: z.enum(['auditPrepared', 'modelPrepared', 'selected', 'committed']),
  snapshotSha256: Sha256Schema,
  candidateSetSha256: Sha256Schema,
  projectionSha256: Sha256Schema,
  frozenModelInput: z.unknown(),
  frozenModelInputSha256: Sha256Schema,
})

export interface HistoricalReexecutionSourceV1 {
  readonly sourceRunId: string
  readonly sourceDecisionId: string
  readonly executionMode: 'live' | 'historicalReexecution'
  readonly status: 'auditPrepared' | 'modelPrepared' | 'selected' | 'committed'
  readonly snapshotSha256: string
  readonly candidateSetSha256: string
  readonly projectionSha256: string
  readonly frozenModelInput: FrozenPlayerModelInputV1
  readonly frozenModelInputSha256: string
}

export class HistoricalReexecutionSourceError extends Error {
  public constructor(
    public readonly code:
      'unsupported_source_decision' | 'historical_source_integrity_violation',
  ) {
    super(
      code === 'unsupported_source_decision'
        ? 'Historical Re-execution 来源不受支持。'
        : 'Historical Re-execution 来源摘要不一致。',
    )
    this.name = 'HistoricalReexecutionSourceError'
  }
}

export class PlayerHistoricalReexecutionError extends Error {
  public constructor(
    public readonly code:
      | 'invalid_input'
      | 'unsupported_source_decision'
      | 'historical_source_integrity_violation'
      | 'historical_reexecution_idempotency_conflict',
  ) {
    super(`Player Historical Re-execution 失败：${code}`)
    this.name = 'PlayerHistoricalReexecutionError'
  }
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

/**
 * 认证可用于历史重演的来源。它只返回来源已持久化的模型输入，不接受
 * 新执行 binding 参与消息重建，从而保证 Provider 的首次 messages 保持来源字节。
 */
export function certifyHistoricalReexecutionSourceV1(
  value: unknown,
): HistoricalReexecutionSourceV1 {
  const parsed = HistoricalReexecutionSourceInputSchema.safeParse(value)
  if (!parsed.success) {
    throw new HistoricalReexecutionSourceError('unsupported_source_decision')
  }
  const source = parsed.data
  if (
    source.executionMode !== 'live' ||
    (source.status !== 'modelPrepared' &&
      source.status !== 'selected' &&
      source.status !== 'committed')
  ) {
    throw new HistoricalReexecutionSourceError('unsupported_source_decision')
  }
  let frozenModelInput: FrozenPlayerModelInputV1
  try {
    frozenModelInput = decodeFrozenPlayerModelInputV1(source.frozenModelInput)
  } catch {
    throw new HistoricalReexecutionSourceError(
      'historical_source_integrity_violation',
    )
  }
  if (
    hashFrozenPlayerModelInputV1(frozenModelInput) !==
    source.frozenModelInputSha256
  ) {
    throw new HistoricalReexecutionSourceError(
      'historical_source_integrity_violation',
    )
  }
  return deepFreeze({ ...source, frozenModelInput })
}

function readCurrentPayload<T>(input: {
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
  const result = input.reader(version, input.payload)
  if (result.kind !== 'decoded') {
    throw new PlayerHistoricalReexecutionError(
      result.kind === 'unknownVersion'
        ? 'unsupported_source_decision'
        : 'historical_source_integrity_violation',
    )
  }
  return result.value
}

function decodeHistoricalSource(row: unknown): {
  readonly row: z.infer<typeof HistoricalSourceRowSchema>
  readonly source: HistoricalReexecutionSourceV1
} {
  const parsed = HistoricalSourceRowSchema.safeParse(row)
  if (!parsed.success) {
    throw new PlayerHistoricalReexecutionError(
      'historical_source_integrity_violation',
    )
  }
  const value = parsed.data
  const configuration = currentRunConfigurationAuditReader.read(
    value.runConfigPayloadVersion,
    value.runConfigPayload,
  )
  const budget = currentExecutionBudgetAuditReader.read(
    value.budgetPayloadVersion,
    value.budgetPayload,
  )
  if (configuration.kind !== 'decoded' || budget.kind !== 'decoded') {
    throw new PlayerHistoricalReexecutionError(
      configuration.kind === 'unknownVersion' ||
        budget.kind === 'unknownVersion'
        ? 'unsupported_source_decision'
        : 'historical_source_integrity_violation',
    )
  }
  if (
    typeof value.runConfigPayloadVersion !== 'number' ||
    !Number.isSafeInteger(value.runConfigPayloadVersion) ||
    typeof value.budgetPayloadVersion !== 'number' ||
    !Number.isSafeInteger(value.budgetPayloadVersion)
  ) {
    throw new PlayerHistoricalReexecutionError(
      'historical_source_integrity_violation',
    )
  }
  if (
    configuration.value.runtime !== 'player' ||
    configuration.value.runtimeDefinitionVersion !==
      value.runtimeDefinitionVersion
  ) {
    throw new PlayerHistoricalReexecutionError(
      'historical_source_integrity_violation',
    )
  }
  const snapshot = readCurrentPayload({
    version: value.auditPayloadVersion,
    payload: value.auditPayload,
    reader: playerDecisionAuditSnapshotCodec.read,
  })
  const candidates = readCurrentPayload({
    version: value.candidatePayloadVersion,
    payload: value.candidatePayload,
    reader: playerCandidateSetSnapshotCodec.read,
  })
  const projection = readCurrentPayload({
    version: value.projectionPayloadVersion,
    payload: value.projectionPayload,
    reader: playerModelProjectionCodec.read,
  })
  if (
    snapshot.binding.sessionId !== value.sessionId ||
    snapshot.binding.handId !== value.handId ||
    snapshot.binding.actorParticipantId !== value.participantId ||
    snapshot.binding.stateVersion !== value.sourceStateVersion ||
    snapshot.binding.decisionRequestId !== value.decisionRequestId ||
    snapshot.candidates.candidateSetSha256 !== candidates.candidateSetSha256 ||
    snapshot.sessionMemory.memoryRevision !== value.memoryRevision ||
    snapshot.sessionMemory.payloadVersion !== value.memoryPayloadVersion ||
    snapshot.sessionMemory.memorySha256 !== value.memorySha256
  ) {
    throw new PlayerHistoricalReexecutionError(
      'historical_source_integrity_violation',
    )
  }
  try {
    return deepFreeze({
      row: value,
      source: certifyHistoricalReexecutionSourceV1({
        sourceRunId: value.sourceRunId,
        sourceDecisionId: value.sourceDecisionId,
        executionMode: value.executionMode,
        status: value.status,
        snapshotSha256: snapshot.snapshotSha256,
        candidateSetSha256: candidates.candidateSetSha256,
        projectionSha256: hashPlayerModelProjectionV1(projection),
        frozenModelInput: value.frozenModelInputPayload,
        frozenModelInputSha256: value.frozenModelInputSha256,
      }),
    })
  } catch (error) {
    if (error instanceof PlayerHistoricalReexecutionError) throw error
    throw new PlayerHistoricalReexecutionError(
      error instanceof HistoricalReexecutionSourceError &&
        error.code === 'unsupported_source_decision'
        ? 'unsupported_source_decision'
        : 'historical_source_integrity_violation',
    )
  }
}

export interface PlayerHistoricalReexecutionService {
  create(input: {
    readonly owner: ResolvedOwnerScope
    readonly sourceDecisionId: string
    readonly idempotencyKey: string
  }): Promise<{
    readonly kind: 'created' | 'existing'
    readonly runId: string
    readonly decisionId: string
  }>
}

export function createPlayerHistoricalReexecutionService(input: {
  readonly database: DatabaseClient
}): PlayerHistoricalReexecutionService {
  const service: PlayerHistoricalReexecutionService = {
    async create({ owner, sourceDecisionId, idempotencyKey }) {
      if (
        !UuidSchema.safeParse(sourceDecisionId).success ||
        typeof idempotencyKey !== 'string' ||
        idempotencyKey.trim().length === 0 ||
        idempotencyKey.length > 256
      ) {
        throw new PlayerHistoricalReexecutionError('invalid_input')
      }
      try {
        return await input.database.sql.begin(async (transaction) => {
          const sessionRows = await transaction`
            SELECT session.id::text AS "sessionId"
            FROM app_private.sessions AS session
            JOIN app_private.player_decisions AS decision
              ON decision.session_id = session.id AND decision.owner_id = session.owner_id
            WHERE decision.id = ${sourceDecisionId}::uuid
              AND decision.owner_id = ${owner.databaseOwnerId}::uuid
            FOR SHARE OF session
          `
          if (sessionRows.length === 0) throw new ResourceNotFoundError()
          const session = z
            .array(z.strictObject({ sessionId: UuidSchema }))
            .safeParse(sessionRows)
          if (!session.success || session.data.length !== 1) {
            throw new PersistenceDataCorruptionError('invalidPlayerDecision')
          }
          const sourceRows = await transaction`
            SELECT
              run.id::text AS "sourceRunId", decision.id::text AS "sourceDecisionId",
              run.session_id::text AS "sessionId", run.hand_id::text AS "handId",
              run.participant_id::text AS "participantId",
              run.source_state_version::float8 AS "sourceStateVersion",
              run.decision_request_id::text AS "decisionRequestId",
              run.execution_mode AS "executionMode", run.lifecycle,
              run.runtime_definition_version AS "runtimeDefinitionVersion",
              run.run_config_payload_version AS "runConfigPayloadVersion",
              run.run_config_payload AS "runConfigPayload",
              run.budget_payload_version AS "budgetPayloadVersion",
              run.budget_payload AS "budgetPayload",
              decision.status,
              decision.decision_audit_snapshot_payload_version AS "auditPayloadVersion",
              decision.decision_audit_snapshot_payload AS "auditPayload",
              decision.candidate_set_payload_version AS "candidatePayloadVersion",
              decision.candidate_set_payload AS "candidatePayload",
              decision.model_projection_payload_version AS "projectionPayloadVersion",
              decision.model_projection_payload AS "projectionPayload",
              decision.memory_revision::float8 AS "memoryRevision",
              decision.memory_payload_version AS "memoryPayloadVersion",
              decision.memory_sha256 AS "memorySha256",
              decision.frozen_model_input_payload_version AS "frozenModelInputPayloadVersion",
              decision.frozen_model_input_payload AS "frozenModelInputPayload",
              decision.frozen_model_input_sha256 AS "frozenModelInputSha256"
            FROM app_private.agent_runs AS run
            JOIN app_private.player_decisions AS decision
              ON decision.agent_run_id = run.id AND decision.owner_id = run.owner_id
            WHERE decision.id = ${sourceDecisionId}::uuid
              AND decision.owner_id = ${owner.databaseOwnerId}::uuid
              AND run.runtime = 'player'
              AND run.session_id = ${session.data[0]!.sessionId}::uuid
            FOR SHARE OF run, decision
          `
          if (sourceRows.length === 0) throw new ResourceNotFoundError()
          if (sourceRows.length !== 1) {
            throw new PersistenceDataCorruptionError('invalidPlayerDecision')
          }
          const decoded = decodeHistoricalSource(sourceRows[0])
          const existingRows = await transaction`
            SELECT run.id::text AS "runId", decision.id::text AS "decisionId",
                   decision.reexecution_source_decision_id::text AS "sourceDecisionId"
            FROM app_private.agent_runs AS run
            JOIN app_private.player_decisions AS decision ON decision.agent_run_id = run.id
            WHERE run.owner_id = ${owner.databaseOwnerId}::uuid
              AND run.session_id = ${decoded.row.sessionId}::uuid
              AND run.runtime = 'player'
              AND run.execution_mode = 'historicalReexecution'
              AND run.idempotency_key = ${idempotencyKey}
            FOR SHARE OF run, decision
          `
          if (existingRows.length > 0) {
            const existing = z
              .array(ExistingHistoricalRowSchema)
              .safeParse(existingRows)
            if (
              !existing.success ||
              existing.data.length !== 1 ||
              existing.data[0]?.sourceDecisionId !== sourceDecisionId
            ) {
              throw new PlayerHistoricalReexecutionError(
                'historical_reexecution_idempotency_conflict',
              )
            }
            return deepFreeze({
              kind: 'existing' as const,
              runId: existing.data[0].runId,
              decisionId: existing.data[0].decisionId,
            })
          }
          const runId = randomUUID()
          const decisionId = randomUUID()
          const insertedRun = await transaction`
            INSERT INTO app_private.agent_runs (
              id, owner_id, session_id, runtime, execution_mode, trigger_type,
              lifecycle, idempotency_key, hand_id, participant_id,
              source_state_version, decision_request_id, parent_run_id,
              replacement_run_id, reexecution_source_run_id, lease_owner,
              lease_expires_at, fencing_token, deadline_at,
              runtime_definition_version, termination_reason,
              run_config_payload_version, run_config_payload,
              budget_payload_version, budget_payload, created_at, started_at,
              completed_at, updated_at
            ) VALUES (
              ${runId}::uuid, ${owner.databaseOwnerId}::uuid,
              ${decoded.row.sessionId}::uuid, 'player', 'historicalReexecution',
              'historical_reexecution', 'queued', ${idempotencyKey},
              ${decoded.row.handId}::uuid, ${decoded.row.participantId}::uuid,
              ${decoded.row.sourceStateVersion}::bigint,
              ${randomUUID()}::uuid, NULL, NULL, ${decoded.source.sourceRunId}::uuid,
              NULL, NULL, 0, clock_timestamp() + interval '45 seconds',
              ${decoded.row.runtimeDefinitionVersion}, NULL,
              ${decoded.row.runConfigPayloadVersion as number},
              ${transaction.json(decoded.row.runConfigPayload as JsonValue)},
              ${decoded.row.budgetPayloadVersion as number},
              ${transaction.json(decoded.row.budgetPayload as JsonValue)},
              clock_timestamp(), NULL, NULL, clock_timestamp()
            )
            ON CONFLICT (session_id, runtime, idempotency_key) DO NOTHING
            RETURNING id::text AS "runId", decision_request_id::text AS "decisionRequestId"
          `
          const insertedRunRow = z
            .array(
              z.strictObject({
                runId: UuidSchema,
                decisionRequestId: UuidSchema,
              }),
            )
            .safeParse(insertedRun)
          if (!insertedRunRow.success) {
            throw new PersistenceDataCorruptionError('invalidAgentRunAudit')
          }
          if (insertedRunRow.data.length === 0) {
            // 两个事务都通过了预查时，以唯一约束裁决。冲突事务必须返回获胜者
            // 的既有重演，而不是把正常幂等竞争泄露为数据库错误。
            const racedRows = await transaction`
              SELECT run.id::text AS "runId", decision.id::text AS "decisionId",
                     decision.reexecution_source_decision_id::text AS "sourceDecisionId"
              FROM app_private.agent_runs AS run
              JOIN app_private.player_decisions AS decision ON decision.agent_run_id = run.id
              WHERE run.owner_id = ${owner.databaseOwnerId}::uuid
                AND run.session_id = ${decoded.row.sessionId}::uuid
                AND run.runtime = 'player'
                AND run.execution_mode = 'historicalReexecution'
                AND run.idempotency_key = ${idempotencyKey}
              FOR SHARE OF run, decision
            `
            const raced = z
              .array(ExistingHistoricalRowSchema)
              .safeParse(racedRows)
            if (
              !raced.success ||
              raced.data.length !== 1 ||
              raced.data[0]?.sourceDecisionId !== sourceDecisionId
            ) {
              throw new PlayerHistoricalReexecutionError(
                'historical_reexecution_idempotency_conflict',
              )
            }
            return deepFreeze({
              kind: 'existing' as const,
              runId: raced.data[0].runId,
              decisionId: raced.data[0].decisionId,
            })
          }
          if (
            insertedRunRow.data.length !== 1 ||
            insertedRunRow.data[0]?.runId !== runId
          ) {
            throw new PersistenceDataCorruptionError('invalidAgentRunAudit')
          }
          const insertedDecision = await transaction`
            INSERT INTO app_private.player_decisions (
              id, agent_run_id, owner_id, session_id, hand_id, participant_id,
              source_state_version, decision_request_id, runtime, execution_mode,
              reexecution_source_decision_id, source_snapshot_sha256,
              source_candidate_set_sha256, source_projection_sha256,
              source_model_input_sha256, record_version, status,
              decision_audit_snapshot_payload_version,
              decision_audit_snapshot_payload, candidate_set_payload_version,
              candidate_set_payload, memory_revision, memory_payload_version,
              memory_sha256, model_prepared_at, created_at, updated_at
            ) VALUES (
              ${decisionId}::uuid, ${runId}::uuid, ${owner.databaseOwnerId}::uuid,
              ${decoded.row.sessionId}::uuid, ${decoded.row.handId}::uuid,
              ${decoded.row.participantId}::uuid, ${decoded.row.sourceStateVersion}::bigint,
              ${insertedRunRow.data[0].decisionRequestId}::uuid, 'player',
              'historicalReexecution', ${decoded.source.sourceDecisionId}::uuid,
              ${decoded.source.snapshotSha256}, ${decoded.source.candidateSetSha256},
              ${decoded.source.projectionSha256}, ${decoded.source.frozenModelInputSha256},
              1, 'modelPrepared', NULL, NULL, NULL, NULL,
              ${decoded.row.memoryRevision}::bigint, 1, ${decoded.row.memorySha256},
              clock_timestamp(), clock_timestamp(), clock_timestamp()
            )
            RETURNING id::text AS "decisionId"
          `
          const insertedDecisionRow = z
            .array(z.strictObject({ decisionId: UuidSchema }))
            .safeParse(insertedDecision)
          if (
            !insertedDecisionRow.success ||
            insertedDecisionRow.data.length !== 1 ||
            insertedDecisionRow.data[0]?.decisionId !== decisionId
          ) {
            throw new PersistenceDataCorruptionError('invalidPlayerDecision')
          }
          return deepFreeze({
            kind: 'created' as const,
            runId,
            decisionId,
          })
        })
      } catch (error) {
        if (
          error instanceof PlayerHistoricalReexecutionError ||
          error instanceof ResourceNotFoundError ||
          error instanceof PersistenceDataCorruptionError
        ) {
          throw error
        }
        throw new DatabaseOperationError()
      }
    },
  }
  return Object.freeze(service)
}
