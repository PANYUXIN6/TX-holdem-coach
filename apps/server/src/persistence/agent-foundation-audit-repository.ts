import { randomUUID } from 'node:crypto'
import type { TransactionSql } from 'postgres'
import { z } from 'zod'
import {
  CanonicalAuditReferenceIdSchema,
  StableAuditCodeSchema,
} from '../agents/audit/audit-primitives.js'
import {
  encodeAttemptAudit,
  readCurrentAttemptAudit,
  type AttemptAudit,
} from '../agents/audit/attempt-audit-codec.js'
import {
  AgentAuditPayloadValidationError,
  AgentAuditPayloadVersionError,
} from '../agents/audit/errors.js'
import { AgentRunTransitionError } from '../agents/foundation/agent-run-lifecycle.js'
import {
  isRuntimeCommitAuthority,
  type RuntimeCommitAuthority,
} from '../agents/foundation/runtime-ports.js'
import {
  AgentAttemptAuditTransitionError,
  DatabaseOperationError,
  PersistenceDataCorruptionError,
  RepositoryInputValidationError,
  ResourceNotFoundError,
  UnknownPayloadVersionError,
} from './errors.js'
import { isResolvedOwnerScope, type ResolvedOwnerScope } from './owner-scope.js'

const CanonicalUtcTimestampSchema = z.iso.datetime({ precision: 3 })
const NonnegativeSafeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
const PositiveSafeIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
const PositivePostgresIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(2_147_483_647)
const StartAgentAttemptAuditInputSchema = z.strictObject({
  sessionId: z.uuid(),
  agentRunId: z.uuid(),
  stage: StableAuditCodeSchema,
  provider: CanonicalAuditReferenceIdSchema,
  model: CanonicalAuditReferenceIdSchema,
  attemptType: StableAuditCodeSchema,
  routingReasonCode: StableAuditCodeSchema.nullable(),
  actualTimeoutMs: PositiveSafeIntegerSchema,
  remainingDeadlineMsAtStart: NonnegativeSafeIntegerSchema,
  requestProjectionHash: z.string().regex(/^[0-9a-f]{64}$/),
  startedAt: CanonicalUtcTimestampSchema,
})
const LockedAgentRunRowSchema = z.strictObject({
  agentRunId: z.uuid(),
  sessionId: z.uuid(),
  runtime: z.enum(['player', 'coach']),
  fencingToken: PositiveSafeIntegerSchema,
})
const MaximumNumberRowSchema = z.strictObject({
  maxNumber: z.number().int().min(0).max(2_147_483_647).nullable(),
})
const InsertedAttemptRowSchema = z.strictObject({
  attemptId: z.uuid(),
  attemptNumber: z.number().int().min(0).max(2_147_483_647),
})
const FinishAgentAttemptAuditInputSchema = z
  .strictObject({
    sessionId: z.uuid(),
    agentRunId: z.uuid(),
    attemptId: z.uuid(),
    lifecycle: z.enum(['completed', 'failed', 'cancelled', 'stale']),
    accepted: z.boolean(),
    stale: z.boolean(),
    interrupted: z.boolean(),
    inputTokens: NonnegativeSafeIntegerSchema,
    outputTokens: NonnegativeSafeIntegerSchema,
    costMicrounits: NonnegativeSafeIntegerSchema,
    durationMs: NonnegativeSafeIntegerSchema,
    errorCode: StableAuditCodeSchema.nullable(),
    responseProjectionHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    validationStatus: z.enum(['notRun', 'valid', 'invalid']),
    completedAt: CanonicalUtcTimestampSchema,
  })
  .superRefine((input, context) => {
    const invalid =
      input.lifecycle === 'completed'
        ? input.errorCode !== null ||
          input.stale ||
          input.interrupted ||
          input.responseProjectionHash === null ||
          input.validationStatus === 'notRun' ||
          (input.accepted && input.validationStatus !== 'valid')
        : input.lifecycle === 'failed'
          ? input.errorCode === null ||
            input.accepted ||
            input.stale ||
            input.validationStatus === 'valid'
          : input.lifecycle === 'cancelled'
            ? input.errorCode === null ||
              input.accepted ||
              input.stale ||
              !input.interrupted ||
              input.responseProjectionHash !== null ||
              input.validationStatus !== 'notRun'
            : input.accepted || !input.stale
    if (invalid) {
      context.addIssue({
        code: 'custom',
        message: 'Attempt 终态字段组合无效。',
      })
    }
  })
