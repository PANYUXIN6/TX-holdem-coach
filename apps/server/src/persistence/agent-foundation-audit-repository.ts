import { randomUUID } from 'node:crypto'
import type { TransactionSql } from 'postgres'
import { z } from 'zod'
import {
  CanonicalAuditReferenceIdSchema,
  StableAuditCodeSchema,
} from '../agents/audit/audit-primitives.js'
import {
  encodeAttemptAuditV1,
  type AttemptAuditV1,
} from '../agents/audit/attempt-audit-codec-v1.js'
import { productionAttemptAuditVersionRegistry } from '../agents/audit/attempt-audit-version-registry.js'
import {
  AgentAuditPayloadValidationError,
  AgentAuditPayloadVersionError,
} from '../agents/audit/errors.js'
import {
  encodeExecutionBudgetAuditV1,
  type ExecutionBudgetAuditV1,
} from '../agents/audit/execution-budget-audit-codec-v1.js'
import { productionExecutionBudgetAuditVersionRegistry } from '../agents/audit/execution-budget-audit-version-registry.js'
import {
  encodeRunConfigurationAuditV1,
  type RunConfigurationAuditV1,
} from '../agents/audit/run-configuration-audit-codec-v1.js'
import { productionRunConfigurationAuditVersionRegistry } from '../agents/audit/run-configuration-audit-version-registry.js'
import type {
  AgentAuditDecoderBundle,
  CoachRuntimeAuditDecodeInput,
  CoachRuntimeAuditShape,
  EmptyCoachRuntimeAudit,
  EmptyPlayerRuntimeAudit,
  PlayerRuntimeAuditDecodeInput,
  PlayerRuntimeAuditShape,
} from '../agents/audit/runtime-audit-extension-decoder.js'
import {
  EMPTY_COACH_RUNTIME_AUDIT,
  EMPTY_PLAYER_RUNTIME_AUDIT,
} from '../agents/audit/runtime-audit-extension-decoder.js'
import {
  AgentAttemptAuditTransitionError,
  DatabaseOperationError,
  PersistenceDataCorruptionError,
  RepositoryInputValidationError,
  ResourceNotFoundError,
  UnknownPayloadVersionError,
} from './errors.js'
import { isResolvedOwnerScope, type ResolvedOwnerScope } from './owner-scope.js'

const POSTGRES_TEXT_OID = 25
const CanonicalUtcTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => {
    const milliseconds = Date.parse(value)
    return (
      Number.isFinite(milliseconds) &&
      new Date(milliseconds).toISOString() === value
    )
  })
const DatabaseUtcTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
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
const NonblankDatabaseTextSchema = z
  .string()
  .refine((value) => value.trim().length > 0)
const IdempotencyKeySchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-z0-9](?:[a-z0-9._:/@-]*[a-z0-9])?$/)

const InsertAgentRunAuditBaseSchema = z.strictObject({
  agentRunId: z.uuid(),
  sessionId: z.uuid(),
  handId: z.uuid(),
  triggerType: StableAuditCodeSchema,
  idempotencyKey: IdempotencyKeySchema,
  parentRunId: z.uuid().nullable(),
  deadlineAt: CanonicalUtcTimestampSchema,
  runtimeDefinitionVersion: PositivePostgresIntegerSchema,
  runConfiguration: z.unknown(),
  budget: z.unknown(),
  createdAt: CanonicalUtcTimestampSchema,
})
const InsertAgentRunAuditInputSchema = z.discriminatedUnion('runtime', [
  InsertAgentRunAuditBaseSchema.extend({
    runtime: z.literal('player'),
    participantId: z.uuid(),
    sourceStateVersion: NonnegativeSafeIntegerSchema,
    decisionRequestId: z.uuid(),
  }),
  InsertAgentRunAuditBaseSchema.extend({
    runtime: z.literal('coach'),
    participantId: z.null(),
    sourceStateVersion: z.null(),
    decisionRequestId: z.null(),
  }),
])
const InsertedAgentRunRowSchema = z.strictObject({ agentRunId: z.uuid() })
const AgentRunParentScopeRowSchema = z.strictObject({
  handId: z.uuid(),
  participantId: z.uuid().nullable(),
  parentRunExists: z.boolean(),
})
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
const AgentAttemptAuditRowSchema = z.strictObject({
  attemptId: z.uuid(),
  agentRunId: z.uuid(),
  databaseOwnerId: z.uuid(),
  sessionId: z.uuid(),
  attemptNumber: z.number().int().min(0).max(2_147_483_647),
  stage: StableAuditCodeSchema,
  lifecycle: z.enum(['started', 'completed', 'failed', 'cancelled', 'stale']),
  accepted: z.boolean(),
  stale: z.boolean(),
  interrupted: z.boolean(),
  provider: CanonicalAuditReferenceIdSchema,
  model: CanonicalAuditReferenceIdSchema,
  attemptType: StableAuditCodeSchema,
  routingReasonCode: StableAuditCodeSchema.nullable(),
  inputTokens: NonnegativeSafeIntegerSchema,
  outputTokens: NonnegativeSafeIntegerSchema,
  costMicrounits: NonnegativeSafeIntegerSchema,
  durationMs: NonnegativeSafeIntegerSchema.nullable(),
  errorCode: StableAuditCodeSchema.nullable(),
  payloadVersion: z.unknown(),
  payload: z.unknown(),
  startedAt: DatabaseUtcTimestampSchema,
  completedAt: DatabaseUtcTimestampSchema.nullable(),
  createdAt: DatabaseUtcTimestampSchema,
})
const CapabilityInvocationAuditRowSchema = z.strictObject({
  invocationId: z.uuid(),
  agentRunId: z.uuid(),
  databaseOwnerId: z.uuid(),
  sessionId: z.uuid(),
  invocationNumber: z.number().int().min(0).max(2_147_483_647),
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
  payloadVersion: z.unknown().nullable(),
  payload: z.unknown().nullable(),
  startedAt: DatabaseUtcTimestampSchema,
  completedAt: DatabaseUtcTimestampSchema,
  createdAt: DatabaseUtcTimestampSchema,
})
const RuntimePayloadSchema = z.strictObject({
  rowPayloadVersion: PositiveSafeIntegerSchema,
  payload: z.record(z.string(), z.unknown()),
})
const PlayerDecisionAuditRowSchema = z.strictObject({
  decisionId: z.uuid(),
  agentRunId: z.uuid(),
  databaseOwnerId: z.uuid(),
  sessionId: z.uuid(),
  handId: z.uuid(),
  participantId: z.uuid(),
  sourceStateVersion: NonnegativeSafeIntegerSchema,
  decisionRequestId: z.uuid(),
  memoryRevision: NonnegativeSafeIntegerSchema,
  runtime: z.literal('player'),
  submissionStatus: z.enum(['pending', 'committed', 'rejected', 'stale']),
  commandLedgerId: z.uuid().nullable(),
  decisionPacketPayloadVersion: PositiveSafeIntegerSchema,
  decisionPacketPayload: z.record(z.string(), z.unknown()),
  candidateSetPayloadVersion: PositiveSafeIntegerSchema,
  candidateSetPayload: z.record(z.string(), z.unknown()),
  validatorResultPayloadVersion: PositiveSafeIntegerSchema,
  validatorResultPayload: z.record(z.string(), z.unknown()),
  createdAt: DatabaseUtcTimestampSchema,
  submittedAt: DatabaseUtcTimestampSchema.nullable(),
})
const CoachDecisionAssessmentAuditRowSchema = z.strictObject({
  assessmentId: z.uuid(),
  coachReviewId: z.uuid(),
  databaseOwnerId: z.uuid(),
  sessionId: z.uuid(),
  handId: z.uuid(),
  decisionId: z.uuid(),
  street: z.enum(['preflop', 'flop', 'turn', 'river']),
  ordinalOnStreet: z.number().int().min(0).max(2_147_483_647),
  assessmentPayloadVersion: PositiveSafeIntegerSchema,
  assessmentPayload: z.record(z.string(), z.unknown()),
  createdAt: DatabaseUtcTimestampSchema,
})
const CoachReviewAuditRowSchema = z.strictObject({
  reviewId: z.uuid(),
  agentRunId: z.uuid(),
  databaseOwnerId: z.uuid(),
  sessionId: z.uuid(),
  handId: z.uuid(),
  runtime: z.literal('coach'),
  requestId: z.uuid(),
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  frozenContextPayloadVersion: PositiveSafeIntegerSchema,
  frozenContextPayload: z.record(z.string(), z.unknown()),
  analysisPayloadVersion: PositiveSafeIntegerSchema.nullable(),
  analysisPayload: z.record(z.string(), z.unknown()).nullable(),
  hindsightPayloadVersion: PositiveSafeIntegerSchema.nullable(),
  hindsightPayload: z.record(z.string(), z.unknown()).nullable(),
  finalReportPayloadVersion: PositiveSafeIntegerSchema.nullable(),
  finalReportPayload: z.record(z.string(), z.unknown()).nullable(),
  assessments: z.array(CoachDecisionAssessmentAuditRowSchema),
  requestedAt: DatabaseUtcTimestampSchema,
  completedAt: DatabaseUtcTimestampSchema.nullable(),
  updatedAt: DatabaseUtcTimestampSchema,
})
const AgentRunAuditRowSchema = z.strictObject({
  agentRunId: z.uuid(),
  databaseOwnerId: z.uuid(),
  sessionId: z.uuid(),
  handId: z.uuid(),
  runtime: z.enum(['player', 'coach']),
  triggerType: StableAuditCodeSchema,
  lifecycle: z.enum([
    'queued',
    'leased',
    'running',
    'completed',
    'failed',
    'cancelled',
    'stale',
  ]),
  idempotencyKey: IdempotencyKeySchema,
  participantId: z.uuid().nullable(),
  sourceStateVersion: NonnegativeSafeIntegerSchema.nullable(),
  decisionRequestId: z.uuid().nullable(),
  parentRunId: z.uuid().nullable(),
  replacementRunId: z.uuid().nullable(),
  leaseOwner: NonblankDatabaseTextSchema.nullable(),
  leaseExpiresAt: DatabaseUtcTimestampSchema.nullable(),
  fencingToken: NonnegativeSafeIntegerSchema,
  deadlineAt: DatabaseUtcTimestampSchema,
  runtimeDefinitionVersion: PositivePostgresIntegerSchema,
  terminationCode: StableAuditCodeSchema.nullable(),
  runConfigurationPayloadVersion: z.unknown(),
  runConfigurationPayload: z.unknown(),
  budgetPayloadVersion: z.unknown(),
  budgetPayload: z.unknown(),
  checkpointPayloadVersion: z.unknown().nullable(),
  checkpointPayload: z.unknown().nullable(),
  resultPayloadVersion: z.unknown().nullable(),
  resultPayload: z.unknown().nullable(),
  createdAt: DatabaseUtcTimestampSchema,
  startedAt: DatabaseUtcTimestampSchema.nullable(),
  completedAt: DatabaseUtcTimestampSchema.nullable(),
  updatedAt: DatabaseUtcTimestampSchema,
  attempts: z.array(z.unknown()),
  invocations: z.array(z.unknown()),
  playerDecision: z.unknown().nullable(),
  coachReview: z.unknown().nullable(),
})

