import type { TransactionSql } from 'postgres'
import { z } from 'zod'
import {
  currentExecutionBudgetAuditReader,
  encodeExecutionBudgetAudit,
} from '../agents/audit/execution-budget-audit-codec.js'
import {
  encodeAttemptAudit,
  readCurrentAttemptAudit,
} from '../agents/audit/attempt-audit-codec.js'
import {
  currentRunConfigurationAuditReader,
  encodeRunConfigurationAudit,
} from '../agents/audit/run-configuration-audit-codec.js'
import {
  type AgentRunCancellationInput,
  type AgentRunClaimDiagnostic,
  type AgentRunClaimInput,
  type AgentRunFinalizationInput,
  type LeasedAgentRun,
  type PersistedAgentRun,
  type TerminalAgentRunLifecycle,
} from '../agents/foundation/agent-run-types.js'
import {
  AgentRunCreationError,
  AgentRunTransitionError,
} from '../agents/foundation/agent-run-lifecycle.js'
import {
  isRuntimeCommitAuthority,
  type RuntimeCommitAuthority,
} from '../agents/foundation/runtime-ports.js'
import type { RuntimeType } from '../agents/foundation/runtime-definition.js'
import {
  DatabaseOperationError,
  PersistenceDataCorruptionError,
  RepositoryInputValidationError,
  ResourceNotFoundError,
  UnknownPayloadVersionError,
} from './errors.js'
import { isResolvedOwnerScope, type ResolvedOwnerScope } from './owner-scope.js'

export const AGENT_RUN_LEASE_MS = 15_000
export const AGENT_WORKER_CLAIM_BATCH_SIZE = 16
const RUNTIME_ADVISORY_KEYS: Readonly<Record<RuntimeType, number>> =
  Object.freeze({ player: 1_296_312_912, coach: 1_296_312_899 })

const RuntimeSchema = z.enum(['player', 'coach'])
const LifecycleSchema = z.enum([
  'queued',
  'leased',
  'running',
  'completed',
  'failed',
  'cancelled',
  'stale',
])
const DatabaseTimestampSchema = z.iso.datetime({ precision: 6 })
const CanonicalTimestampSchema = z.iso.datetime({ precision: 3 })
const SafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const PositiveIntegerSchema = z.number().int().positive().max(2_147_483_647)
const LeaseOwnerSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const StableCodeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/)
const RunRowSchema = z.strictObject({
  runId: z.uuid(),
  databaseOwnerId: z.uuid(),
  sessionId: z.uuid(),
  handId: z.uuid(),
  runtimeType: RuntimeSchema,
  triggerType: StableCodeSchema,
  lifecycle: LifecycleSchema,
  idempotencyKey: z.string().min(1).max(256),
  participantId: z.uuid().nullable(),
  sourceStateVersion: SafeIntegerSchema.nullable(),
  decisionRequestId: z.uuid().nullable(),
  parentRunId: z.uuid().nullable(),
  replacementRunId: z.uuid().nullable(),
  leaseOwner: LeaseOwnerSchema.nullable(),
  leaseExpiresAt: DatabaseTimestampSchema.nullable(),
  fencingToken: SafeIntegerSchema,
  deadlineAt: DatabaseTimestampSchema,
  runtimeDefinitionVersion: PositiveIntegerSchema,
  terminationReason: StableCodeSchema.nullable(),
  runConfigPayloadVersion: z.unknown(),
  runConfigPayload: z.unknown(),
  budgetPayloadVersion: z.unknown(),
  budgetPayload: z.unknown(),
  createdAt: DatabaseTimestampSchema,
  startedAt: DatabaseTimestampSchema.nullable(),
  completedAt: DatabaseTimestampSchema.nullable(),
  updatedAt: DatabaseTimestampSchema,
})

const CapacityRowSchema = z.strictObject({
  databaseOwnerId: z.uuid(),
  budgetPayloadVersion: z.unknown(),
  budgetPayload: z.unknown(),
})

const StartedAttemptRowSchema = z.strictObject({
  attemptId: z.uuid(),
  payloadVersion: z.unknown(),
  payload: z.unknown(),
})

export interface PreparedAgentRunInsert {
  readonly agentRunId: string
  readonly runtimeType: RuntimeType
  readonly sessionId: string
  readonly handId: string
  readonly participantId: string | null
  readonly sourceStateVersion: number | null
  readonly decisionRequestId: string | null
  readonly triggerType: string
  readonly idempotencyKey: string
  readonly parentRunId: string | null
  readonly deadlineAt: string
  readonly runtimeDefinitionVersion: number
  readonly runConfiguration: unknown
  readonly budget: unknown
  readonly createdAt: string
}

export type ClaimCandidateDecision =
  | { readonly kind: 'eligible' }
  | { readonly kind: 'rejected'; readonly diagnostic: AgentRunClaimDiagnostic }

export interface ClaimedAgentRun {
  readonly run: LeasedAgentRun
}

export type ClaimNextRepositoryResult =
  | { readonly kind: 'claimed'; readonly value: ClaimedAgentRun }
  | {
      readonly kind: 'none'
      readonly diagnostics: readonly AgentRunClaimDiagnostic[]
    }