const LockedStartedAttemptRowSchema = z.strictObject({
  attemptId: z.uuid(),
  agentRunId: z.uuid(),
  sessionId: z.uuid(),
  lifecycle: z.literal('started'),
  fencingToken: PositiveSafeIntegerSchema,
  payloadVersion: z.unknown(),
  payload: z.unknown(),
})
const AppendCapabilityInvocationAuditInputSchema = z
  .strictObject({
    sessionId: z.uuid(),
    agentRunId: z.uuid(),
    capabilityName: CanonicalAuditReferenceIdSchema,
    capabilityVersion: PositivePostgresIntegerSchema,
    authorized: z.boolean(),
    inputSchemaVersion: PositivePostgresIntegerSchema,
    inputHash: z.string().regex(/^[0-9a-f]{64}$/),
    outputSchemaVersion: PositivePostgresIntegerSchema.nullable(),
    outputHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    budgetCost: NonnegativeSafeIntegerSchema,
    durationMs: NonnegativeSafeIntegerSchema,
    errorCode: StableAuditCodeSchema.nullable(),
    startedAt: CanonicalUtcTimestampSchema,
    completedAt: CanonicalUtcTimestampSchema,
  })
  .superRefine((input, context) => {
    const outputPairMatches =
      (input.outputSchemaVersion === null) === (input.outputHash === null)
    const success = input.authorized && input.errorCode === null
    const failed = input.errorCode !== null
    if (
      !outputPairMatches ||
      (!success && !failed) ||
      (failed &&
        (input.outputSchemaVersion !== null || input.outputHash !== null))
    ) {
      context.addIssue({
        code: 'custom',
        message: '能力调用终态字段组合无效。',
      })
    }
  })
const InsertedInvocationRowSchema = z.strictObject({
  invocationId: z.uuid(),
  invocationNumber: z.number().int().min(0).max(2_147_483_647),
})
export interface StartAgentAttemptAuditInput {
  readonly sessionId: string
  readonly agentRunId: string
  readonly stage: string
  readonly provider: string
  readonly model: string
  readonly attemptType: string
  readonly routingReasonCode: string | null
  readonly actualTimeoutMs: number
  readonly remainingDeadlineMsAtStart: number
  readonly requestProjectionHash: string
  readonly startedAt: string
}

export interface FinishAgentAttemptAuditInput {
  readonly sessionId: string
  readonly agentRunId: string
  readonly attemptId: string
  readonly lifecycle: 'completed' | 'failed' | 'cancelled' | 'stale'
  readonly accepted: boolean
  readonly stale: boolean
  readonly interrupted: boolean
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costMicrounits: number
  readonly durationMs: number
  readonly errorCode: string | null
  readonly responseProjectionHash: string | null
  readonly validationStatus: 'notRun' | 'valid' | 'invalid'
  readonly completedAt: string
}

export interface AppendCapabilityInvocationAuditInput {
  readonly sessionId: string
  readonly agentRunId: string
  readonly capabilityName: string
  readonly capabilityVersion: number
  readonly authorized: boolean
  readonly inputSchemaVersion: number
  readonly inputHash: string
  readonly outputSchemaVersion: number | null
  readonly outputHash: string | null
  readonly budgetCost: number
  readonly durationMs: number
  readonly errorCode: string | null
  readonly startedAt: string
  readonly completedAt: string
}

async function lockFencedRunningAgentRun(
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
  authority: RuntimeCommitAuthority,
  input: { readonly sessionId: string; readonly agentRunId: string },
): Promise<void> {
  if (
    !isRuntimeCommitAuthority(authority, authority.runtimeType) ||
    authority.runId !== input.agentRunId
  ) {
    throw new AgentRunTransitionError('agent_run_fencing_rejected')
  }
  let rows: readonly unknown[]
  try {
    rows = await transaction`
      SELECT
        id::text AS "agentRunId",
        session_id::text AS "sessionId",
        runtime,
        fencing_token::float8 AS "fencingToken"
      FROM app_private.agent_runs
      WHERE id = ${input.agentRunId}::uuid
        AND owner_id = ${owner.databaseOwnerId}::uuid
        AND session_id = ${input.sessionId}::uuid
        AND runtime = ${authority.runtimeType}
        AND lifecycle = 'running'
        AND lease_owner = ${authority.leaseOwner}
        AND fencing_token = ${authority.fencingToken}::bigint
        AND lease_expires_at > clock_timestamp()
      FOR UPDATE
    `
  } catch {
    throw new DatabaseOperationError()
  }
  const parsed = z.array(LockedAgentRunRowSchema).safeParse(rows)
  if (
    !parsed.success ||
    parsed.data.length !== 1 ||
    parsed.data[0]?.agentRunId !== input.agentRunId ||
    parsed.data[0]?.sessionId !== input.sessionId ||
    parsed.data[0]?.runtime !== authority.runtimeType ||
    parsed.data[0]?.fencingToken !== authority.fencingToken
  ) {
    throw new AgentRunTransitionError('agent_run_fencing_rejected')
  }
}