interface InsertAgentRunAuditBaseInput {
  readonly agentRunId: string
  readonly sessionId: string
  readonly handId: string
  readonly triggerType: string
  readonly idempotencyKey: string
  readonly parentRunId: string | null
  readonly deadlineAt: string
  readonly runtimeDefinitionVersion: number
  readonly runConfiguration: RunConfigurationAuditV1
  readonly budget: ExecutionBudgetAuditV1
  readonly createdAt: string
}

export type InsertAgentRunAuditInput = InsertAgentRunAuditBaseInput &
  (
    | {
        readonly runtime: 'player'
        readonly participantId: string
        readonly sourceStateVersion: number
        readonly decisionRequestId: string
      }
    | {
        readonly runtime: 'coach'
        readonly participantId: null
        readonly sourceStateVersion: null
        readonly decisionRequestId: null
      }
  )

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

export interface AgentAttemptAudit {
  readonly attemptId: string
  readonly attemptNumber: number
  readonly stage: string
  readonly lifecycle: 'started' | 'completed' | 'failed' | 'cancelled' | 'stale'
  readonly accepted: boolean
  readonly stale: boolean
  readonly interrupted: boolean
  readonly provider: string
  readonly model: string
  readonly attemptType: string
  readonly routingReasonCode: string | null
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costMicrounits: number
  readonly durationMs: number | null
  readonly errorCode: string | null
  readonly actualTimeoutMs: number
  readonly remainingDeadlineMsAtStart: number
  readonly requestProjectionHash: string
  readonly responseProjectionHash: string | null
  readonly validationStatus: 'notRun' | 'valid' | 'invalid'
  readonly startedAt: string
  readonly completedAt: string | null
  readonly createdAt: string
}

export interface CapabilityInvocationAudit {
  readonly invocationId: string
  readonly invocationNumber: number
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
  readonly createdAt: string
}

interface AgentRunAuditBase {
  readonly ownerId: ResolvedOwnerScope['ownerId']
  readonly agentRunId: string
  readonly sessionId: string
  readonly handId: string
  readonly triggerType: string
  readonly lifecycle:
    | 'queued'
    | 'leased'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'stale'
  readonly idempotencyKey: string
  readonly participantId: string | null
  readonly sourceStateVersion: number | null
  readonly decisionRequestId: string | null
  readonly parentRunId: string | null
  readonly replacementRunId: string | null
  readonly leaseOwner: string | null
  readonly leaseExpiresAt: string | null
  readonly fencingToken: number
  readonly deadlineAt: string
  readonly runtimeDefinitionVersion: number
  readonly terminationCode: string | null
  readonly runConfiguration: RunConfigurationAuditV1
  readonly budget: ExecutionBudgetAuditV1
  readonly createdAt: string
  readonly startedAt: string | null
  readonly completedAt: string | null
  readonly updatedAt: string
  readonly attempts: readonly AgentAttemptAudit[]
  readonly invocations: readonly CapabilityInvocationAudit[]
}

export type AgentRunAudit<
  TPlayerRuntimeAudit extends PlayerRuntimeAuditShape,
  TCoachRuntimeAudit extends CoachRuntimeAuditShape,
> =
  | (AgentRunAuditBase & {
      readonly runtime: 'player'
      readonly participantId: string
      readonly sourceStateVersion: number
      readonly decisionRequestId: string
      readonly runtimeAudit: TPlayerRuntimeAudit
    })
  | (AgentRunAuditBase & {
      readonly runtime: 'coach'
      readonly participantId: null
      readonly sourceStateVersion: null
      readonly decisionRequestId: null
      readonly runtimeAudit: TCoachRuntimeAudit
    })

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

function decodeRunConfigurationForWrite(input: unknown) {
  try {
    return encodeRunConfigurationAuditV1(input)
  } catch (error) {
    if (
      error instanceof AgentAuditPayloadValidationError ||
      error instanceof AgentAuditPayloadVersionError
    ) {
      throw new RepositoryInputValidationError()
    }
    throw error
  }
}