export interface AgentRunLifecycleRepository {
  createOrReuse(
    transaction: TransactionSql,
    owner: ResolvedOwnerScope,
    input: PreparedAgentRunInsert,
  ): Promise<{
    readonly kind: 'created' | 'existing'
    readonly run: PersistedAgentRun
  }>
  claimNext(
    transaction: TransactionSql,
    owner: ResolvedOwnerScope,
    input: AgentRunClaimInput,
    validate: (candidate: PersistedAgentRun) => ClaimCandidateDecision,
  ): Promise<ClaimNextRepositoryResult>
  markRunning(
    transaction: TransactionSql,
    owner: ResolvedOwnerScope,
    authority: RuntimeCommitAuthority,
  ): Promise<LeasedAgentRun>
  renewLease(
    transaction: TransactionSql,
    owner: ResolvedOwnerScope,
    authority: RuntimeCommitAuthority,
  ): Promise<LeasedAgentRun>
  inspectSettlement(
    transaction: TransactionSql,
    owner: ResolvedOwnerScope,
    authority: RuntimeCommitAuthority,
  ): Promise<'terminal' | 'authorityLost' | 'activeUnsettled'>
  cancel(
    transaction: TransactionSql,
    owner: ResolvedOwnerScope,
    input: AgentRunCancellationInput,
  ): Promise<{ readonly run: PersistedAgentRun; readonly changed: boolean }>
  finalize(
    transaction: TransactionSql,
    owner: ResolvedOwnerScope,
    input: AgentRunFinalizationInput,
  ): Promise<{ readonly run: PersistedAgentRun; readonly changed: boolean }>
  lockPlayerRunForCoordination(
    transaction: TransactionSql,
    owner: ResolvedOwnerScope,
    runId: string,
  ): Promise<PersistedAgentRun<'player'>>
  loadFailedPlayerLeafForRetry(
    transaction: TransactionSql,
    owner: ResolvedOwnerScope,
    input: {
      readonly sessionId: string
      readonly handId: string
      readonly participantId: string
      readonly sourceStateVersion: number
    },
  ): Promise<PersistedAgentRun<'player'> | null>
  terminateForCoordination(
    transaction: TransactionSql,
    owner: ResolvedOwnerScope,
    input: {
      readonly runId: string
      readonly lifecycle: 'failed' | 'cancelled' | 'stale'
      readonly terminationReason: string
      readonly completedAt: string
    },
  ): Promise<PersistedAgentRun<'player'>>
  linkReplacement(
    transaction: TransactionSql,
    owner: ResolvedOwnerScope,
    input: {
      readonly predecessorRunId: string
      readonly replacementRunId: string
    },
  ): Promise<void>
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

function selectRunColumns(alias = 'run'): string {
  return `
    ${alias}.id::text AS "runId",
    ${alias}.owner_id::text AS "databaseOwnerId",
    ${alias}.session_id::text AS "sessionId",
    ${alias}.hand_id::text AS "handId",
    ${alias}.runtime AS "runtimeType",
    ${alias}.trigger_type AS "triggerType",
    ${alias}.lifecycle,
    ${alias}.idempotency_key AS "idempotencyKey",
    ${alias}.participant_id::text AS "participantId",
    ${alias}.source_state_version::float8 AS "sourceStateVersion",
    ${alias}.decision_request_id::text AS "decisionRequestId",
    ${alias}.parent_run_id::text AS "parentRunId",
    ${alias}.replacement_run_id::text AS "replacementRunId",
    ${alias}.lease_owner AS "leaseOwner",
    CASE WHEN ${alias}.lease_expires_at IS NULL THEN NULL ELSE
      to_char(${alias}.lease_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    END AS "leaseExpiresAt",
    ${alias}.fencing_token::float8 AS "fencingToken",
    to_char(${alias}.deadline_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "deadlineAt",
    ${alias}.runtime_definition_version AS "runtimeDefinitionVersion",
    ${alias}.termination_reason AS "terminationReason",
    ${alias}.run_config_payload_version AS "runConfigPayloadVersion",
    ${alias}.run_config_payload AS "runConfigPayload",
    ${alias}.budget_payload_version AS "budgetPayloadVersion",
    ${alias}.budget_payload AS "budgetPayload",
    to_char(${alias}.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
    CASE WHEN ${alias}.started_at IS NULL THEN NULL ELSE
      to_char(${alias}.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    END AS "startedAt",
    CASE WHEN ${alias}.completed_at IS NULL THEN NULL ELSE
      to_char(${alias}.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    END AS "completedAt",
    to_char(${alias}.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt"
  `
}

const RUN_COLUMNS = selectRunColumns()

function decodeRow(
  value: unknown,
  owner: ResolvedOwnerScope,
):
  | { readonly kind: 'valid'; readonly run: PersistedAgentRun }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'invalid' } {
  const parsed = RunRowSchema.safeParse(value)
  if (
    !parsed.success ||
    parsed.data.databaseOwnerId !== owner.databaseOwnerId
  ) {
    return { kind: 'invalid' }
  }
  const row = parsed.data
  const configuration = currentRunConfigurationAuditReader.read(
    row.runConfigPayloadVersion,
    row.runConfigPayload,
  )
  const budget = currentExecutionBudgetAuditReader.read(
    row.budgetPayloadVersion,
    row.budgetPayload,
  )
  if (
    configuration.kind === 'unknownVersion' ||
    budget.kind === 'unknownVersion'
  ) {
    return { kind: 'unknown' }
  }
  if (
    configuration.kind === 'invalidPayload' ||
    budget.kind === 'invalidPayload'
  ) {
    return { kind: 'invalid' }
  }
  if (
    configuration.value.runtime !== row.runtimeType ||
    configuration.value.runtimeDefinitionVersion !==
      row.runtimeDefinitionVersion
  ) {
    return { kind: 'invalid' }
  }
  const base = {
    ownerId: owner.ownerId,
    runId: row.runId,
    runtimeType: row.runtimeType,
    sessionId: row.sessionId,
    handId: row.handId,
    triggerType: row.triggerType,
    lifecycle: row.lifecycle,
    idempotencyKey: row.idempotencyKey,
    parentRunId: row.parentRunId,
    replacementRunId: row.replacementRunId,
    leaseOwner: row.leaseOwner,
    leaseExpiresAt: row.leaseExpiresAt,
    fencingToken: row.fencingToken,
    deadlineAt: row.deadlineAt,
    runtimeDefinitionVersion: row.runtimeDefinitionVersion,
    terminationReason: row.terminationReason,
    runConfiguration: configuration.value,
    budget: budget.value,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    updatedAt: row.updatedAt,
  }
  if (row.runtimeType === 'player') {
    if (
      row.participantId === null ||
      row.sourceStateVersion === null ||
      row.decisionRequestId === null
    ) {
      return { kind: 'invalid' }
    }
    return {
      kind: 'valid',
      run: deepFreeze({
        ...base,
        runtimeType: 'player' as const,
        participantId: row.participantId,
        sourceStateVersion: row.sourceStateVersion,
        decisionRequestId: row.decisionRequestId,
      }),
    }
  }
  if (
    row.participantId !== null ||
    row.sourceStateVersion !== null ||
    row.decisionRequestId !== null
  ) {
    return { kind: 'invalid' }
  }
  return {
    kind: 'valid',
    run: deepFreeze({
      ...base,
      runtimeType: 'coach' as const,
      participantId: null,
      sourceStateVersion: null,
      decisionRequestId: null,
    }),
  }
}