export interface AgentFoundationAuditRepository {
  startAgentAttemptAudit(
    transaction: TransactionSql,
    owner: ResolvedOwnerScope,
    authority: RuntimeCommitAuthority,
    input: StartAgentAttemptAuditInput,
  ): Promise<{ readonly attemptId: string; readonly attemptNumber: number }>
  finishAgentAttemptAudit(
    transaction: TransactionSql,
    owner: ResolvedOwnerScope,
    authority: RuntimeCommitAuthority,
    input: FinishAgentAttemptAuditInput,
  ): Promise<void>
  appendCapabilityInvocationAudit(
    transaction: TransactionSql,
    owner: ResolvedOwnerScope,
    authority: RuntimeCommitAuthority,
    input: AppendCapabilityInvocationAuditInput,
  ): Promise<{
    readonly invocationId: string
    readonly invocationNumber: number
  }>
}

export function createAgentFoundationAuditRepository(): AgentFoundationAuditRepository {
  return Object.freeze({
    async startAgentAttemptAudit(
      transaction: TransactionSql,
      owner: ResolvedOwnerScope,
      authority: RuntimeCommitAuthority,
      input: StartAgentAttemptAuditInput,
    ): Promise<{ readonly attemptId: string; readonly attemptNumber: number }> {
      const parsed = StartAgentAttemptAuditInputSchema.safeParse(input)
      if (!isResolvedOwnerScope(owner) || !parsed.success) {
        throw new RepositoryInputValidationError()
      }
      let storedAttempt
      try {
        storedAttempt = encodeAttemptAudit({
          lifecycle: 'started',
          actualTimeoutMs: parsed.data.actualTimeoutMs,
          remainingDeadlineMsAtStart: parsed.data.remainingDeadlineMsAtStart,
          requestProjectionHash: parsed.data.requestProjectionHash,
        } satisfies AttemptAudit)
      } catch (error) {
        if (
          error instanceof AgentAuditPayloadValidationError ||
          error instanceof AgentAuditPayloadVersionError
        ) {
          throw new RepositoryInputValidationError()
        }
        throw error
      }

      await lockFencedRunningAgentRun(
        transaction,
        owner,
        authority,
        parsed.data,
      )

      let maximumRows: readonly unknown[]
      try {
        maximumRows = await transaction`
          SELECT max(attempt_number) AS "maxNumber"
          FROM app_private.agent_attempts
          WHERE agent_run_id = ${parsed.data.agentRunId}::uuid
            AND owner_id = ${owner.databaseOwnerId}::uuid
            AND session_id = ${parsed.data.sessionId}::uuid
        `
      } catch {
        throw new DatabaseOperationError()
      }
      const maximum = z.array(MaximumNumberRowSchema).safeParse(maximumRows)
      if (!maximum.success || maximum.data.length !== 1) {
        throw new PersistenceDataCorruptionError('invalidAgentAttemptAudit')
      }
      const nextNumber = BigInt(maximum.data[0]?.maxNumber ?? -1) + 1n
      if (nextNumber > 2_147_483_647n) {
        throw new RepositoryInputValidationError()
      }
      const attemptNumber = Number(nextNumber)
      const attemptId = randomUUID()
      const payload = transaction.json(storedAttempt.payload)

      let insertedRows: readonly unknown[]
      try {
        insertedRows = await transaction`
          INSERT INTO app_private.agent_attempts (
            id,
            agent_run_id,
            owner_id,
            session_id,
            attempt_number,
            fencing_token,
            stage,
            lifecycle,
            accepted,
            stale,
            interrupted,
            provider,
            model,
            attempt_type,
            routing_reason,
            input_tokens,
            output_tokens,
            cost_microunits,
            duration_ms,
            error_category,
            attempt_payload_version,
            attempt_payload,
            started_at,
            completed_at,
            created_at
          ) VALUES (
            ${attemptId}::uuid,
            ${parsed.data.agentRunId}::uuid,
            ${owner.databaseOwnerId}::uuid,
            ${parsed.data.sessionId}::uuid,
            ${attemptNumber},
            ${authority.fencingToken}::bigint,
            ${parsed.data.stage},
            'started',
            false,
            false,
            false,
            ${parsed.data.provider},
            ${parsed.data.model},
            ${parsed.data.attemptType},
            ${parsed.data.routingReasonCode},
            0,
            0,
            0,
            NULL,
            NULL,
            ${storedAttempt.payloadVersion},
            ${payload},
            ${parsed.data.startedAt}::timestamptz,
            NULL,
            ${parsed.data.startedAt}::timestamptz
          )
          RETURNING id::text AS "attemptId", attempt_number AS "attemptNumber"
        `
      } catch {
        throw new DatabaseOperationError()
      }
      const inserted = z.array(InsertedAttemptRowSchema).safeParse(insertedRows)
      if (
        !inserted.success ||
        inserted.data.length !== 1 ||
        inserted.data[0]?.attemptId !== attemptId ||
        inserted.data[0]?.attemptNumber !== attemptNumber
      ) {
        throw new PersistenceDataCorruptionError('invalidAgentAttemptAudit')
      }
      return Object.freeze({ attemptId, attemptNumber })
    },

    async finishAgentAttemptAudit(
      transaction: TransactionSql,
      owner: ResolvedOwnerScope,
      authority: RuntimeCommitAuthority,
      input: FinishAgentAttemptAuditInput,
    ): Promise<void> {
      const parsed = FinishAgentAttemptAuditInputSchema.safeParse(input)
      if (!isResolvedOwnerScope(owner) || !parsed.success) {
        throw new RepositoryInputValidationError()
      }

      await lockFencedRunningAgentRun(
        transaction,
        owner,
        authority,
        parsed.data,
      )

      let lockedRows: readonly unknown[]
      try {
        lockedRows = await transaction`
          SELECT
            id::text AS "attemptId",
            agent_run_id::text AS "agentRunId",
            session_id::text AS "sessionId",
            lifecycle,
            fencing_token::float8 AS "fencingToken",
            attempt_payload_version AS "payloadVersion",
            attempt_payload AS "payload"
          FROM app_private.agent_attempts
          WHERE id = ${parsed.data.attemptId}::uuid
            AND agent_run_id = ${parsed.data.agentRunId}::uuid
            AND owner_id = ${owner.databaseOwnerId}::uuid
            AND session_id = ${parsed.data.sessionId}::uuid
            AND fencing_token = ${authority.fencingToken}::bigint
          FOR UPDATE
        `
      } catch {
        throw new DatabaseOperationError()
      }
      if (lockedRows.length === 0) throw new ResourceNotFoundError()
      const locked = z
        .array(LockedStartedAttemptRowSchema)
        .safeParse(lockedRows)
      if (
        !locked.success ||
        locked.data.length !== 1 ||
        locked.data[0]?.attemptId !== parsed.data.attemptId ||
        locked.data[0]?.agentRunId !== parsed.data.agentRunId ||
        locked.data[0]?.sessionId !== parsed.data.sessionId ||
        locked.data[0]?.fencingToken !== authority.fencingToken
      ) {
        throw new AgentAttemptAuditTransitionError()
      }
      const startedRow = locked.data[0]
      const startedRead = readCurrentAttemptAudit(
        startedRow.lifecycle,
        startedRow.payloadVersion,
        startedRow.payload,
      )
      if (startedRead.kind === 'unknownVersion') {
        throw new UnknownPayloadVersionError('agentAttempt')
      }
      if (
        startedRead.kind === 'invalidPayload' ||
        startedRead.value.lifecycle !== 'started'
      ) {
        throw new PersistenceDataCorruptionError('invalidAgentAttemptAudit')
      }

      let terminalAttempt
      try {
        terminalAttempt = encodeAttemptAudit({
          lifecycle: parsed.data.lifecycle,
          actualTimeoutMs: startedRead.value.actualTimeoutMs,
          remainingDeadlineMsAtStart:
            startedRead.value.remainingDeadlineMsAtStart,
          requestProjectionHash: startedRead.value.requestProjectionHash,
          responseProjectionHash: parsed.data.responseProjectionHash,
          validationStatus: parsed.data.validationStatus,
        })
      } catch (error) {
        if (
          error instanceof AgentAuditPayloadValidationError ||
          error instanceof AgentAuditPayloadVersionError
        ) {
          throw new RepositoryInputValidationError()
        }
        throw error
      }
      const payload = transaction.json(terminalAttempt.payload)

      let updatedRows: readonly unknown[]
      try {
        updatedRows = await transaction`
          UPDATE app_private.agent_attempts
          SET lifecycle = ${parsed.data.lifecycle},
              accepted = ${parsed.data.accepted},
              stale = ${parsed.data.stale},
              interrupted = ${parsed.data.interrupted},
              input_tokens = ${parsed.data.inputTokens}::bigint,
              output_tokens = ${parsed.data.outputTokens}::bigint,
              cost_microunits = ${parsed.data.costMicrounits}::bigint,
              duration_ms = ${parsed.data.durationMs}::bigint,
              error_category = ${parsed.data.errorCode},
              attempt_payload_version = ${terminalAttempt.payloadVersion},
              attempt_payload = ${payload},
              completed_at = ${parsed.data.completedAt}::timestamptz
          WHERE id = ${parsed.data.attemptId}::uuid
            AND agent_run_id = ${parsed.data.agentRunId}::uuid
            AND owner_id = ${owner.databaseOwnerId}::uuid
            AND session_id = ${parsed.data.sessionId}::uuid
            AND fencing_token = ${authority.fencingToken}::bigint
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
        updated.data[0]?.attemptId !== parsed.data.attemptId
      ) {
        throw new AgentAttemptAuditTransitionError()
      }
    },

    async appendCapabilityInvocationAudit(
      transaction: TransactionSql,
      owner: ResolvedOwnerScope,
      authority: RuntimeCommitAuthority,
      input: AppendCapabilityInvocationAuditInput,
    ): Promise<{
      readonly invocationId: string
      readonly invocationNumber: number
    }> {
      const parsed = AppendCapabilityInvocationAuditInputSchema.safeParse(input)
      if (!isResolvedOwnerScope(owner) || !parsed.success) {
        throw new RepositoryInputValidationError()
      }

      await lockFencedRunningAgentRun(
        transaction,
        owner,
        authority,
        parsed.data,
      )

      let maximumRows: readonly unknown[]
      try {
        maximumRows = await transaction`
          SELECT max(invocation_number) AS "maxNumber"
          FROM app_private.agent_capability_invocations
          WHERE agent_run_id = ${parsed.data.agentRunId}::uuid
            AND owner_id = ${owner.databaseOwnerId}::uuid
            AND session_id = ${parsed.data.sessionId}::uuid
        `
      } catch {
        throw new DatabaseOperationError()
      }
      const maximum = z.array(MaximumNumberRowSchema).safeParse(maximumRows)
      if (!maximum.success || maximum.data.length !== 1) {
        throw new PersistenceDataCorruptionError(
          'invalidCapabilityInvocationAudit',
        )
      }
      const nextNumber = BigInt(maximum.data[0]?.maxNumber ?? -1) + 1n
      if (nextNumber > 2_147_483_647n) {
        throw new RepositoryInputValidationError()
      }
      const invocationNumber = Number(nextNumber)
      const invocationId = randomUUID()

      let insertedRows: readonly unknown[]
      try {
        insertedRows = await transaction`
          INSERT INTO app_private.agent_capability_invocations (
            id,
            agent_run_id,
            owner_id,
            session_id,
            invocation_number,
            fencing_token,
            capability_name,
            capability_version,
            authorized,
            input_schema_version,
            input_hash,
            output_schema_version,
            output_hash,
            budget_cost,
            duration_ms,
            error_category,
            started_at,
            completed_at,
            created_at
          ) VALUES (
            ${invocationId}::uuid,
            ${parsed.data.agentRunId}::uuid,
            ${owner.databaseOwnerId}::uuid,
            ${parsed.data.sessionId}::uuid,
            ${invocationNumber},
            ${authority.fencingToken}::bigint,
            ${parsed.data.capabilityName},
            ${parsed.data.capabilityVersion},
            ${parsed.data.authorized},
            ${parsed.data.inputSchemaVersion},
            ${parsed.data.inputHash},
            ${parsed.data.outputSchemaVersion},
            ${parsed.data.outputHash},
            ${parsed.data.budgetCost}::bigint,
            ${parsed.data.durationMs}::bigint,
            ${parsed.data.errorCode},
            ${parsed.data.startedAt}::timestamptz,
            ${parsed.data.completedAt}::timestamptz,
            ${parsed.data.startedAt}::timestamptz
          )
          RETURNING
            id::text AS "invocationId",
            invocation_number AS "invocationNumber"
        `
      } catch {
        throw new DatabaseOperationError()
      }
      const inserted = z
        .array(InsertedInvocationRowSchema)
        .safeParse(insertedRows)
      if (
        !inserted.success ||
        inserted.data.length !== 1 ||
        inserted.data[0]?.invocationId !== invocationId ||
        inserted.data[0]?.invocationNumber !== invocationNumber
      ) {
        throw new PersistenceDataCorruptionError(
          'invalidCapabilityInvocationAudit',
        )
      }
      return Object.freeze({ invocationId, invocationNumber })
    },
  })
}