function decodeExecutionBudgetForWrite(input: unknown) {
  try {
    return encodeExecutionBudgetAuditV1(input)
  } catch (error) {
    if (
      error instanceof AgentAuditPayloadValidationError ||
      error instanceof AgentAuditPayloadVersionError
    ) {
      throw new RepositoryInputValidationError()
    }
    throw error
  }
}

function readAgentAttempts(
  input: readonly unknown[],
  identity: {
    readonly agentRunId: string
    readonly databaseOwnerId: string
    readonly sessionId: string
  },
): readonly AgentAttemptAudit[] {
  const parsed = z.array(AgentAttemptAuditRowSchema).safeParse(input)
  if (!parsed.success) {
    throw new PersistenceDataCorruptionError('invalidAgentAttemptAudit')
  }
  const rows = [...parsed.data].sort(
    (left, right) => left.attemptNumber - right.attemptNumber,
  )
  return rows.map((row, index) => {
    if (
      row.agentRunId !== identity.agentRunId ||
      row.databaseOwnerId !== identity.databaseOwnerId ||
      row.sessionId !== identity.sessionId ||
      row.attemptNumber !== index
    ) {
      throw new PersistenceDataCorruptionError('invalidAgentAttemptAudit')
    }
    const decoded = productionAttemptAuditVersionRegistry.read(
      row.lifecycle,
      row.payloadVersion,
      row.payload,
    )
    if (decoded.kind === 'unknownVersion') {
      throw new UnknownPayloadVersionError('agentAttempt')
    }
    if (decoded.kind === 'invalidPayload') {
      throw new PersistenceDataCorruptionError('invalidAgentAttemptAudit')
    }
    if (decoded.value.lifecycle !== row.lifecycle) {
      throw new PersistenceDataCorruptionError('invalidAgentAttemptAudit')
    }
    const structuralMatrixIsValid =
      row.lifecycle === 'started'
        ? !row.accepted &&
          !row.stale &&
          !row.interrupted &&
          row.inputTokens === 0 &&
          row.outputTokens === 0 &&
          row.costMicrounits === 0 &&
          row.durationMs === null &&
          row.errorCode === null &&
          row.completedAt === null
        : row.lifecycle === 'completed'
          ? !row.stale &&
            !row.interrupted &&
            row.durationMs !== null &&
            row.errorCode === null &&
            row.completedAt !== null &&
            decoded.value.lifecycle === 'completed' &&
            (!row.accepted || decoded.value.validationStatus === 'valid')
          : row.lifecycle === 'failed'
            ? !row.accepted &&
              !row.stale &&
              row.durationMs !== null &&
              row.errorCode !== null &&
              row.completedAt !== null
            : row.lifecycle === 'cancelled'
              ? !row.accepted &&
                !row.stale &&
                row.interrupted &&
                row.durationMs !== null &&
                row.errorCode !== null &&
                row.completedAt !== null
              : !row.accepted &&
                row.stale &&
                row.durationMs !== null &&
                row.completedAt !== null
    if (!structuralMatrixIsValid) {
      throw new PersistenceDataCorruptionError('invalidAgentAttemptAudit')
    }
    return deepFreeze({
      attemptId: row.attemptId,
      attemptNumber: row.attemptNumber,
      stage: row.stage,
      lifecycle: row.lifecycle,
      accepted: row.accepted,
      stale: row.stale,
      interrupted: row.interrupted,
      provider: row.provider,
      model: row.model,
      attemptType: row.attemptType,
      routingReasonCode: row.routingReasonCode,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      costMicrounits: row.costMicrounits,
      durationMs: row.durationMs,
      errorCode: row.errorCode,
      actualTimeoutMs: decoded.value.actualTimeoutMs,
      remainingDeadlineMsAtStart: decoded.value.remainingDeadlineMsAtStart,
      requestProjectionHash: decoded.value.requestProjectionHash,
      responseProjectionHash:
        decoded.value.lifecycle === 'started'
          ? null
          : decoded.value.responseProjectionHash,
      validationStatus:
        decoded.value.lifecycle === 'started'
          ? ('notRun' as const)
          : decoded.value.validationStatus,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      createdAt: row.createdAt,
    })
  })
}

function readCapabilityInvocations(
  input: readonly unknown[],
  identity: {
    readonly agentRunId: string
    readonly databaseOwnerId: string
    readonly sessionId: string
  },
): readonly CapabilityInvocationAudit[] {
  const parsed = z.array(CapabilityInvocationAuditRowSchema).safeParse(input)
  if (!parsed.success) {
    throw new PersistenceDataCorruptionError('invalidCapabilityInvocationAudit')
  }
  const rows = [...parsed.data].sort(
    (left, right) => left.invocationNumber - right.invocationNumber,
  )
  return rows.map((row, index) => {
    if (
      row.agentRunId !== identity.agentRunId ||
      row.databaseOwnerId !== identity.databaseOwnerId ||
      row.sessionId !== identity.sessionId ||
      row.invocationNumber !== index ||
      (row.payloadVersion === null) !== (row.payload === null) ||
      (row.outputSchemaVersion === null) !== (row.outputHash === null) ||
      (!row.authorized && row.errorCode === null) ||
      (row.errorCode !== null && row.outputSchemaVersion !== null)
    ) {
      throw new PersistenceDataCorruptionError(
        'invalidCapabilityInvocationAudit',
      )
    }
    if (row.payloadVersion !== null) {
      throw new UnknownPayloadVersionError('capabilityInvocationPayload')
    }
    return deepFreeze({
      invocationId: row.invocationId,
      invocationNumber: row.invocationNumber,
      capabilityName: row.capabilityName,
      capabilityVersion: row.capabilityVersion,
      authorized: row.authorized,
      inputSchemaVersion: row.inputSchemaVersion,
      inputHash: row.inputHash,
      outputSchemaVersion: row.outputSchemaVersion,
      outputHash: row.outputHash,
      budgetCost: row.budgetCost,
      durationMs: row.durationMs,
      errorCode: row.errorCode,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      createdAt: row.createdAt,
    })
  })
}

function runtimePayload(
  rowPayloadVersion: unknown | null,
  payload: unknown | null,
): { readonly rowPayloadVersion: number; readonly payload: unknown } | null {
  if ((rowPayloadVersion === null) !== (payload === null)) {
    throw new PersistenceDataCorruptionError('invalidRuntimeAuditExtension')
  }
  if (rowPayloadVersion === null) return null
  const parsed = RuntimePayloadSchema.safeParse({ rowPayloadVersion, payload })
  if (!parsed.success) {
    throw new PersistenceDataCorruptionError('invalidRuntimeAuditExtension')
  }
  return parsed.data
}

function assertRuntimeDecoderResult(
  value: unknown,
  keys: readonly string[],
  presence: readonly boolean[],
): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key, index) => {
      const nestedValue = (value as Record<string, unknown>)[key]
      return presence[index]
        ? nestedValue === null || nestedValue === undefined
        : nestedValue !== null
    })
  ) {
    throw new PersistenceDataCorruptionError('invalidRuntimeAuditExtension')
  }
}

function decodePlayerRuntimeAudit<
  TPlayerRuntimeAudit extends PlayerRuntimeAuditShape,