function requireDecodedRow(
  value: unknown,
  owner: ResolvedOwnerScope,
): PersistedAgentRun {
  const decoded = decodeRow(value, owner)
  if (decoded.kind === 'unknown') {
    throw new UnknownPayloadVersionError('agentRunConfiguration')
  }
  if (decoded.kind === 'invalid') {
    throw new PersistenceDataCorruptionError('invalidAgentRunAudit')
  }
  return decoded.run
}

function decodeCapacityRow(value: unknown):
  | {
      readonly kind: 'valid'
      readonly databaseOwnerId: string
      readonly budget: PersistedAgentRun['budget']
    }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'invalid' } {
  const parsed = CapacityRowSchema.safeParse(value)
  if (!parsed.success) return { kind: 'invalid' }
  const budget = currentExecutionBudgetAuditReader.read(
    parsed.data.budgetPayloadVersion,
    parsed.data.budgetPayload,
  )
  if (budget.kind === 'unknownVersion') return { kind: 'unknown' }
  if (budget.kind === 'invalidPayload') return { kind: 'invalid' }
  return {
    kind: 'valid',
    databaseOwnerId: parsed.data.databaseOwnerId,
    budget: budget.value,
  }
}

async function terminateStartedAttempts(
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
  input: {
    readonly runId: string
    readonly lifecycle: 'failed' | 'cancelled' | 'stale'
    readonly errorCategory: string
    readonly completedAt: string
  },
): Promise<void> {
  let rows: readonly unknown[]
  try {
    rows = await transaction`
      SELECT
        id::text AS "attemptId",
        attempt_payload_version AS "payloadVersion",
        attempt_payload AS "payload"
      FROM app_private.agent_attempts
      WHERE agent_run_id = ${input.runId}::uuid
        AND owner_id = ${owner.databaseOwnerId}::uuid
        AND lifecycle = 'started'
      FOR UPDATE
    `
  } catch {
    throw new DatabaseOperationError()
  }
  const startedRows = z.array(StartedAttemptRowSchema).safeParse(rows)
  if (!startedRows.success) {
    throw new PersistenceDataCorruptionError('invalidAgentAttemptAudit')
  }
  for (const row of startedRows.data) {
    const started = readCurrentAttemptAudit(
      'started',
      row.payloadVersion,
      row.payload,
    )
    if (started.kind === 'unknownVersion') {
      throw new UnknownPayloadVersionError('agentAttempt')
    }
    if (started.kind === 'invalidPayload') {
      throw new PersistenceDataCorruptionError('invalidAgentAttemptAudit')
    }
    const terminal = encodeAttemptAudit({
      lifecycle: input.lifecycle,
      actualTimeoutMs: started.value.actualTimeoutMs,
      remainingDeadlineMsAtStart: started.value.remainingDeadlineMsAtStart,
      requestProjectionHash: started.value.requestProjectionHash,
      reservedInputTokens: started.value.reservedInputTokens,
      reservedOutputTokens: started.value.reservedOutputTokens,
      reservedCostMicrounits: started.value.reservedCostMicrounits,
      responseProjectionHash: null,
      validationStatus: 'notRun',
      usageAccounting: 'reservedUpperBound',
      costAccounting: 'reservedUpperBound',
    })
    const payload = transaction.json(terminal.payload)
    let updatedRows: readonly unknown[]
    try {
      updatedRows = await transaction`
        UPDATE app_private.agent_attempts
        SET lifecycle = ${input.lifecycle}, accepted = false,
            stale = ${input.lifecycle === 'stale'}, interrupted = true,
            error_category = ${input.errorCategory},
            attempt_payload_version = ${terminal.payloadVersion},
            attempt_payload = ${payload},
            completed_at = ${input.completedAt}::timestamptz
        WHERE id = ${row.attemptId}::uuid
          AND agent_run_id = ${input.runId}::uuid
          AND owner_id = ${owner.databaseOwnerId}::uuid
          AND lifecycle = 'started'
        RETURNING id::text AS "attemptId"
      `
    } catch {
      throw new DatabaseOperationError()
    }
    const updated = z
      .array(z.strictObject({ attemptId: z.uuid() }))
      .safeParse(updatedRows)
    if (
      !updated.success ||
      updated.data.length !== 1 ||
      updated.data[0]?.attemptId !== row.attemptId
    ) {
      throw new AgentRunTransitionError('agent_run_transition_rejected')
    }
  }
}

function assertRepositoryInput(
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
): void {
  if (typeof transaction !== 'function' || !isResolvedOwnerScope(owner)) {
    throw new RepositoryInputValidationError()
  }
}

async function readExactRun(
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
  runId: string,
  lock = false,
): Promise<PersistedAgentRun> {
  let rows: readonly unknown[]
  try {
    rows = lock
      ? await transaction.unsafe(
          `SELECT ${RUN_COLUMNS} FROM app_private.agent_runs AS run WHERE run.id = $1::uuid AND run.owner_id = $2::uuid FOR UPDATE`,
          [runId, owner.databaseOwnerId],
        )
      : await transaction.unsafe(
          `SELECT ${RUN_COLUMNS} FROM app_private.agent_runs AS run WHERE run.id = $1::uuid AND run.owner_id = $2::uuid`,
          [runId, owner.databaseOwnerId],
        )
  } catch {
    throw new DatabaseOperationError()
  }
  if (rows.length === 0) throw new ResourceNotFoundError()
  if (rows.length !== 1) {
    throw new PersistenceDataCorruptionError('invalidAgentRunAudit')
  }
  return requireDecodedRow(rows[0], owner)
}

function sameCreationIdentity(
  run: PersistedAgentRun,
  input: PreparedAgentRunInsert,
): boolean {
  return (
    run.runtimeType === input.runtimeType &&
    run.sessionId === input.sessionId &&
    run.handId === input.handId &&
    run.participantId === input.participantId &&
    run.sourceStateVersion === input.sourceStateVersion &&
    run.decisionRequestId === input.decisionRequestId &&
    run.triggerType === input.triggerType &&
    run.parentRunId === input.parentRunId
  )
}

