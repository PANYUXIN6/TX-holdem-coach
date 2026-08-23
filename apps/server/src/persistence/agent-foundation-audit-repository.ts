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
import { currentExecutionBudgetAuditReader } from '../agents/audit/execution-budget-audit-codec.js'
import { evaluateExecutionBudget } from '../agents/foundation/execution-budget.js'
import { AgentRunTransitionError } from '../agents/foundation/agent-run-lifecycle.js'
import {
  isRuntimeCommitAuthority,
  type RuntimeCommitAuthority,
} from '../agents/foundation/runtime-ports.js'
import {
  AgentAttemptAuditTransitionError,
  CapabilityInvocationAuditTransitionError,
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
  reservedInputTokens: NonnegativeSafeIntegerSchema,
  reservedOutputTokens: NonnegativeSafeIntegerSchema,
  reservedCostMicrounits: NonnegativeSafeIntegerSchema,
  startedAt: CanonicalUtcTimestampSchema,
})
const LockedAgentRunRowSchema = z.strictObject({
  agentRunId: z.uuid(),
  sessionId: z.uuid(),
  runtime: z.enum(['player', 'coach']),
  fencingToken: PositiveSafeIntegerSchema,
  deadlineExpired: z.boolean(),
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
    usageAccounting: z.enum([
      'providerReported',
      'reservedUpperBound',
      'notIncurred',
    ]),
    costAccounting: z.enum([
      'providerReportedSplit',
      'allInputAtCacheMiss',
      'reservedUpperBound',
      'notIncurred',
    ]),
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
const ReserveCapabilityInvocationInputSchema = z.strictObject({
  sessionId: z.uuid(),
  agentRunId: z.uuid(),
  capabilityName: CanonicalAuditReferenceIdSchema,
  capabilityVersion: PositivePostgresIntegerSchema,
  inputSchemaVersion: PositivePostgresIntegerSchema,
  inputHash: z.string().regex(/^[0-9a-f]{64}$/),
  grantMaximum: PositiveSafeIntegerSchema,
  startedAt: CanonicalUtcTimestampSchema,
})
const FinishCapabilityInvocationInputSchema = z
  .strictObject({
    sessionId: z.uuid(),
    agentRunId: z.uuid(),
    invocationId: z.uuid(),
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
const LockedCapabilityInvocationReservationRowSchema = z.strictObject({
  invocationId: z.uuid(),
  agentRunId: z.uuid(),
  sessionId: z.uuid(),
  fencingToken: PositiveSafeIntegerSchema,
  capabilityName: CanonicalAuditReferenceIdSchema,
  capabilityVersion: PositivePostgresIntegerSchema,
  authorized: z.literal(true),
  inputSchemaVersion: PositivePostgresIntegerSchema,
  inputHash: z.string().regex(/^[0-9a-f]{64}$/),
  budgetCost: z.literal(1),
})
const BudgetedAttemptStartInputSchema = z.strictObject({
  sessionId: z.uuid(),
  agentRunId: z.uuid(),
  stage: StableAuditCodeSchema,
  provider: CanonicalAuditReferenceIdSchema,
  model: CanonicalAuditReferenceIdSchema,
  attemptType: z.enum(['initial', 'correction']),
  routingReasonCode: z.enum(['content_correction']).nullable(),
  estimatedInputTokens: NonnegativeSafeIntegerSchema,
  requestedMaximumOutputTokens: PositiveSafeIntegerSchema,
  reservedCostMicrounits: NonnegativeSafeIntegerSchema,
  requestProjectionHash: z.string().regex(/^[0-9a-f]{64}$/),
})
const BudgetedLockedRunRowSchema = z.strictObject({
  agentRunId: z.uuid(),
  sessionId: z.uuid(),
  runtime: z.enum(['player', 'coach']),
  fencingToken: PositiveSafeIntegerSchema,
  budgetPayloadVersion: z.unknown(),
  budgetPayload: z.unknown(),
  elapsedMs: NonnegativeSafeIntegerSchema,
  remainingDeadlineMs: z.number().int().safe(),
  databaseNow: CanonicalUtcTimestampSchema,
})
const AttemptUsageRowSchema = z.strictObject({
  lifecycle: z.enum(['started', 'completed', 'failed', 'cancelled', 'stale']),
  inputTokens: NonnegativeSafeIntegerSchema,
  outputTokens: NonnegativeSafeIntegerSchema,
  costMicrounits: NonnegativeSafeIntegerSchema,
  payloadVersion: z.unknown(),
  payload: z.unknown(),
})
const CapabilityBudgetUsageRowSchema = z.strictObject({
  budgetCost: NonnegativeSafeIntegerSchema,
})
const CapabilityReservationUsageRowSchema = z.strictObject({
  totalBudgetCost: NonnegativeSafeIntegerSchema,
  capabilityBudgetCost: NonnegativeSafeIntegerSchema,
})
const CapabilityBudgetRowSchema = z.strictObject({
  budgetPayloadVersion: z.unknown(),
  budgetPayload: z.unknown(),
})
const FinishBudgetRunRowSchema = z.strictObject({
  budgetPayloadVersion: z.unknown(),
  budgetPayload: z.unknown(),
  elapsedMs: NonnegativeSafeIntegerSchema,
})

export interface BudgetedAttemptStartInput {
  readonly sessionId: string
  readonly agentRunId: string
  readonly stage: string
  readonly provider: string
  readonly model: string
  readonly attemptType: 'initial' | 'correction'
  readonly routingReasonCode: 'content_correction' | null
  readonly estimatedInputTokens: number
  readonly requestedMaximumOutputTokens: number
  readonly reservedCostMicrounits: number
  readonly requestProjectionHash: string
}

export type BudgetedAttemptStartResult =
  | {
      readonly kind: 'started'
      readonly attemptId: string
      readonly attemptNumber: number
      readonly actualTimeoutMs: number
      readonly maximumOutputTokens: number
    }
  | {
      readonly kind: 'rejected'
      readonly failure:
        'execution_budget_exhausted' | 'execution_deadline_exhausted'
    }
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
  readonly reservedInputTokens: number
  readonly reservedOutputTokens: number
  readonly reservedCostMicrounits: number
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
  readonly usageAccounting:
    'providerReported' | 'reservedUpperBound' | 'notIncurred'
  readonly costAccounting:
    | 'providerReportedSplit'
    | 'allInputAtCacheMiss'
    | 'reservedUpperBound'
    | 'notIncurred'
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

export interface ReserveCapabilityInvocationInput {
  readonly sessionId: string
  readonly agentRunId: string
  readonly capabilityName: string
  readonly capabilityVersion: number
  readonly inputSchemaVersion: number
  readonly inputHash: string
  readonly grantMaximum: number
  readonly startedAt: string
}

export interface FinishCapabilityInvocationInput {
  readonly sessionId: string
  readonly agentRunId: string
  readonly invocationId: string
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
  readonly completedAt: string
}

async function lockFencedRunningAgentRun(
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
  authority: RuntimeCommitAuthority,
  input: { readonly sessionId: string; readonly agentRunId: string },
): Promise<{ readonly deadlineExpired: boolean }> {
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
        fencing_token::float8 AS "fencingToken",
        (deadline_at <= clock_timestamp()) AS "deadlineExpired"
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
  return Object.freeze({
    deadlineExpired: parsed.data[0].deadlineExpired,
  })
}

export interface AgentFoundationAuditRepository {
  startBudgetedAgentAttemptAudit(
    transaction: TransactionSql,
    owner: ResolvedOwnerScope,
    authority: RuntimeCommitAuthority,
    input: BudgetedAttemptStartInput,
  ): Promise<BudgetedAttemptStartResult>
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
  ): Promise<'recorded' | 'stale' | 'budgetExceeded'>
  reserveCapabilityInvocationAudit(
    transaction: TransactionSql,
    owner: ResolvedOwnerScope,
    authority: RuntimeCommitAuthority,
    input: ReserveCapabilityInvocationInput,
  ): Promise<
    | {
        readonly kind: 'reserved'
        readonly invocationId: string
        readonly invocationNumber: number
      }
    | { readonly kind: 'budgetExhausted' }
  >
  finishCapabilityInvocationAudit(
    transaction: TransactionSql,
    owner: ResolvedOwnerScope,
    authority: RuntimeCommitAuthority,
    input: FinishCapabilityInvocationInput,
  ): Promise<'recorded' | 'stale'>
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
  const repository: AgentFoundationAuditRepository = {
    async startBudgetedAgentAttemptAudit(
      transaction,
      owner,
      authority,
      input,
    ): Promise<BudgetedAttemptStartResult> {
      const parsed = BudgetedAttemptStartInputSchema.safeParse(input)
      if (!isResolvedOwnerScope(owner) || !parsed.success) {
        throw new RepositoryInputValidationError()
      }
      if (
        !isRuntimeCommitAuthority(authority, authority.runtimeType) ||
        authority.runId !== parsed.data.agentRunId
      ) {
        throw new AgentRunTransitionError('agent_run_fencing_rejected')
      }
      let runRows: readonly unknown[]
      try {
        runRows = await transaction`
          SELECT
            id::text AS "agentRunId",
            session_id::text AS "sessionId",
            runtime,
            fencing_token::float8 AS "fencingToken",
            budget_payload_version AS "budgetPayloadVersion",
            budget_payload AS "budgetPayload",
            GREATEST(0, floor(extract(epoch FROM (clock_timestamp() - created_at)) * 1000))::float8 AS "elapsedMs",
            floor(extract(epoch FROM (deadline_at - clock_timestamp())) * 1000)::float8 AS "remainingDeadlineMs",
            to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "databaseNow"
          FROM app_private.agent_runs
          WHERE id = ${parsed.data.agentRunId}::uuid
            AND owner_id = ${owner.databaseOwnerId}::uuid
            AND session_id = ${parsed.data.sessionId}::uuid
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
      const run = z.array(BudgetedLockedRunRowSchema).safeParse(runRows)
      if (
        !run.success ||
        run.data.length !== 1 ||
        run.data[0]?.agentRunId !== parsed.data.agentRunId ||
        run.data[0]?.runtime !== authority.runtimeType
      ) {
        throw new AgentRunTransitionError('agent_run_fencing_rejected')
      }
      const runRow = run.data[0]
      if (runRow.remainingDeadlineMs <= 0) {
        return Object.freeze({
          kind: 'rejected',
          failure: 'execution_deadline_exhausted',
        })
      }
      const budgetRead = currentExecutionBudgetAuditReader.read(
        runRow.budgetPayloadVersion,
        runRow.budgetPayload,
      )
      if (budgetRead.kind === 'unknownVersion') {
        throw new UnknownPayloadVersionError('agentExecutionBudget')
      }
      if (budgetRead.kind === 'invalidPayload') {
        throw new PersistenceDataCorruptionError('invalidAgentRunAudit')
      }
      let attemptRows: readonly unknown[]
      let invocationRows: readonly unknown[]
      try {
        attemptRows = await transaction`
          SELECT lifecycle,
                 input_tokens::float8 AS "inputTokens",
                 output_tokens::float8 AS "outputTokens",
                 cost_microunits::float8 AS "costMicrounits",
                 attempt_payload_version AS "payloadVersion",
                 attempt_payload AS "payload"
          FROM app_private.agent_attempts
          WHERE agent_run_id = ${parsed.data.agentRunId}::uuid
            AND owner_id = ${owner.databaseOwnerId}::uuid
            AND session_id = ${parsed.data.sessionId}::uuid
          ORDER BY attempt_number
          FOR UPDATE
        `
        invocationRows = await transaction`
          SELECT COALESCE(
                   sum(budget_cost) FILTER (WHERE authorized),
                   0
                 )::float8 AS "budgetCost"
          FROM app_private.agent_capability_invocations
          WHERE agent_run_id = ${parsed.data.agentRunId}::uuid
            AND owner_id = ${owner.databaseOwnerId}::uuid
            AND session_id = ${parsed.data.sessionId}::uuid
        `
      } catch {
        throw new DatabaseOperationError()
      }
      const attempts = z.array(AttemptUsageRowSchema).safeParse(attemptRows)
      const invocations = z
        .array(CapabilityBudgetUsageRowSchema)
        .safeParse(invocationRows)
      if (
        !attempts.success ||
        !invocations.success ||
        invocations.data.length !== 1
      ) {
        throw new PersistenceDataCorruptionError('invalidAgentAttemptAudit')
      }
      let inputTokens = 0
      let outputTokens = 0
      let costMicrounits = 0
      for (const attempt of attempts.data) {
        const audit = readCurrentAttemptAudit(
          attempt.lifecycle,
          attempt.payloadVersion,
          attempt.payload,
        )
        if (audit.kind === 'unknownVersion') {
          throw new UnknownPayloadVersionError('agentAttempt')
        }
        if (audit.kind === 'invalidPayload') {
          throw new PersistenceDataCorruptionError('invalidAgentAttemptAudit')
        }
        const useReservation =
          audit.value.lifecycle === 'started' ||
          audit.value.usageAccounting === 'reservedUpperBound'
        const notIncurred =
          audit.value.lifecycle !== 'started' &&
          audit.value.usageAccounting === 'notIncurred'
        inputTokens += useReservation
          ? audit.value.reservedInputTokens
          : notIncurred
            ? 0
            : attempt.inputTokens
        outputTokens += useReservation
          ? audit.value.reservedOutputTokens
          : notIncurred
            ? 0
            : attempt.outputTokens
        costMicrounits +=
          audit.value.lifecycle === 'started' ||
          audit.value.costAccounting === 'reservedUpperBound'
            ? audit.value.reservedCostMicrounits
            : audit.value.costAccounting === 'notIncurred'
              ? 0
              : attempt.costMicrounits
      }
      const budget = budgetRead.value
      const maximumOutputTokens = Math.min(
        parsed.data.requestedMaximumOutputTokens,
        Math.max(0, budget.maxOutputTokens - outputTokens),
      )
      if (maximumOutputTokens === 0) {
        return Object.freeze({
          kind: 'rejected',
          failure: 'execution_budget_exhausted',
        })
      }
      const decision = evaluateExecutionBudget(
        budget,
        {
          attempts: attempts.data.length,
          inputTokens,
          outputTokens,
          capabilityInvocations: invocations.data[0]!.budgetCost,
          costMicrounits,
          elapsedMs: runRow.elapsedMs,
        },
        {
          purpose: 'startAttempt',
          anticipatedUsage: {
            inputTokens: parsed.data.estimatedInputTokens,
            outputTokens: maximumOutputTokens,
            capabilityInvocations: 0,
            costMicrounits: parsed.data.reservedCostMicrounits,
            elapsedMs: 0,
          },
        },
      )
      if (decision.kind === 'exhausted') {
        return Object.freeze({
          kind: 'rejected',
          failure:
            decision.reason === 'wallClock' ||
            decision.reason === 'minimumAttemptWindow'
              ? 'execution_deadline_exhausted'
              : 'execution_budget_exhausted',
        })
      }
      const actualTimeoutMs = Math.min(
        budget.attemptTimeoutMs,
        runRow.remainingDeadlineMs,
      )
      const started = await repository.startAgentAttemptAudit(
        transaction,
        owner,
        authority,
        {
          sessionId: parsed.data.sessionId,
          agentRunId: parsed.data.agentRunId,
          stage: parsed.data.stage,
          provider: parsed.data.provider,
          model: parsed.data.model,
          attemptType: parsed.data.attemptType,
          routingReasonCode: parsed.data.routingReasonCode,
          actualTimeoutMs,
          remainingDeadlineMsAtStart: runRow.remainingDeadlineMs,
          requestProjectionHash: parsed.data.requestProjectionHash,
          reservedInputTokens: parsed.data.estimatedInputTokens,
          reservedOutputTokens: maximumOutputTokens,
          reservedCostMicrounits: parsed.data.reservedCostMicrounits,
          startedAt: runRow.databaseNow,
        },
      )
      return Object.freeze({
        kind: 'started',
        ...started,
        actualTimeoutMs,
        maximumOutputTokens,
      })
    },
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
          reservedInputTokens: parsed.data.reservedInputTokens,
          reservedOutputTokens: parsed.data.reservedOutputTokens,
          reservedCostMicrounits: parsed.data.reservedCostMicrounits,
          usageAccounting: 'pending',
          costAccounting: 'pending',
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
    ): Promise<'recorded' | 'stale' | 'budgetExceeded'> {
      const parsed = FinishAgentAttemptAuditInputSchema.safeParse(input)
      if (!isResolvedOwnerScope(owner) || !parsed.success) {
        throw new RepositoryInputValidationError()
      }

      const runState = await lockFencedRunningAgentRun(
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

      let budgetExceeded = false
      if (!runState.deadlineExpired) {
        let budgetRows: readonly unknown[]
        let otherAttemptRows: readonly unknown[]
        let invocationRows: readonly unknown[]
        try {
          budgetRows = await transaction`
            SELECT
              budget_payload_version AS "budgetPayloadVersion",
              budget_payload AS "budgetPayload",
              GREATEST(0, floor(extract(epoch FROM (clock_timestamp() - created_at)) * 1000))::float8 AS "elapsedMs"
            FROM app_private.agent_runs
            WHERE id = ${parsed.data.agentRunId}::uuid
              AND owner_id = ${owner.databaseOwnerId}::uuid
              AND session_id = ${parsed.data.sessionId}::uuid
          `
          otherAttemptRows = await transaction`
            SELECT lifecycle,
                   input_tokens::float8 AS "inputTokens",
                   output_tokens::float8 AS "outputTokens",
                   cost_microunits::float8 AS "costMicrounits",
                   attempt_payload_version AS "payloadVersion",
                   attempt_payload AS "payload"
            FROM app_private.agent_attempts
            WHERE agent_run_id = ${parsed.data.agentRunId}::uuid
              AND owner_id = ${owner.databaseOwnerId}::uuid
              AND session_id = ${parsed.data.sessionId}::uuid
              AND id <> ${parsed.data.attemptId}::uuid
            ORDER BY attempt_number
            FOR UPDATE
          `
          invocationRows = await transaction`
            SELECT COALESCE(
                     sum(budget_cost) FILTER (WHERE authorized),
                     0
                   )::float8 AS "budgetCost"
            FROM app_private.agent_capability_invocations
            WHERE agent_run_id = ${parsed.data.agentRunId}::uuid
              AND owner_id = ${owner.databaseOwnerId}::uuid
              AND session_id = ${parsed.data.sessionId}::uuid
          `
        } catch {
          throw new DatabaseOperationError()
        }
        const budgetRow = z
          .array(FinishBudgetRunRowSchema)
          .safeParse(budgetRows)
        const otherAttempts = z
          .array(AttemptUsageRowSchema)
          .safeParse(otherAttemptRows)
        const invocations = z
          .array(CapabilityBudgetUsageRowSchema)
          .safeParse(invocationRows)
        if (
          !budgetRow.success ||
          budgetRow.data.length !== 1 ||
          !otherAttempts.success ||
          !invocations.success ||
          invocations.data.length !== 1
        ) {
          throw new PersistenceDataCorruptionError('invalidAgentAttemptAudit')
        }
        const budgetRead = currentExecutionBudgetAuditReader.read(
          budgetRow.data[0]!.budgetPayloadVersion,
          budgetRow.data[0]!.budgetPayload,
        )
        if (budgetRead.kind === 'unknownVersion') {
          throw new UnknownPayloadVersionError('agentExecutionBudget')
        }
        if (budgetRead.kind === 'invalidPayload') {
          throw new PersistenceDataCorruptionError('invalidAgentRunAudit')
        }

        let inputTokens = 0
        let outputTokens = 0
        let costMicrounits = 0
        let usageOverflowed = false
        const addUsage = (current: number, increment: number): number => {
          if (increment > Number.MAX_SAFE_INTEGER - current) {
            usageOverflowed = true
            return Number.MAX_SAFE_INTEGER
          }
          return current + increment
        }
        for (const attempt of otherAttempts.data) {
          const audit = readCurrentAttemptAudit(
            attempt.lifecycle,
            attempt.payloadVersion,
            attempt.payload,
          )
          if (audit.kind === 'unknownVersion') {
            throw new UnknownPayloadVersionError('agentAttempt')
          }
          if (audit.kind === 'invalidPayload') {
            throw new PersistenceDataCorruptionError('invalidAgentAttemptAudit')
          }
          const useReservation =
            audit.value.lifecycle === 'started' ||
            audit.value.usageAccounting === 'reservedUpperBound'
          const notIncurred =
            audit.value.lifecycle !== 'started' &&
            audit.value.usageAccounting === 'notIncurred'
          inputTokens = addUsage(
            inputTokens,
            useReservation
              ? audit.value.reservedInputTokens
              : notIncurred
                ? 0
                : attempt.inputTokens,
          )
          outputTokens = addUsage(
            outputTokens,
            useReservation
              ? audit.value.reservedOutputTokens
              : notIncurred
                ? 0
                : attempt.outputTokens,
          )
          costMicrounits = addUsage(
            costMicrounits,
            audit.value.lifecycle === 'started' ||
              audit.value.costAccounting === 'reservedUpperBound'
              ? audit.value.reservedCostMicrounits
              : audit.value.costAccounting === 'notIncurred'
                ? 0
                : attempt.costMicrounits,
          )
        }
        const currentInputTokens =
          parsed.data.usageAccounting === 'reservedUpperBound'
            ? startedRead.value.reservedInputTokens
            : parsed.data.usageAccounting === 'notIncurred'
              ? 0
              : parsed.data.inputTokens
        const currentOutputTokens =
          parsed.data.usageAccounting === 'reservedUpperBound'
            ? startedRead.value.reservedOutputTokens
            : parsed.data.usageAccounting === 'notIncurred'
              ? 0
              : parsed.data.outputTokens
        const currentCostMicrounits =
          parsed.data.costAccounting === 'reservedUpperBound'
            ? startedRead.value.reservedCostMicrounits
            : parsed.data.costAccounting === 'notIncurred'
              ? 0
              : parsed.data.costMicrounits
        inputTokens = addUsage(inputTokens, currentInputTokens)
        outputTokens = addUsage(outputTokens, currentOutputTokens)
        costMicrounits = addUsage(costMicrounits, currentCostMicrounits)

        const reservationExceeded =
          (parsed.data.usageAccounting === 'providerReported' &&
            (parsed.data.inputTokens > startedRead.value.reservedInputTokens ||
              parsed.data.outputTokens >
                startedRead.value.reservedOutputTokens)) ||
          ((parsed.data.costAccounting === 'providerReportedSplit' ||
            parsed.data.costAccounting === 'allInputAtCacheMiss') &&
            parsed.data.costMicrounits >
              startedRead.value.reservedCostMicrounits)
        const decision = usageOverflowed
          ? ({ kind: 'exhausted' } as const)
          : evaluateExecutionBudget(
              budgetRead.value,
              {
                attempts: otherAttempts.data.length + 1,
                inputTokens,
                outputTokens,
                capabilityInvocations: invocations.data[0]!.budgetCost,
                costMicrounits,
                elapsedMs: budgetRow.data[0]!.elapsedMs,
              },
              {
                purpose: 'continue',
                anticipatedUsage: {
                  inputTokens: 0,
                  outputTokens: 0,
                  capabilityInvocations: 0,
                  costMicrounits: 0,
                  elapsedMs: 0,
                },
              },
            )
        budgetExceeded = reservationExceeded || decision.kind === 'exhausted'
      }

      const terminalInput = runState.deadlineExpired
        ? {
            lifecycle: 'stale' as const,
            accepted: false,
            stale: true,
            interrupted: parsed.data.interrupted,
            errorCode: null,
            responseProjectionHash: parsed.data.responseProjectionHash,
            validationStatus: parsed.data.validationStatus,
            usageAccounting:
              parsed.data.usageAccounting === 'notIncurred'
                ? ('reservedUpperBound' as const)
                : parsed.data.usageAccounting,
            costAccounting:
              parsed.data.costAccounting === 'notIncurred'
                ? ('reservedUpperBound' as const)
                : parsed.data.costAccounting,
          }
        : budgetExceeded
          ? { ...parsed.data, accepted: false }
          : parsed.data
      let terminalAttempt
      try {
        terminalAttempt = encodeAttemptAudit({
          lifecycle: terminalInput.lifecycle,
          actualTimeoutMs: startedRead.value.actualTimeoutMs,
          remainingDeadlineMsAtStart:
            startedRead.value.remainingDeadlineMsAtStart,
          requestProjectionHash: startedRead.value.requestProjectionHash,
          reservedInputTokens: startedRead.value.reservedInputTokens,
          reservedOutputTokens: startedRead.value.reservedOutputTokens,
          reservedCostMicrounits: startedRead.value.reservedCostMicrounits,
          responseProjectionHash: terminalInput.responseProjectionHash,
          validationStatus: terminalInput.validationStatus,
          usageAccounting: terminalInput.usageAccounting,
          costAccounting: terminalInput.costAccounting,
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
          SET lifecycle = ${terminalInput.lifecycle},
              accepted = ${terminalInput.accepted},
              stale = ${terminalInput.stale},
              interrupted = ${terminalInput.interrupted},
              input_tokens = ${parsed.data.inputTokens}::bigint,
              output_tokens = ${parsed.data.outputTokens}::bigint,
              cost_microunits = ${parsed.data.costMicrounits}::bigint,
              duration_ms = ${parsed.data.durationMs}::bigint,
              error_category = ${terminalInput.errorCode},
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
      return runState.deadlineExpired
        ? 'stale'
        : budgetExceeded
          ? 'budgetExceeded'
          : 'recorded'
    },

    async reserveCapabilityInvocationAudit(
      transaction,
      owner,
      authority,
      input,
    ) {
      const parsed = ReserveCapabilityInvocationInputSchema.safeParse(input)
      if (!isResolvedOwnerScope(owner) || !parsed.success) {
        throw new RepositoryInputValidationError()
      }
      const runState = await lockFencedRunningAgentRun(
        transaction,
        owner,
        authority,
        parsed.data,
      )
      if (runState.deadlineExpired) {
        return Object.freeze({ kind: 'budgetExhausted' as const })
      }

      let budgetRows: readonly unknown[]
      let countRows: readonly unknown[]
      let maximumRows: readonly unknown[]
      try {
        budgetRows = await transaction`
          SELECT budget_payload_version AS "budgetPayloadVersion",
                 budget_payload AS "budgetPayload"
          FROM app_private.agent_runs
          WHERE id = ${parsed.data.agentRunId}::uuid
            AND owner_id = ${owner.databaseOwnerId}::uuid
            AND session_id = ${parsed.data.sessionId}::uuid
        `
        countRows = await transaction`
          SELECT COALESCE(
                   sum(budget_cost) FILTER (WHERE authorized),
                   0
                 )::float8 AS "totalBudgetCost",
                 COALESCE(
                   sum(budget_cost) FILTER (
                     WHERE authorized
                       AND capability_name = ${parsed.data.capabilityName}
                     AND capability_version = ${parsed.data.capabilityVersion}
                   ),
                   0
                 )::float8 AS "capabilityBudgetCost"
          FROM app_private.agent_capability_invocations
          WHERE agent_run_id = ${parsed.data.agentRunId}::uuid
            AND owner_id = ${owner.databaseOwnerId}::uuid
            AND session_id = ${parsed.data.sessionId}::uuid
        `
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
      const budgetRow = z.array(CapabilityBudgetRowSchema).safeParse(budgetRows)
      const counts = z
        .array(CapabilityReservationUsageRowSchema)
        .safeParse(countRows)
      const maximum = z.array(MaximumNumberRowSchema).safeParse(maximumRows)
      if (
        !budgetRow.success ||
        budgetRow.data.length !== 1 ||
        !counts.success ||
        counts.data.length !== 1 ||
        !maximum.success ||
        maximum.data.length !== 1
      ) {
        throw new PersistenceDataCorruptionError(
          'invalidCapabilityInvocationAudit',
        )
      }
      const budgetRead = currentExecutionBudgetAuditReader.read(
        budgetRow.data[0]!.budgetPayloadVersion,
        budgetRow.data[0]!.budgetPayload,
      )
      if (budgetRead.kind === 'unknownVersion') {
        throw new UnknownPayloadVersionError('agentExecutionBudget')
      }
      if (budgetRead.kind === 'invalidPayload') {
        throw new PersistenceDataCorruptionError('invalidAgentRunAudit')
      }
      if (
        counts.data[0]!.totalBudgetCost >=
          budgetRead.value.maxCapabilityInvocations ||
        counts.data[0]!.capabilityBudgetCost >= parsed.data.grantMaximum
      ) {
        return Object.freeze({ kind: 'budgetExhausted' as const })
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
            true,
            ${parsed.data.inputSchemaVersion},
            ${parsed.data.inputHash},
            NULL,
            NULL,
            1,
            NULL,
            NULL,
            ${parsed.data.startedAt}::timestamptz,
            NULL,
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
      return Object.freeze({
        kind: 'reserved' as const,
        invocationId,
        invocationNumber,
      })
    },

    async finishCapabilityInvocationAudit(
      transaction,
      owner,
      authority,
      input,
    ): Promise<'recorded' | 'stale'> {
      const parsed = FinishCapabilityInvocationInputSchema.safeParse(input)
      if (!isResolvedOwnerScope(owner) || !parsed.success) {
        throw new RepositoryInputValidationError()
      }
      const runState = await lockFencedRunningAgentRun(
        transaction,
        owner,
        authority,
        parsed.data,
      )
      const terminalInput = runState.deadlineExpired
        ? {
            ...parsed.data,
            outputSchemaVersion: null,
            outputHash: null,
            errorCode: 'capability_deadline_exhausted',
          }
        : parsed.data

      let lockedRows: readonly unknown[]
      try {
        lockedRows = await transaction`
          SELECT
            id::text AS "invocationId",
            agent_run_id::text AS "agentRunId",
            session_id::text AS "sessionId",
            fencing_token::float8 AS "fencingToken",
            capability_name AS "capabilityName",
            capability_version AS "capabilityVersion",
            authorized,
            input_schema_version AS "inputSchemaVersion",
            input_hash AS "inputHash",
            budget_cost::float8 AS "budgetCost"
          FROM app_private.agent_capability_invocations
          WHERE id = ${parsed.data.invocationId}::uuid
            AND agent_run_id = ${parsed.data.agentRunId}::uuid
            AND owner_id = ${owner.databaseOwnerId}::uuid
            AND session_id = ${parsed.data.sessionId}::uuid
            AND fencing_token = ${authority.fencingToken}::bigint
            AND completed_at IS NULL
          FOR UPDATE
        `
      } catch {
        throw new DatabaseOperationError()
      }
      const locked = z
        .array(LockedCapabilityInvocationReservationRowSchema)
        .safeParse(lockedRows)
      const row = locked.success ? locked.data[0] : undefined
      if (
        !locked.success ||
        locked.data.length !== 1 ||
        row?.invocationId !== parsed.data.invocationId ||
        row.agentRunId !== parsed.data.agentRunId ||
        row.sessionId !== parsed.data.sessionId ||
        row.fencingToken !== authority.fencingToken ||
        row.capabilityName !== parsed.data.capabilityName ||
        row.capabilityVersion !== parsed.data.capabilityVersion ||
        row.authorized !== parsed.data.authorized ||
        row.inputSchemaVersion !== parsed.data.inputSchemaVersion ||
        row.inputHash !== parsed.data.inputHash ||
        row.budgetCost !== parsed.data.budgetCost
      ) {
        throw new CapabilityInvocationAuditTransitionError()
      }

      let updatedRows: readonly unknown[]
      try {
        updatedRows = await transaction`
          UPDATE app_private.agent_capability_invocations
          SET output_schema_version = ${terminalInput.outputSchemaVersion},
              output_hash = ${terminalInput.outputHash},
              duration_ms = ${terminalInput.durationMs}::bigint,
              error_category = ${terminalInput.errorCode},
              completed_at = ${terminalInput.completedAt}::timestamptz
          WHERE id = ${parsed.data.invocationId}::uuid
            AND agent_run_id = ${parsed.data.agentRunId}::uuid
            AND owner_id = ${owner.databaseOwnerId}::uuid
            AND session_id = ${parsed.data.sessionId}::uuid
            AND fencing_token = ${authority.fencingToken}::bigint
            AND completed_at IS NULL
          RETURNING id::text AS "invocationId"
        `
      } catch {
        throw new DatabaseOperationError()
      }
      const updated = z
        .array(z.strictObject({ invocationId: z.uuid() }))
        .safeParse(updatedRows)
      if (
        !updated.success ||
        updated.data.length !== 1 ||
        updated.data[0]?.invocationId !== parsed.data.invocationId
      ) {
        throw new CapabilityInvocationAuditTransitionError()
      }
      return runState.deadlineExpired ? 'stale' : 'recorded'
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
  }
  return Object.freeze(repository)
}