>(
  row: z.infer<typeof AgentRunAuditRowSchema>,
  decoder:
    | AgentAuditDecoderBundle<
        TPlayerRuntimeAudit,
        EmptyCoachRuntimeAudit
      >['player']
    | undefined,
): TPlayerRuntimeAudit {
  const checkpoint = runtimePayload(
    row.checkpointPayloadVersion,
    row.checkpointPayload,
  )
  const result = runtimePayload(row.resultPayloadVersion, row.resultPayload)
  if (row.coachReview !== null) {
    throw new PersistenceDataCorruptionError('invalidRuntimeAuditExtension')
  }
  const parsedDecision =
    row.playerDecision === null
      ? null
      : PlayerDecisionAuditRowSchema.safeParse(row.playerDecision)
  if (parsedDecision !== null && !parsedDecision.success) {
    throw new PersistenceDataCorruptionError('invalidRuntimeAuditExtension')
  }
  const decisionRow = parsedDecision?.data ?? null
  if (
    decisionRow !== null &&
    (decisionRow.agentRunId !== row.agentRunId ||
      decisionRow.databaseOwnerId !== row.databaseOwnerId ||
      decisionRow.sessionId !== row.sessionId ||
      decisionRow.handId !== row.handId ||
      decisionRow.participantId !== row.participantId ||
      decisionRow.sourceStateVersion !== row.sourceStateVersion ||
      decisionRow.decisionRequestId !== row.decisionRequestId)
  ) {
    throw new PersistenceDataCorruptionError('invalidRuntimeAuditExtension')
  }
  if (checkpoint === null && result === null && decisionRow === null) {
    return EMPTY_PLAYER_RUNTIME_AUDIT as unknown as TPlayerRuntimeAudit
  }
  if (decoder === undefined) {
    if (checkpoint !== null) {
      throw new UnknownPayloadVersionError('agentRunCheckpoint')
    }
    if (result !== null) throw new UnknownPayloadVersionError('agentRunResult')
    if (decisionRow !== null) {
      throw new UnknownPayloadVersionError('playerDecisionPacket')
    }
    throw new PersistenceDataCorruptionError('invalidRuntimeAuditExtension')
  }
  const input: PlayerRuntimeAuditDecodeInput = {
    ownerId: row.databaseOwnerId,
    sessionId: row.sessionId,
    handId: row.handId,
    agentRunId: row.agentRunId,
    runtime: 'player',
    checkpoint,
    result,
    decision:
      decisionRow === null
        ? null
        : {
            decisionId: decisionRow.decisionId,
            agentRunId: decisionRow.agentRunId,
            ownerId: decisionRow.databaseOwnerId,
            sessionId: decisionRow.sessionId,
            handId: decisionRow.handId,
            participantId: decisionRow.participantId,
            sourceStateVersion: decisionRow.sourceStateVersion,
            decisionRequestId: decisionRow.decisionRequestId,
            memoryRevision: decisionRow.memoryRevision,
            runtime: 'player',
            submissionStatus: decisionRow.submissionStatus,
            commandLedgerId: decisionRow.commandLedgerId,
            decisionPacket: {
              rowPayloadVersion: decisionRow.decisionPacketPayloadVersion,
              payload: decisionRow.decisionPacketPayload,
            },
            candidateSet: {
              rowPayloadVersion: decisionRow.candidateSetPayloadVersion,
              payload: decisionRow.candidateSetPayload,
            },
            validatorResult: {
              rowPayloadVersion: decisionRow.validatorResultPayloadVersion,
              payload: decisionRow.validatorResultPayload,
            },
            createdAt: decisionRow.createdAt,
            submittedAt: decisionRow.submittedAt,
          },
  }
  let decoded: TPlayerRuntimeAudit
  try {
    decoded = decoder.decode(deepFreeze(input))
  } catch (error) {
    if (error instanceof UnknownPayloadVersionError) throw error
    throw new PersistenceDataCorruptionError('invalidRuntimeAuditExtension')
  }
  assertRuntimeDecoderResult(
    decoded,
    ['checkpoint', 'result', 'decision'],
    [checkpoint !== null, result !== null, decisionRow !== null],
  )
  return deepFreeze(decoded)
}

function decodeCoachRuntimeAudit<
  TCoachRuntimeAudit extends CoachRuntimeAuditShape,
>(
  row: z.infer<typeof AgentRunAuditRowSchema>,
  decoder:
    | AgentAuditDecoderBundle<
        EmptyPlayerRuntimeAudit,
        TCoachRuntimeAudit
      >['coach']
    | undefined,
): TCoachRuntimeAudit {
  const checkpoint = runtimePayload(
    row.checkpointPayloadVersion,
    row.checkpointPayload,
  )
  const result = runtimePayload(row.resultPayloadVersion, row.resultPayload)
  if (row.playerDecision !== null) {
    throw new PersistenceDataCorruptionError('invalidRuntimeAuditExtension')
  }
  const parsedReview =
    row.coachReview === null
      ? null
      : CoachReviewAuditRowSchema.safeParse(row.coachReview)
  if (parsedReview !== null && !parsedReview.success) {
    throw new PersistenceDataCorruptionError('invalidRuntimeAuditExtension')
  }
  const reviewRow = parsedReview?.data ?? null
  if (
    reviewRow !== null &&
    (reviewRow.agentRunId !== row.agentRunId ||
      reviewRow.databaseOwnerId !== row.databaseOwnerId ||
      reviewRow.sessionId !== row.sessionId ||
      reviewRow.handId !== row.handId ||
      (reviewRow.analysisPayloadVersion === null) !==
        (reviewRow.analysisPayload === null) ||
      (reviewRow.hindsightPayloadVersion === null) !==
        (reviewRow.hindsightPayload === null) ||
      (reviewRow.finalReportPayloadVersion === null) !==
        (reviewRow.finalReportPayload === null))
  ) {
    throw new PersistenceDataCorruptionError('invalidRuntimeAuditExtension')
  }
  const assessments =
    reviewRow === null
      ? []
      : [...reviewRow.assessments].sort((left, right) => {
          const streetOrder = ['preflop', 'flop', 'turn', 'river'] as const
          return (
            streetOrder.indexOf(left.street) -
              streetOrder.indexOf(right.street) ||
            left.ordinalOnStreet - right.ordinalOnStreet ||
            left.assessmentId.localeCompare(right.assessmentId)
          )
        })
  for (const assessment of assessments) {
    if (
      reviewRow === null ||
      assessment.coachReviewId !== reviewRow.reviewId ||
      assessment.databaseOwnerId !== row.databaseOwnerId ||
      assessment.sessionId !== row.sessionId ||
      assessment.handId !== row.handId
    ) {
      throw new PersistenceDataCorruptionError('invalidRuntimeAuditExtension')
    }
  }
  if (checkpoint === null && result === null && reviewRow === null) {
    return EMPTY_COACH_RUNTIME_AUDIT as unknown as TCoachRuntimeAudit
  }
  if (decoder === undefined) {
    if (checkpoint !== null) {
      throw new UnknownPayloadVersionError('agentRunCheckpoint')
    }
    if (result !== null) throw new UnknownPayloadVersionError('agentRunResult')
    if (reviewRow !== null) {
      throw new UnknownPayloadVersionError('coachFrozenContext')
    }
    throw new PersistenceDataCorruptionError('invalidRuntimeAuditExtension')
  }
  const input: CoachRuntimeAuditDecodeInput = {
    ownerId: row.databaseOwnerId,
    sessionId: row.sessionId,
    handId: row.handId,
    agentRunId: row.agentRunId,
    runtime: 'coach',
    checkpoint,
    result,
    review:
      reviewRow === null
        ? null
        : {
            reviewId: reviewRow.reviewId,
            agentRunId: reviewRow.agentRunId,
            ownerId: reviewRow.databaseOwnerId,
            sessionId: reviewRow.sessionId,
            handId: reviewRow.handId,
            runtime: 'coach',
            requestId: reviewRow.requestId,
            status: reviewRow.status,
            frozenContext: {
              rowPayloadVersion: reviewRow.frozenContextPayloadVersion,
              payload: reviewRow.frozenContextPayload,
            },
            analysis:
              reviewRow.analysisPayloadVersion === null
                ? null
                : {
                    rowPayloadVersion: reviewRow.analysisPayloadVersion,
                    payload: reviewRow.analysisPayload,
                  },
            hindsight:
              reviewRow.hindsightPayloadVersion === null
                ? null
                : {
                    rowPayloadVersion: reviewRow.hindsightPayloadVersion,
                    payload: reviewRow.hindsightPayload,
                  },
            finalReport:
              reviewRow.finalReportPayloadVersion === null
                ? null
                : {
                    rowPayloadVersion: reviewRow.finalReportPayloadVersion,
                    payload: reviewRow.finalReportPayload,
                  },
            assessments: assessments.map((assessment) => ({
              assessmentId: assessment.assessmentId,
              coachReviewId: assessment.coachReviewId,
              ownerId: assessment.databaseOwnerId,
              sessionId: assessment.sessionId,
              handId: assessment.handId,
              decisionId: assessment.decisionId,
              street: assessment.street,
              ordinalOnStreet: assessment.ordinalOnStreet,
              assessment: {
                rowPayloadVersion: assessment.assessmentPayloadVersion,
                payload: assessment.assessmentPayload,
              },
              createdAt: assessment.createdAt,
            })),
            requestedAt: reviewRow.requestedAt,
            completedAt: reviewRow.completedAt,
            updatedAt: reviewRow.updatedAt,
          },
  }
  let decoded: TCoachRuntimeAudit
  try {
    decoded = decoder.decode(deepFreeze(input))
  } catch (error) {
    if (error instanceof UnknownPayloadVersionError) throw error
    throw new PersistenceDataCorruptionError('invalidRuntimeAuditExtension')
  }
  assertRuntimeDecoderResult(
    decoded,
    ['checkpoint', 'result', 'review'],
    [checkpoint !== null, result !== null, reviewRow !== null],
  )
  return deepFreeze(decoded)
}