async function readDatabaseNow(transaction: TransactionSql): Promise<string> {
  let rows: readonly unknown[]
  try {
    rows = await transaction`
      SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "databaseNow"
    `
  } catch {
    throw new DatabaseOperationError()
  }
  const parsed = z
    .array(z.strictObject({ databaseNow: DatabaseTimestampSchema }))
    .safeParse(rows)
  if (
    !parsed.success ||
    parsed.data.length !== 1 ||
    parsed.data[0] === undefined
  ) {
    throw new PersistenceDataCorruptionError('invalidAgentRunAudit')
  }
  return parsed.data[0].databaseNow
}

function authorityMatches(
  authority: RuntimeCommitAuthority,
  run: PersistedAgentRun,
): boolean {
  return (
    isRuntimeCommitAuthority(authority, run.runtimeType) &&
    authority.runId === run.runId &&
    authority.leaseOwner === run.leaseOwner &&
    authority.fencingToken === run.fencingToken
  )
}

export function createAgentRunLifecycleRepository(): AgentRunLifecycleRepository {
  const repository: AgentRunLifecycleRepository = {
    async createOrReuse(transaction, owner, input) {
      assertRepositoryInput(transaction, owner)
      const parsed = z
        .strictObject({
          agentRunId: z.uuid(),
          runtimeType: RuntimeSchema,
          sessionId: z.uuid(),
          handId: z.uuid(),
          participantId: z.uuid().nullable(),
          sourceStateVersion: SafeIntegerSchema.nullable(),
          decisionRequestId: z.uuid().nullable(),
          triggerType: StableCodeSchema,
          idempotencyKey: z.string().min(1).max(256),
          parentRunId: z.uuid().nullable(),
          deadlineAt: CanonicalTimestampSchema,
          runtimeDefinitionVersion: PositiveIntegerSchema,
          runConfiguration: z.unknown(),
          budget: z.unknown(),
          createdAt: CanonicalTimestampSchema,
        })
        .safeParse(input)
      if (!parsed.success) {
        throw new AgentRunCreationError('invalid_agent_run_input')
      }
      const value = parsed.data
      if (
        (value.runtimeType === 'player') !==
          (value.participantId !== null &&
            value.sourceStateVersion !== null &&
            value.decisionRequestId !== null) ||
        Date.parse(value.deadlineAt) < Date.parse(value.createdAt)
      ) {
        throw new AgentRunCreationError('invalid_agent_run_input')
      }
      let configuration
      let budget
      try {
        configuration = encodeRunConfigurationAudit(value.runConfiguration)
        budget = encodeExecutionBudgetAudit(value.budget)
      } catch {
        throw new AgentRunCreationError('runtime_snapshot_unavailable')
      }
      if (
        configuration.payload.configuration.runtime !== value.runtimeType ||
        configuration.payload.configuration.runtimeDefinitionVersion !==
          value.runtimeDefinitionVersion
      ) {
        throw new AgentRunCreationError('runtime_snapshot_unavailable')
      }
      const configurationPayload = transaction.json(configuration.payload)
      const budgetPayload = transaction.json(budget.payload)
      let inserted: readonly unknown[]
      try {
        inserted = await transaction`
          INSERT INTO app_private.agent_runs (
            id, owner_id, session_id, runtime, trigger_type, lifecycle,
            idempotency_key, hand_id, participant_id, source_state_version,
            decision_request_id, parent_run_id, replacement_run_id,
            lease_owner, lease_expires_at, fencing_token, deadline_at,
            runtime_definition_version, termination_reason,
            run_config_payload_version, run_config_payload,
            budget_payload_version, budget_payload,
            created_at, started_at, completed_at, updated_at
          ) VALUES (
            ${value.agentRunId}::uuid, ${owner.databaseOwnerId}::uuid,
            ${value.sessionId}::uuid, ${value.runtimeType}, ${value.triggerType},
            'queued', ${value.idempotencyKey}, ${value.handId}::uuid,
            ${value.participantId}::uuid, ${value.sourceStateVersion}::bigint,
            ${value.decisionRequestId}::uuid, ${value.parentRunId}::uuid, NULL,
            NULL, NULL, 0, ${value.deadlineAt}::timestamptz,
            ${value.runtimeDefinitionVersion}, NULL,
            ${configuration.payloadVersion}, ${configurationPayload},
            ${budget.payloadVersion}, ${budgetPayload},
            ${value.createdAt}::timestamptz,
            NULL, NULL, ${value.createdAt}::timestamptz
          )
          ON CONFLICT DO NOTHING
          RETURNING id::text AS "runId"
        `
      } catch {
        throw new DatabaseOperationError()
      }
      if (inserted.length === 1) {
        return Object.freeze({
          kind: 'created' as const,
          run: await readExactRun(transaction, owner, value.agentRunId),
        })
      }
      let existingRows: readonly unknown[]
      try {
        existingRows = await transaction.unsafe(
          `SELECT ${RUN_COLUMNS} FROM app_private.agent_runs AS run
           WHERE run.owner_id = $1::uuid AND run.session_id = $2::uuid
             AND run.runtime = $3 AND run.idempotency_key = $4
           FOR UPDATE`,
          [
            owner.databaseOwnerId,
            value.sessionId,
            value.runtimeType,
            value.idempotencyKey,
          ],
        )
      } catch {
        throw new DatabaseOperationError()
      }
      if (existingRows.length === 1) {
        const run = requireDecodedRow(existingRows[0], owner)
        if (!sameCreationIdentity(run, value)) {
          throw new AgentRunCreationError('agent_run_idempotency_conflict')
        }
        return Object.freeze({ kind: 'existing' as const, run })
      }
      if (value.runtimeType === 'player') {
        let activeRows: readonly unknown[]
        try {
          activeRows = await transaction.unsafe(
            `SELECT ${RUN_COLUMNS} FROM app_private.agent_runs AS run
             WHERE run.owner_id = $1::uuid AND run.session_id = $2::uuid
               AND run.runtime = 'player'
               AND run.source_state_version = $3::bigint
               AND run.participant_id = $4::uuid
               AND run.lifecycle IN ('queued', 'leased', 'running')
             FOR UPDATE`,
            [
              owner.databaseOwnerId,
              value.sessionId,
              value.sourceStateVersion,
              value.participantId,
            ],
          )
        } catch {
          throw new DatabaseOperationError()
        }
        if (activeRows.length === 1) {
          const run = requireDecodedRow(activeRows[0], owner)
          if (sameCreationIdentity(run, value)) {
            return Object.freeze({ kind: 'existing' as const, run })
          }
          throw new AgentRunCreationError('active_player_run_conflict')
        }
      }
      throw new AgentRunCreationError('invalid_agent_run_input')
    },

    async claimNext(
      transaction,
      owner,
      input,
      validate,
    ): Promise<ClaimNextRepositoryResult> {
      assertRepositoryInput(transaction, owner)
      const parsed = z
        .strictObject({
          runtimeType: RuntimeSchema,
          leaseOwner: LeaseOwnerSchema,
        })
        .safeParse(input)
      if (!parsed.success) throw new RepositoryInputValidationError()
      try {
        await transaction`SELECT pg_advisory_xact_lock(${RUNTIME_ADVISORY_KEYS[parsed.data.runtimeType]})`
      } catch {
        throw new DatabaseOperationError()
      }
      const databaseNow = await readDatabaseNow(transaction)
      const diagnostics: AgentRunClaimDiagnostic[] = []
      let inFlightRows: readonly unknown[]
      try {
        inFlightRows = await transaction.unsafe(
          `SELECT owner_id::text AS "databaseOwnerId",
                  budget_payload_version AS "budgetPayloadVersion",
                  budget_payload AS "budgetPayload"
           FROM app_private.agent_runs
           WHERE runtime = $1 AND lifecycle IN ('leased', 'running')
             AND lease_expires_at > $2::timestamptz`,
          [parsed.data.runtimeType, databaseNow],
        )
      } catch {
        throw new DatabaseOperationError()
      }
      const inFlight: Array<{
        readonly databaseOwnerId: string
        readonly budget: PersistedAgentRun['budget']
      }> = []
      for (const row of inFlightRows) {
        const decoded = decodeCapacityRow(row)
        if (decoded.kind !== 'valid') {
          const unavailable: ClaimNextRepositoryResult = {
            kind: 'none' as const,
            diagnostics: [
              (decoded.kind === 'unknown'
                ? 'agent_run_payload_unknown'
                : 'agent_run_payload_invalid') satisfies AgentRunClaimDiagnostic,
            ],
          }
          return deepFreeze(unavailable)
        }
        inFlight.push({
          databaseOwnerId: decoded.databaseOwnerId,
          budget: decoded.budget,
        })
      }
      let watermarkRows: readonly unknown[]
      try {
        watermarkRows = await transaction`
          SELECT
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
            id::text AS "runId"
          FROM app_private.agent_runs
          WHERE runtime = ${parsed.data.runtimeType}
            AND (
              lifecycle = 'queued'
              OR (
                lifecycle IN ('leased', 'running')
                AND lease_expires_at <= ${databaseNow}::timestamptz
              )
            )
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `
      } catch {
        throw new DatabaseOperationError()
      }
      const WatermarkSchema = z.strictObject({
        createdAt: DatabaseTimestampSchema,
        runId: z.uuid(),
      })
      const CandidateCursorSchema = z.object({
        createdAt: DatabaseTimestampSchema,
        runId: z.uuid(),
      })
      if (watermarkRows.length === 0) {
        return Object.freeze({
          kind: 'none' as const,
          diagnostics: Object.freeze([]) as readonly AgentRunClaimDiagnostic[],
        })
      }
      const watermark = WatermarkSchema.safeParse(watermarkRows[0])
      if (!watermark.success) {
        throw new PersistenceDataCorruptionError('invalidAgentRunAudit')
      }
      let cursor: z.infer<typeof WatermarkSchema> | null = null
      for (;;) {
        let candidateRows: readonly unknown[]
        const parameters: string[] = [
          parsed.data.runtimeType,
          databaseNow,
          watermark.data.createdAt,
          watermark.data.runId,
        ]
        const cursorClause =
          cursor === null
            ? ''
            : 'AND (run.created_at, run.id) > ($5::timestamptz, $6::uuid)'
        if (cursor !== null) parameters.push(cursor.createdAt, cursor.runId)
        try {
          candidateRows = await transaction.unsafe(
            `SELECT ${RUN_COLUMNS} FROM app_private.agent_runs AS run
             WHERE run.runtime = $1
               AND (run.lifecycle = 'queued' OR (
                 run.lifecycle IN ('leased', 'running')
                 AND run.lease_expires_at <= $2::timestamptz
               ))
               AND (run.created_at, run.id) <= ($3::timestamptz, $4::uuid)
               ${cursorClause}
             ORDER BY run.created_at, run.id
             LIMIT ${AGENT_WORKER_CLAIM_BATCH_SIZE}`,
            parameters,
          )
        } catch {
          throw new DatabaseOperationError()
        }
        if (candidateRows.length === 0) break
        for (const candidateRow of candidateRows) {
          const candidateCursor = CandidateCursorSchema.safeParse(candidateRow)
          if (!candidateCursor.success) {
            throw new PersistenceDataCorruptionError('invalidAgentRunAudit')
          }
          cursor = candidateCursor.data
          const raw = RunRowSchema.safeParse(candidateRow)
          if (!raw.success) {
            diagnostics.push('agent_run_payload_invalid')
            continue
          }
          const decoded = decodeRow(candidateRow, owner)
          if (decoded.kind !== 'valid') {
            diagnostics.push(
              decoded.kind === 'unknown'
                ? 'agent_run_payload_unknown'
                : 'agent_run_payload_invalid',
            )
            continue
          }
          const candidate = decoded.run
          if (candidate.fencingToken >= Number.MAX_SAFE_INTEGER) {
            diagnostics.push('agent_run_fencing_rejected')
            continue
          }
          if (
            candidate.lifecycle === 'queued' &&
            Date.parse(candidate.deadlineAt) <= Date.parse(databaseNow)
          ) {
            diagnostics.push('agent_run_deadline_expired')
            continue
          }
          const decision = validate(candidate)
          if (decision.kind === 'rejected') {
            diagnostics.push(decision.diagnostic)
            continue
          }
          const systemLimit = Math.min(
            candidate.budget.maxSystemConcurrentRuns,
            ...inFlight.map((run) => run.budget.maxSystemConcurrentRuns),
          )
          const ownerRuns = inFlight.filter(
            (run) => run.databaseOwnerId === owner.databaseOwnerId,
          )
          const ownerLimit = Math.min(
            candidate.budget.maxOwnerConcurrentRuns,
            ...ownerRuns.map((run) => run.budget.maxOwnerConcurrentRuns),
          )
          if (
            inFlight.length >= systemLimit ||
            ownerRuns.length >= ownerLimit
          ) {
            diagnostics.push('agent_run_capacity_unavailable')
            continue
          }
          let lockedRows: readonly unknown[]
          try {
            lockedRows = await transaction.unsafe(
              `SELECT ${RUN_COLUMNS} FROM app_private.agent_runs AS run
               WHERE run.id = $1::uuid AND run.owner_id = $2::uuid FOR UPDATE`,
              [candidate.runId, owner.databaseOwnerId],
            )
          } catch {
            throw new DatabaseOperationError()
          }
          if (lockedRows.length !== 1) continue
          const lockedDecoded = decodeRow(lockedRows[0], owner)
          if (lockedDecoded.kind !== 'valid') continue
          const locked = lockedDecoded.run
          const stillEligible =
            locked.runtimeType === parsed.data.runtimeType &&
            (locked.lifecycle === 'queued' ||
              ((locked.lifecycle === 'leased' ||
                locked.lifecycle === 'running') &&
                locked.leaseExpiresAt !== null &&
                Date.parse(locked.leaseExpiresAt) <= Date.parse(databaseNow)))
          if (
            !stillEligible ||
            locked.fencingToken >= Number.MAX_SAFE_INTEGER ||
            validate(locked).kind !== 'eligible'
          ) {
            continue
          }
          if (locked.lifecycle !== 'queued') {
            await terminateStartedAttempts(transaction, owner, {
              runId: locked.runId,
              lifecycle: 'stale',
              errorCategory: 'lease_replaced',
              completedAt: databaseNow,
            })
          }
          let updatedRows: readonly unknown[]
          try {
            updatedRows = await transaction.unsafe(
              `UPDATE app_private.agent_runs AS run
               SET lifecycle = 'leased', lease_owner = $1,
                   lease_expires_at = $2::timestamptz + ($3 * interval '1 millisecond'),
                   fencing_token = run.fencing_token + 1,
                   updated_at = $2::timestamptz
               WHERE run.id = $4::uuid AND run.owner_id = $5::uuid
                 AND run.fencing_token < 9007199254740991
                 AND (run.lifecycle = 'queued' OR (
                   run.lifecycle IN ('leased', 'running')
                   AND run.lease_expires_at <= $2::timestamptz
                 ))
               RETURNING ${RUN_COLUMNS}`,
              [
                parsed.data.leaseOwner,
                databaseNow,
                AGENT_RUN_LEASE_MS,
                locked.runId,
                owner.databaseOwnerId,
              ],
            )
          } catch {
            throw new DatabaseOperationError()
          }
          if (updatedRows.length !== 1) continue
          const claimed = requireDecodedRow(updatedRows[0], owner)
          if (
            (claimed.lifecycle !== 'leased' &&
              claimed.lifecycle !== 'running') ||
            claimed.leaseOwner === null ||
            claimed.leaseExpiresAt === null ||
            claimed.fencingToken <= 0
          ) {
            throw new PersistenceDataCorruptionError('invalidAgentRunAudit')
          }
          return Object.freeze({
            kind: 'claimed' as const,
            value: Object.freeze({
              run: claimed as LeasedAgentRun,
            }),
          })
        }
        if (cursor === null) break
        if (
          cursor.createdAt === watermark.data.createdAt &&
          cursor.runId === watermark.data.runId
        ) {
          break
        }
      }
      return Object.freeze({
        kind: 'none' as const,
        diagnostics: Object.freeze([
          ...new Set(diagnostics),
        ]) as readonly AgentRunClaimDiagnostic[],
      })
    },

    async markRunning(transaction, owner, authority) {
      assertRepositoryInput(transaction, owner)
      if (!isRuntimeCommitAuthority(authority, authority.runtimeType)) {
        throw new AgentRunTransitionError('agent_run_fencing_rejected')
      }
      let rows: readonly unknown[]
      try {
        rows = await transaction.unsafe(
          `UPDATE app_private.agent_runs AS run
           SET lifecycle = 'running', started_at = COALESCE(run.started_at, clock_timestamp()),
               updated_at = clock_timestamp()
           WHERE run.id = $1::uuid AND run.owner_id = $2::uuid
             AND run.runtime = $3 AND run.lifecycle = 'leased'
             AND run.lease_owner = $4 AND run.fencing_token = $5::bigint
             AND run.lease_expires_at > clock_timestamp()
           RETURNING ${RUN_COLUMNS}`,
          [
            authority.runId,
            owner.databaseOwnerId,
            authority.runtimeType,
            authority.leaseOwner,
            authority.fencingToken,
          ],
        )
      } catch {
        throw new DatabaseOperationError()
      }
      if (rows.length !== 1) {
        throw new AgentRunTransitionError('agent_run_fencing_rejected')
      }
      return requireDecodedRow(rows[0], owner) as LeasedAgentRun
    },

    async renewLease(transaction, owner, authority) {
      assertRepositoryInput(transaction, owner)
      if (!isRuntimeCommitAuthority(authority, authority.runtimeType)) {
        throw new AgentRunTransitionError('agent_run_fencing_rejected')
      }
      let rows: readonly unknown[]
      try {
        rows = await transaction.unsafe(
          `UPDATE app_private.agent_runs AS run
           SET lease_expires_at = clock_timestamp() + ($1 * interval '1 millisecond'),
               updated_at = clock_timestamp()
           WHERE run.id = $2::uuid AND run.owner_id = $3::uuid
             AND run.runtime = $4 AND run.lifecycle IN ('leased', 'running')
             AND run.lease_owner = $5 AND run.fencing_token = $6::bigint
             AND run.lease_expires_at > clock_timestamp()
           RETURNING ${RUN_COLUMNS}`,
          [
            AGENT_RUN_LEASE_MS,
            authority.runId,
            owner.databaseOwnerId,
            authority.runtimeType,
            authority.leaseOwner,
            authority.fencingToken,
          ],
        )
      } catch {
        throw new DatabaseOperationError()
      }
      if (rows.length !== 1) {
        throw new AgentRunTransitionError('agent_run_fencing_rejected')
      }
      return requireDecodedRow(rows[0], owner) as LeasedAgentRun
    },

    async inspectSettlement(transaction, owner, authority) {
      assertRepositoryInput(transaction, owner)
      if (!isRuntimeCommitAuthority(authority, authority.runtimeType)) {
        return 'authorityLost'
      }
      let run: PersistedAgentRun
      try {
        run = await readExactRun(transaction, owner, authority.runId)
      } catch (error) {
        if (error instanceof ResourceNotFoundError) return 'authorityLost'
        throw error
      }
      if (!['queued', 'leased', 'running'].includes(run.lifecycle)) {
        return 'terminal'
      }
      const databaseNow = await readDatabaseNow(transaction)
      if (
        !authorityMatches(authority, run) ||
        run.leaseExpiresAt === null ||
        Date.parse(run.leaseExpiresAt) <= Date.parse(databaseNow)
      ) {
        return 'authorityLost'
      }
      return 'activeUnsettled'
    },

    async cancel(transaction, owner, input) {
      assertRepositoryInput(transaction, owner)
      const parsed = z
        .strictObject({
          runId: z.uuid(),
          reason: z.enum(['user_cancelled', 'process_restart']),
          completedAt: CanonicalTimestampSchema,
        })
        .safeParse(input)
      if (!parsed.success) throw new RepositoryInputValidationError()
      const locked = await readExactRun(
        transaction,
        owner,
        parsed.data.runId,
        true,
      )
      if (locked.lifecycle === 'cancelled') {
        if (locked.terminationReason === parsed.data.reason) {
          return Object.freeze({ run: locked, changed: false })
        }
        throw new AgentRunTransitionError('agent_run_already_terminal')
      }
      if (!['queued', 'leased', 'running'].includes(locked.lifecycle)) {
        throw new AgentRunTransitionError('agent_run_already_terminal')
      }
      await terminateStartedAttempts(transaction, owner, {
        runId: parsed.data.runId,
        lifecycle: 'cancelled',
        errorCategory: parsed.data.reason,
        completedAt: parsed.data.completedAt,
      })
      let rows: readonly unknown[]
      try {
        rows = await transaction.unsafe(
          `UPDATE app_private.agent_runs AS run
           SET lifecycle = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
               termination_reason = $1, completed_at = $2::timestamptz,
               updated_at = $2::timestamptz
           WHERE run.id = $3::uuid AND run.owner_id = $4::uuid
             AND run.lifecycle IN ('queued', 'leased', 'running')
           RETURNING ${RUN_COLUMNS}`,
          [
            parsed.data.reason,
            parsed.data.completedAt,
            parsed.data.runId,
            owner.databaseOwnerId,
          ],
        )
      } catch {
        throw new DatabaseOperationError()
      }
      if (rows.length !== 1) {
        throw new AgentRunTransitionError('agent_run_transition_rejected')
      }
      return Object.freeze({
        run: requireDecodedRow(rows[0], owner),
        changed: true,
      })
    },

    async finalize(transaction, owner, input) {
      assertRepositoryInput(transaction, owner)
      const parsed = z
        .strictObject({
          runId: z.uuid(),
          authority: z.unknown(),
          lifecycle: z.enum(['completed', 'failed', 'cancelled', 'stale']),
          terminationReason: StableCodeSchema.nullable(),
          completedAt: CanonicalTimestampSchema,
        })
        .safeParse(input)
      if (!parsed.success || parsed.data.runId !== input.authority.runId) {
        throw new RepositoryInputValidationError()
      }
      const lifecycle = parsed.data.lifecycle as TerminalAgentRunLifecycle
      if (
        (lifecycle === 'completed') !==
          (parsed.data.terminationReason === null) ||
        (lifecycle !== 'completed' && parsed.data.terminationReason === null)
      ) {
        throw new RepositoryInputValidationError()
      }
      if (
        !isRuntimeCommitAuthority(input.authority, input.authority.runtimeType)
      ) {
        throw new AgentRunTransitionError('agent_run_fencing_rejected')
      }
      const locked = await readExactRun(
        transaction,
        owner,
        parsed.data.runId,
        true,
      )
      if (!['leased', 'running'].includes(locked.lifecycle)) {
        const isMatchingRetry =
          locked.lifecycle === lifecycle &&
          locked.runtimeType === input.authority.runtimeType &&
          locked.fencingToken === input.authority.fencingToken &&
          locked.terminationReason === parsed.data.terminationReason &&
          locked.completedAt !== null &&
          Date.parse(locked.completedAt) === Date.parse(parsed.data.completedAt)
        if (isMatchingRetry) {
          return Object.freeze({ run: locked, changed: false })
        }
        throw new AgentRunTransitionError('agent_run_already_terminal')
      }
      let rows: readonly unknown[]
      try {
        rows = await transaction.unsafe(
          `UPDATE app_private.agent_runs AS run
           SET lifecycle = $1, lease_owner = NULL, lease_expires_at = NULL,
               termination_reason = $2, completed_at = $3::timestamptz,
               updated_at = $3::timestamptz
           WHERE run.id = $4::uuid AND run.owner_id = $5::uuid
             AND run.runtime = $6 AND run.lifecycle IN ('leased', 'running')
             AND run.lease_owner = $7 AND run.fencing_token = $8::bigint
             AND run.lease_expires_at > clock_timestamp()
           RETURNING ${RUN_COLUMNS}`,
          [
            lifecycle,
            parsed.data.terminationReason,
            parsed.data.completedAt,
            parsed.data.runId,
            owner.databaseOwnerId,
            input.authority.runtimeType,
            input.authority.leaseOwner,
            input.authority.fencingToken,
          ],
        )
      } catch {
        throw new DatabaseOperationError()
      }
      if (rows.length !== 1) {
        throw new AgentRunTransitionError('agent_run_fencing_rejected')
      }
      return Object.freeze({
        run: requireDecodedRow(rows[0], owner),
        changed: true,
      })
    },

    async lockPlayerRunForCoordination(transaction, owner, runId) {
      assertRepositoryInput(transaction, owner)
      if (!z.uuid().safeParse(runId).success) {
        throw new RepositoryInputValidationError()
      }
      const run = await readExactRun(transaction, owner, runId, true)
      if (run.runtimeType !== 'player') {
        throw new AgentRunTransitionError('agent_run_transition_rejected')
      }
      return run
    },

    async loadFailedPlayerLeafForRetry(transaction, owner, input) {
      assertRepositoryInput(transaction, owner)
      const parsed = z
        .strictObject({
          sessionId: z.uuid(),
          handId: z.uuid(),
          participantId: z.uuid(),
          sourceStateVersion: SafeIntegerSchema,
        })
        .safeParse(input)
      if (!parsed.success) throw new RepositoryInputValidationError()
      let rows: readonly unknown[]
      try {
        rows = await transaction.unsafe(
          `SELECT ${RUN_COLUMNS}
           FROM app_private.agent_runs AS run
           WHERE run.owner_id = $1::uuid
             AND run.runtime = 'player'
             AND run.lifecycle = 'failed'
             AND run.replacement_run_id IS NULL
             AND run.session_id = $2::uuid
             AND run.hand_id = $3::uuid
             AND run.participant_id = $4::uuid
             AND run.source_state_version = $5::bigint
           ORDER BY run.id
           FOR UPDATE`,
          [
            owner.databaseOwnerId,
            parsed.data.sessionId,
            parsed.data.handId,
            parsed.data.participantId,
            parsed.data.sourceStateVersion,
          ],
        )
      } catch {
        throw new DatabaseOperationError()
      }
      if (rows.length === 0) return null
      if (rows.length !== 1) {
        throw new PersistenceDataCorruptionError('invalidAgentRunAudit')
      }
      const run = requireDecodedRow(rows[0], owner)
      if (run.runtimeType !== 'player') {
        throw new PersistenceDataCorruptionError('invalidAgentRunAudit')
      }
      return run
    },

    async terminateForCoordination(transaction, owner, input) {
      assertRepositoryInput(transaction, owner)
      const parsed = z
        .strictObject({
          runId: z.uuid(),
          lifecycle: z.enum(['failed', 'cancelled', 'stale']),
          terminationReason: StableCodeSchema,
          completedAt: CanonicalTimestampSchema,
        })
        .safeParse(input)
      if (!parsed.success) throw new RepositoryInputValidationError()
      const locked = await repository.lockPlayerRunForCoordination(
        transaction,
        owner,
        parsed.data.runId,
      )
      if (!['queued', 'leased', 'running'].includes(locked.lifecycle)) {
        throw new AgentRunTransitionError('agent_run_already_terminal')
      }
      await terminateStartedAttempts(transaction, owner, {
        runId: locked.runId,
        lifecycle: parsed.data.lifecycle,
        errorCategory: parsed.data.terminationReason,
        completedAt: parsed.data.completedAt,
      })
      let rows: readonly unknown[]
      try {
        rows = await transaction.unsafe(
          `UPDATE app_private.agent_runs AS run
           SET lifecycle = $1, lease_owner = NULL, lease_expires_at = NULL,
               termination_reason = $2, completed_at = $3::timestamptz,
               updated_at = $3::timestamptz
           WHERE run.id = $4::uuid AND run.owner_id = $5::uuid
             AND run.runtime = 'player'
             AND run.lifecycle IN ('queued', 'leased', 'running')
           RETURNING ${RUN_COLUMNS}`,
          [
            parsed.data.lifecycle,
            parsed.data.terminationReason,
            parsed.data.completedAt,
            locked.runId,
            owner.databaseOwnerId,
          ],
        )
      } catch {
        throw new DatabaseOperationError()
      }
      if (rows.length !== 1) {
        throw new AgentRunTransitionError('agent_run_transition_rejected')
      }
      const run = requireDecodedRow(rows[0], owner)
      if (run.runtimeType !== 'player') {
        throw new PersistenceDataCorruptionError('invalidAgentRunAudit')
      }
      return run
    },

    async linkReplacement(transaction, owner, input) {
      assertRepositoryInput(transaction, owner)
      const parsed = z
        .strictObject({
          predecessorRunId: z.uuid(),
          replacementRunId: z.uuid(),
        })
        .safeParse(input)
      if (
        !parsed.success ||
        parsed.data.predecessorRunId === parsed.data.replacementRunId
      ) {
        throw new RepositoryInputValidationError()
      }
      const predecessor = await repository.lockPlayerRunForCoordination(
        transaction,
        owner,
        parsed.data.predecessorRunId,
      )
      const replacement = await repository.lockPlayerRunForCoordination(
        transaction,
        owner,
        parsed.data.replacementRunId,
      )
      if (
        predecessor.replacementRunId === replacement.runId &&
        replacement.parentRunId === predecessor.runId
      ) {
        return
      }
      if (
        predecessor.sessionId !== replacement.sessionId ||
        predecessor.handId !== replacement.handId ||
        predecessor.participantId !== replacement.participantId ||
        predecessor.sourceStateVersion !== replacement.sourceStateVersion ||
        predecessor.runtimeDefinitionVersion !==
          replacement.runtimeDefinitionVersion ||
        predecessor.replacementRunId !== null ||
        replacement.parentRunId !== predecessor.runId ||
        replacement.replacementRunId !== null
      ) {
        throw new AgentRunTransitionError('agent_run_transition_rejected')
      }
      let rows: readonly unknown[]
      try {
        rows = await transaction`
          UPDATE app_private.agent_runs
          SET replacement_run_id = ${replacement.runId}::uuid,
              updated_at = clock_timestamp()
          WHERE id = ${predecessor.runId}::uuid
            AND owner_id = ${owner.databaseOwnerId}::uuid
            AND replacement_run_id IS NULL
          RETURNING id::text AS "runId"
        `
      } catch {
        throw new DatabaseOperationError()
      }
      const updated = z
        .array(z.strictObject({ runId: z.uuid() }))
        .safeParse(rows)
      if (
        !updated.success ||
        updated.data.length !== 1 ||
        updated.data[0]?.runId !== predecessor.runId
      ) {
        throw new AgentRunTransitionError('agent_run_transition_rejected')
      }
    },
  }
  return Object.freeze(repository)
}