export interface AgentFoundationAuditRepository<
  TPlayerRuntimeAudit extends PlayerRuntimeAuditShape,
  TCoachRuntimeAudit extends CoachRuntimeAuditShape,
> {
  insertAgentRunAudit(
    transaction: TransactionSql,
    owner: ResolvedOwnerScope,
    input: InsertAgentRunAuditInput,
  ): Promise<{ readonly agentRunId: string }>
  startAgentAttemptAudit(
    transaction: TransactionSql,
    owner: ResolvedOwnerScope,
    input: StartAgentAttemptAuditInput,
  ): Promise<{ readonly attemptId: string; readonly attemptNumber: number }>
  finishAgentAttemptAudit(
    transaction: TransactionSql,
    owner: ResolvedOwnerScope,
    input: FinishAgentAttemptAuditInput,
  ): Promise<void>
  appendCapabilityInvocationAudit(
    transaction: TransactionSql,
    owner: ResolvedOwnerScope,
    input: AppendCapabilityInvocationAuditInput,
  ): Promise<{
    readonly invocationId: string
    readonly invocationNumber: number
  }>
  readAgentRunAudit(
    transaction: TransactionSql,
    owner: ResolvedOwnerScope,
    sessionId: string,
    agentRunId: string,
  ): Promise<AgentRunAudit<TPlayerRuntimeAudit, TCoachRuntimeAudit>>
}

export function createAgentFoundationAuditRepository<
  TPlayerRuntimeAudit extends PlayerRuntimeAuditShape = EmptyPlayerRuntimeAudit,
  TCoachRuntimeAudit extends CoachRuntimeAuditShape = EmptyCoachRuntimeAudit,
>(options: {
  readonly runtimeAuditDecoders: AgentAuditDecoderBundle<
    TPlayerRuntimeAudit,
    TCoachRuntimeAudit
  >
}): AgentFoundationAuditRepository<TPlayerRuntimeAudit, TCoachRuntimeAudit> {
  const optionKeys =
    options !== null && typeof options === 'object' ? Object.keys(options) : []
  const decoderBundle =
    options !== null &&
    typeof options === 'object' &&
    options.runtimeAuditDecoders !== null &&
    typeof options.runtimeAuditDecoders === 'object' &&
    !Array.isArray(options.runtimeAuditDecoders)
      ? options.runtimeAuditDecoders
      : null
  const decoderKeys = decoderBundle === null ? [] : Object.keys(decoderBundle)
  if (
    optionKeys.length !== 1 ||
    optionKeys[0] !== 'runtimeAuditDecoders' ||
    decoderBundle === null ||
    decoderKeys.some((key) => key !== 'player' && key !== 'coach') ||
    (decoderBundle?.player !== undefined &&
      (decoderBundle.player.runtime !== 'player' ||
        typeof decoderBundle.player.decode !== 'function')) ||
    (decoderBundle?.coach !== undefined &&
      (decoderBundle.coach.runtime !== 'coach' ||
        typeof decoderBundle.coach.decode !== 'function'))
  ) {
    throw new RepositoryInputValidationError()
  }
  const runtimeAuditDecoders = Object.freeze({
    ...(decoderBundle.player === undefined
      ? {}
      : {
          player: Object.freeze({
            runtime: decoderBundle.player.runtime,
            decode: decoderBundle.player.decode,
          }),
        }),
    ...(decoderBundle.coach === undefined
      ? {}
      : {
          coach: Object.freeze({
            runtime: decoderBundle.coach.runtime,
            decode: decoderBundle.coach.decode,
          }),
        }),
  })

  return Object.freeze({
    async insertAgentRunAudit(
      transaction: TransactionSql,
      owner: ResolvedOwnerScope,
      input: InsertAgentRunAuditInput,
    ): Promise<{ readonly agentRunId: string }> {
      const parsed = InsertAgentRunAuditInputSchema.safeParse(input)
      if (!isResolvedOwnerScope(owner) || !parsed.success) {
        throw new RepositoryInputValidationError()
      }
      const configuration = decodeRunConfigurationForWrite(
        parsed.data.runConfiguration,
      )
      const budget = decodeExecutionBudgetForWrite(parsed.data.budget)
      if (
        configuration.payload.configuration.runtime !== parsed.data.runtime ||
        configuration.payload.configuration.runtimeDefinitionVersion !==
          parsed.data.runtimeDefinitionVersion
      ) {
        throw new RepositoryInputValidationError()
      }

      let parentScopeRows: readonly unknown[]
      try {
        parentScopeRows = await transaction`
          SELECT
            h.id::text AS "handId",
            CASE WHEN ${parsed.data.runtime} = 'player' THEN (
              SELECT sa.participant_id::text
              FROM app_private.session_agents AS sa
              WHERE sa.participant_id = ${parsed.data.participantId}::uuid
                AND sa.session_id = h.session_id
                AND sa.owner_id = h.owner_id
            ) ELSE NULL END AS "participantId",
            CASE WHEN ${parsed.data.parentRunId}::uuid IS NULL THEN true ELSE EXISTS (
              SELECT 1
              FROM app_private.agent_runs AS parent_run
              WHERE parent_run.id = ${parsed.data.parentRunId}::uuid
                AND parent_run.session_id = h.session_id
                AND parent_run.owner_id = h.owner_id
            ) END AS "parentRunExists"
          FROM app_private.hands AS h
          WHERE h.id = ${parsed.data.handId}::uuid
            AND h.session_id = ${parsed.data.sessionId}::uuid
            AND h.owner_id = ${owner.databaseOwnerId}::uuid
        `
      } catch {
        throw new DatabaseOperationError()
      }
      if (parentScopeRows.length === 0) throw new ResourceNotFoundError()
      const parentScope = z
        .array(AgentRunParentScopeRowSchema)
        .safeParse(parentScopeRows)
      if (!parentScope.success || parentScope.data.length !== 1) {
        throw new PersistenceDataCorruptionError('invalidAgentRunAudit')
      }
      if (
        parentScope.data[0]?.handId !== parsed.data.handId ||
        (parsed.data.runtime === 'player' &&
          parentScope.data[0]?.participantId !== parsed.data.participantId) ||
        !parentScope.data[0]?.parentRunExists
      ) {
        if (
          parentScope.data[0]?.handId === parsed.data.handId &&
          ((parsed.data.runtime === 'player' &&
            parentScope.data[0]?.participantId === null) ||
            !parentScope.data[0]?.parentRunExists)
        ) {
          throw new ResourceNotFoundError()
        }
        throw new PersistenceDataCorruptionError('invalidAgentRunAudit')
      }
      const configurationPayload = transaction.typed(
        JSON.stringify(configuration.payload),
        POSTGRES_TEXT_OID,
      )
      const budgetPayload = transaction.typed(
        JSON.stringify(budget.payload),
        POSTGRES_TEXT_OID,
      )

      let rows: readonly unknown[]
      try {
        rows = await transaction`
          INSERT INTO app_private.agent_runs (
            id,
            owner_id,
            session_id,
            runtime,
            trigger_type,
            lifecycle,
            idempotency_key,
            hand_id,
            participant_id,
            source_state_version,
            decision_request_id,
            parent_run_id,
            replacement_run_id,
            lease_owner,
            lease_expires_at,
            fencing_token,
            deadline_at,
            runtime_definition_version,
            termination_reason,
            run_config_payload_version,
            run_config_payload,
            budget_payload_version,
            budget_payload,
            checkpoint_payload_version,
            checkpoint_payload,
            result_payload_version,
            result_payload,
            created_at,
            started_at,
            completed_at,
            updated_at
          ) VALUES (
            ${parsed.data.agentRunId}::uuid,
            ${owner.databaseOwnerId}::uuid,
            ${parsed.data.sessionId}::uuid,
            ${parsed.data.runtime},
            ${parsed.data.triggerType},
            'queued',
            ${parsed.data.idempotencyKey},
            ${parsed.data.handId}::uuid,
            ${parsed.data.participantId}::uuid,
            ${parsed.data.sourceStateVersion}::bigint,
            ${parsed.data.decisionRequestId}::uuid,
            ${parsed.data.parentRunId}::uuid,
            NULL,
            NULL,
            NULL,
            0,
            ${parsed.data.deadlineAt}::timestamptz,
            ${parsed.data.runtimeDefinitionVersion},
            NULL,
            ${configuration.payloadVersion},
            ${configurationPayload}::jsonb,
            ${budget.payloadVersion},
            ${budgetPayload}::jsonb,
            NULL,
            NULL,
            NULL,
            NULL,
            ${parsed.data.createdAt}::timestamptz,
            NULL,
            NULL,
            ${parsed.data.createdAt}::timestamptz
          )
          RETURNING id::text AS "agentRunId"
        `
      } catch {
        throw new DatabaseOperationError()
      }
      const inserted = z.array(InsertedAgentRunRowSchema).safeParse(rows)
      if (
        !inserted.success ||
        inserted.data.length !== 1 ||
        inserted.data[0]?.agentRunId !== parsed.data.agentRunId
      ) {
        throw new PersistenceDataCorruptionError('invalidAgentRunAudit')
      }
      return Object.freeze({ agentRunId: parsed.data.agentRunId })
    },

    async startAgentAttemptAudit(
      transaction: TransactionSql,
      owner: ResolvedOwnerScope,
      input: StartAgentAttemptAuditInput,
    ): Promise<{ readonly attemptId: string; readonly attemptNumber: number }> {
      const parsed = StartAgentAttemptAuditInputSchema.safeParse(input)
      if (!isResolvedOwnerScope(owner) || !parsed.success) {
        throw new RepositoryInputValidationError()
      }
      let storedAttempt
      try {
        storedAttempt = encodeAttemptAuditV1({
          lifecycle: 'started',
          actualTimeoutMs: parsed.data.actualTimeoutMs,
          remainingDeadlineMsAtStart: parsed.data.remainingDeadlineMsAtStart,
          requestProjectionHash: parsed.data.requestProjectionHash,
        } satisfies AttemptAuditV1)
      } catch (error) {
        if (
          error instanceof AgentAuditPayloadValidationError ||
          error instanceof AgentAuditPayloadVersionError
        ) {
          throw new RepositoryInputValidationError()
        }
        throw error
      }

      let lockedRows: readonly unknown[]
      try {
        lockedRows = await transaction`
          SELECT
            id::text AS "agentRunId",
            session_id::text AS "sessionId"
          FROM app_private.agent_runs
          WHERE id = ${parsed.data.agentRunId}::uuid
            AND owner_id = ${owner.databaseOwnerId}::uuid
            AND session_id = ${parsed.data.sessionId}::uuid
          FOR UPDATE
        `
      } catch {
        throw new DatabaseOperationError()
      }
      if (lockedRows.length === 0) throw new ResourceNotFoundError()
      const locked = z.array(LockedAgentRunRowSchema).safeParse(lockedRows)
      if (
        !locked.success ||
        locked.data.length !== 1 ||
        locked.data[0]?.agentRunId !== parsed.data.agentRunId ||
        locked.data[0]?.sessionId !== parsed.data.sessionId
      ) {
        throw new PersistenceDataCorruptionError('invalidAgentRunAudit')
      }

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
      const payload = transaction.typed(
        JSON.stringify(storedAttempt.payload),
        POSTGRES_TEXT_OID,
      )

      let insertedRows: readonly unknown[]
      try {
        insertedRows = await transaction`
          INSERT INTO app_private.agent_attempts (
            id,
            agent_run_id,
            owner_id,
            session_id,
            attempt_number,
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
            ${payload}::jsonb,
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
      input: FinishAgentAttemptAuditInput,
    ): Promise<void> {
      const parsed = FinishAgentAttemptAuditInputSchema.safeParse(input)
      if (!isResolvedOwnerScope(owner) || !parsed.success) {
        throw new RepositoryInputValidationError()
      }

      let lockedRows: readonly unknown[]
      try {
        lockedRows = await transaction`
          SELECT
            id::text AS "attemptId",
            agent_run_id::text AS "agentRunId",
            session_id::text AS "sessionId",
            lifecycle,
            attempt_payload_version AS "payloadVersion",
            attempt_payload AS "payload"
          FROM app_private.agent_attempts
          WHERE id = ${parsed.data.attemptId}::uuid
            AND agent_run_id = ${parsed.data.agentRunId}::uuid
            AND owner_id = ${owner.databaseOwnerId}::uuid
            AND session_id = ${parsed.data.sessionId}::uuid
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
        locked.data[0]?.sessionId !== parsed.data.sessionId
      ) {
        throw new AgentAttemptAuditTransitionError()
      }
      const startedRow = locked.data[0]
      const startedRead = productionAttemptAuditVersionRegistry.read(
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
        terminalAttempt = encodeAttemptAuditV1({
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
      const payload = transaction.typed(
        JSON.stringify(terminalAttempt.payload),
        POSTGRES_TEXT_OID,
      )

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
              attempt_payload = ${payload}::jsonb,
              completed_at = ${parsed.data.completedAt}::timestamptz
          WHERE id = ${parsed.data.attemptId}::uuid
            AND agent_run_id = ${parsed.data.agentRunId}::uuid
            AND owner_id = ${owner.databaseOwnerId}::uuid
            AND session_id = ${parsed.data.sessionId}::uuid
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
      input: AppendCapabilityInvocationAuditInput,
    ): Promise<{
      readonly invocationId: string
      readonly invocationNumber: number
    }> {
      const parsed = AppendCapabilityInvocationAuditInputSchema.safeParse(input)
      if (!isResolvedOwnerScope(owner) || !parsed.success) {
        throw new RepositoryInputValidationError()
      }

      let lockedRows: readonly unknown[]
      try {
        lockedRows = await transaction`
          SELECT
            id::text AS "agentRunId",
            session_id::text AS "sessionId"
          FROM app_private.agent_runs
          WHERE id = ${parsed.data.agentRunId}::uuid
            AND owner_id = ${owner.databaseOwnerId}::uuid
            AND session_id = ${parsed.data.sessionId}::uuid
          FOR UPDATE
        `
      } catch {
        throw new DatabaseOperationError()
      }
      if (lockedRows.length === 0) throw new ResourceNotFoundError()
      const locked = z.array(LockedAgentRunRowSchema).safeParse(lockedRows)
      if (
        !locked.success ||
        locked.data.length !== 1 ||
        locked.data[0]?.agentRunId !== parsed.data.agentRunId ||
        locked.data[0]?.sessionId !== parsed.data.sessionId
      ) {
        throw new PersistenceDataCorruptionError('invalidAgentRunAudit')
      }

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
            invocation_payload_version,
            invocation_payload,
            started_at,
            completed_at,
            created_at
          ) VALUES (
            ${invocationId}::uuid,
            ${parsed.data.agentRunId}::uuid,
            ${owner.databaseOwnerId}::uuid,
            ${parsed.data.sessionId}::uuid,
            ${invocationNumber},
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
            NULL,
            NULL,
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

    async readAgentRunAudit(
      transaction: TransactionSql,
      owner: ResolvedOwnerScope,
      sessionId: string,
      agentRunId: string,
    ): Promise<AgentRunAudit<TPlayerRuntimeAudit, TCoachRuntimeAudit>> {
      const parsedIds = z
        .strictObject({ sessionId: z.uuid(), agentRunId: z.uuid() })
        .safeParse({ sessionId, agentRunId })
      if (!isResolvedOwnerScope(owner) || !parsedIds.success) {
        throw new RepositoryInputValidationError()
      }

      let rows: readonly unknown[]
      try {
        rows = await transaction`
          SELECT
            ar.id::text AS "agentRunId",
            ar.owner_id::text AS "databaseOwnerId",
            ar.session_id::text AS "sessionId",
            ar.hand_id::text AS "handId",
            ar.runtime,
            ar.trigger_type AS "triggerType",
            ar.lifecycle,
            ar.idempotency_key AS "idempotencyKey",
            ar.participant_id::text AS "participantId",
            ar.source_state_version::float8 AS "sourceStateVersion",
            ar.decision_request_id::text AS "decisionRequestId",
            ar.parent_run_id::text AS "parentRunId",
            ar.replacement_run_id::text AS "replacementRunId",
            ar.lease_owner AS "leaseOwner",
            CASE WHEN ar.lease_expires_at IS NULL THEN NULL ELSE
              to_char(ar.lease_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
            END AS "leaseExpiresAt",
            ar.fencing_token::float8 AS "fencingToken",
            to_char(ar.deadline_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "deadlineAt",
            ar.runtime_definition_version AS "runtimeDefinitionVersion",
            ar.termination_reason AS "terminationCode",
            ar.run_config_payload_version AS "runConfigurationPayloadVersion",
            ar.run_config_payload AS "runConfigurationPayload",
            ar.budget_payload_version AS "budgetPayloadVersion",
            ar.budget_payload AS "budgetPayload",
            ar.checkpoint_payload_version AS "checkpointPayloadVersion",
            ar.checkpoint_payload AS "checkpointPayload",
            ar.result_payload_version AS "resultPayloadVersion",
            ar.result_payload AS "resultPayload",
            to_char(ar.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
            CASE WHEN ar.started_at IS NULL THEN NULL ELSE
              to_char(ar.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
            END AS "startedAt",
            CASE WHEN ar.completed_at IS NULL THEN NULL ELSE
              to_char(ar.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
            END AS "completedAt",
            to_char(ar.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt",
            COALESCE((
              SELECT jsonb_agg(
                jsonb_build_object(
                  'attemptId', aa.id::text,
                  'agentRunId', aa.agent_run_id::text,
                  'databaseOwnerId', aa.owner_id::text,
                  'sessionId', aa.session_id::text,
                  'attemptNumber', aa.attempt_number,
                  'stage', aa.stage,
                  'lifecycle', aa.lifecycle,
                  'accepted', aa.accepted,
                  'stale', aa.stale,
                  'interrupted', aa.interrupted,
                  'provider', aa.provider,
                  'model', aa.model,
                  'attemptType', aa.attempt_type,
                  'routingReasonCode', aa.routing_reason,
                  'inputTokens', aa.input_tokens::float8,
                  'outputTokens', aa.output_tokens::float8,
                  'costMicrounits', aa.cost_microunits::float8,
                  'durationMs', aa.duration_ms::float8,
                  'errorCode', aa.error_category,
                  'payloadVersion', aa.attempt_payload_version,
                  'payload', aa.attempt_payload,
                  'startedAt', to_char(aa.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                  'completedAt', CASE WHEN aa.completed_at IS NULL THEN NULL ELSE to_char(aa.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
                  'createdAt', to_char(aa.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                ) ORDER BY aa.attempt_number
              )
              FROM app_private.agent_attempts AS aa
              WHERE aa.agent_run_id = ar.id
                AND aa.owner_id = ar.owner_id
                AND aa.session_id = ar.session_id
            ), '[]'::jsonb) AS attempts,
            COALESCE((
              SELECT jsonb_agg(
                jsonb_build_object(
                  'invocationId', aci.id::text,
                  'agentRunId', aci.agent_run_id::text,
                  'databaseOwnerId', aci.owner_id::text,
                  'sessionId', aci.session_id::text,
                  'invocationNumber', aci.invocation_number,
                  'capabilityName', aci.capability_name,
                  'capabilityVersion', aci.capability_version,
                  'authorized', aci.authorized,
                  'inputSchemaVersion', aci.input_schema_version,
                  'inputHash', aci.input_hash,
                  'outputSchemaVersion', aci.output_schema_version,
                  'outputHash', aci.output_hash,
                  'budgetCost', aci.budget_cost::float8,
                  'durationMs', aci.duration_ms::float8,
                  'errorCode', aci.error_category,
                  'payloadVersion', aci.invocation_payload_version,
                  'payload', aci.invocation_payload,
                  'startedAt', to_char(aci.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                  'completedAt', CASE WHEN aci.completed_at IS NULL THEN NULL ELSE to_char(aci.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
                  'createdAt', to_char(aci.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                ) ORDER BY aci.invocation_number
              )
              FROM app_private.agent_capability_invocations AS aci
              WHERE aci.agent_run_id = ar.id
                AND aci.owner_id = ar.owner_id
                AND aci.session_id = ar.session_id
            ), '[]'::jsonb) AS invocations,
            (
              SELECT jsonb_build_object(
                'decisionId', pd.id::text,
                'agentRunId', pd.agent_run_id::text,
                'databaseOwnerId', pd.owner_id::text,
                'sessionId', pd.session_id::text,
                'handId', pd.hand_id::text,
                'participantId', pd.participant_id::text,
                'sourceStateVersion', pd.source_state_version::float8,
                'decisionRequestId', pd.decision_request_id::text,
                'memoryRevision', pd.memory_revision::float8,
                'runtime', pd.runtime,
                'submissionStatus', pd.submission_status,
                'commandLedgerId', pd.command_ledger_id::text,
                'decisionPacketPayloadVersion', pd.decision_packet_payload_version,
                'decisionPacketPayload', pd.decision_packet_payload,
                'candidateSetPayloadVersion', pd.candidate_set_payload_version,
                'candidateSetPayload', pd.candidate_set_payload,
                'validatorResultPayloadVersion', pd.validator_result_payload_version,
                'validatorResultPayload', pd.validator_result_payload,
                'createdAt', to_char(pd.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                'submittedAt', CASE WHEN pd.submitted_at IS NULL THEN NULL ELSE to_char(pd.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END
              )
              FROM app_private.player_decisions AS pd
              WHERE pd.agent_run_id = ar.id
                AND pd.owner_id = ar.owner_id
                AND pd.session_id = ar.session_id
                AND pd.hand_id = ar.hand_id
            ) AS "playerDecision",
            (
              SELECT jsonb_build_object(
                'reviewId', cr.id::text,
                'agentRunId', cr.agent_run_id::text,
                'databaseOwnerId', cr.owner_id::text,
                'sessionId', cr.session_id::text,
                'handId', cr.hand_id::text,
                'runtime', cr.runtime,
                'requestId', cr.request_id::text,
                'status', cr.status,
                'frozenContextPayloadVersion', cr.frozen_context_payload_version,
                'frozenContextPayload', cr.frozen_context_payload,
                'analysisPayloadVersion', cr.analysis_payload_version,
                'analysisPayload', cr.analysis_payload,
                'hindsightPayloadVersion', cr.hindsight_payload_version,
                'hindsightPayload', cr.hindsight_payload,
                'finalReportPayloadVersion', cr.final_report_payload_version,
                'finalReportPayload', cr.final_report_payload,
                'assessments', COALESCE((
                  SELECT jsonb_agg(
                    jsonb_build_object(
                      'assessmentId', cda.id::text,
                      'coachReviewId', cda.coach_review_id::text,
                      'databaseOwnerId', cda.owner_id::text,
                      'sessionId', cda.session_id::text,
                      'handId', cda.hand_id::text,
                      'decisionId', cda.decision_id::text,
                      'street', cda.street,
                      'ordinalOnStreet', cda.ordinal_on_street,
                      'assessmentPayloadVersion', cda.assessment_payload_version,
                      'assessmentPayload', cda.assessment_payload,
                      'createdAt', to_char(cda.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                    ) ORDER BY
                      CASE cda.street
                        WHEN 'preflop' THEN 0
                        WHEN 'flop' THEN 1
                        WHEN 'turn' THEN 2
                        WHEN 'river' THEN 3
                      END,
                      cda.ordinal_on_street,
                      cda.id
                  )
                  FROM app_private.coach_decision_assessments AS cda
                  WHERE cda.coach_review_id = cr.id
                    AND cda.owner_id = cr.owner_id
                    AND cda.session_id = cr.session_id
                    AND cda.hand_id = cr.hand_id
                ), '[]'::jsonb),
                'requestedAt', to_char(cr.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                'completedAt', CASE WHEN cr.completed_at IS NULL THEN NULL ELSE to_char(cr.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
                'updatedAt', to_char(cr.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
              )
              FROM app_private.coach_reviews AS cr
              WHERE cr.agent_run_id = ar.id
                AND cr.owner_id = ar.owner_id
                AND cr.session_id = ar.session_id
                AND cr.hand_id = ar.hand_id
            ) AS "coachReview"
          FROM app_private.agent_runs AS ar
          WHERE ar.id = ${parsedIds.data.agentRunId}::uuid
            AND ar.session_id = ${parsedIds.data.sessionId}::uuid
            AND ar.owner_id = ${owner.databaseOwnerId}::uuid
        `
      } catch {
        throw new DatabaseOperationError()
      }
      if (rows.length === 0) throw new ResourceNotFoundError()
      if (rows.length !== 1) {
        throw new PersistenceDataCorruptionError('invalidAgentRunAudit')
      }
      const parsedRow = AgentRunAuditRowSchema.safeParse(rows[0])
      if (!parsedRow.success) {
        throw new PersistenceDataCorruptionError('invalidAgentRunAudit')
      }
      const row = parsedRow.data
      if (
        row.agentRunId !== parsedIds.data.agentRunId ||
        row.databaseOwnerId !== owner.databaseOwnerId ||
        row.sessionId !== parsedIds.data.sessionId ||
        (row.leaseOwner === null) !== (row.leaseExpiresAt === null)
      ) {
        throw new PersistenceDataCorruptionError('invalidAgentRunAudit')
      }
      const configurationRead =
        productionRunConfigurationAuditVersionRegistry.read(
          row.runConfigurationPayloadVersion,
          row.runConfigurationPayload,
        )
      if (configurationRead.kind === 'unknownVersion') {
        throw new UnknownPayloadVersionError('agentRunConfiguration')
      }
      if (configurationRead.kind === 'invalidPayload') {
        throw new PersistenceDataCorruptionError('invalidAgentRunAudit')
      }
      const budgetRead = productionExecutionBudgetAuditVersionRegistry.read(
        row.budgetPayloadVersion,
        row.budgetPayload,
      )
      if (budgetRead.kind === 'unknownVersion') {
        throw new UnknownPayloadVersionError('agentExecutionBudget')
      }
      if (budgetRead.kind === 'invalidPayload') {
        throw new PersistenceDataCorruptionError('invalidAgentRunAudit')
      }
      if (
        configurationRead.value.runtime !== row.runtime ||
        configurationRead.value.runtimeDefinitionVersion !==
          row.runtimeDefinitionVersion ||
        (row.checkpointPayloadVersion === null) !==
          (row.checkpointPayload === null) ||
        (row.resultPayloadVersion === null) !== (row.resultPayload === null)
      ) {
        throw new PersistenceDataCorruptionError('invalidAgentRunAudit')
      }
      const attempts = readAgentAttempts(row.attempts, row)
      const invocations = readCapabilityInvocations(row.invocations, row)
      const base: AgentRunAuditBase = {
        ownerId: owner.ownerId,
        agentRunId: row.agentRunId,
        sessionId: row.sessionId,
        handId: row.handId,
        triggerType: row.triggerType,
        lifecycle: row.lifecycle,
        idempotencyKey: row.idempotencyKey,
        participantId: row.participantId,
        sourceStateVersion: row.sourceStateVersion,
        decisionRequestId: row.decisionRequestId,
        parentRunId: row.parentRunId,
        replacementRunId: row.replacementRunId,
        leaseOwner: row.leaseOwner,
        leaseExpiresAt: row.leaseExpiresAt,
        fencingToken: row.fencingToken,
        deadlineAt: row.deadlineAt,
        runtimeDefinitionVersion: row.runtimeDefinitionVersion,
        terminationCode: row.terminationCode,
        runConfiguration: configurationRead.value,
        budget: budgetRead.value,
        createdAt: row.createdAt,
        startedAt: row.startedAt,
        completedAt: row.completedAt,
        updatedAt: row.updatedAt,
        attempts,
        invocations,
      }
      if (row.runtime === 'player') {
        if (
          row.participantId === null ||
          row.sourceStateVersion === null ||
          row.decisionRequestId === null ||
          row.coachReview !== null
        ) {
          throw new PersistenceDataCorruptionError('invalidAgentRunAudit')
        }
        const runtimeAudit = decodePlayerRuntimeAudit(
          row,
          runtimeAuditDecoders.player,
        )
        return deepFreeze({
          ...base,
          runtime: 'player',
          participantId: row.participantId,
          sourceStateVersion: row.sourceStateVersion,
          decisionRequestId: row.decisionRequestId,
          runtimeAudit,
        })
      }
      if (
        row.participantId !== null ||
        row.sourceStateVersion !== null ||
        row.decisionRequestId !== null ||
        row.playerDecision !== null
      ) {
        throw new PersistenceDataCorruptionError('invalidAgentRunAudit')
      }
      const runtimeAudit = decodeCoachRuntimeAudit(
        row,
        runtimeAuditDecoders.coach,
      )
      return deepFreeze({
        ...base,
        runtime: 'coach',
        participantId: null,
        sourceStateVersion: null,
        decisionRequestId: null,
        runtimeAudit,
      })
    },
  })
}
