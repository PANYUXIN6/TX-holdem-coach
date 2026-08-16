import { z } from 'zod'
import {
  NonnegativeSafeIntegerSchema,
  PositiveSafeIntegerSchema,
} from '../audit/audit-primitives.js'
import { FoundationProtocolError } from './errors.js'
import type { RuntimeType } from './runtime-definition.js'

export const EXECUTION_BUDGET_SCHEMA_VERSION = 1 as const

const ExecutionBudgetSchema = z
  .strictObject({
    budgetSchemaVersion: z.literal(EXECUTION_BUDGET_SCHEMA_VERSION),
    maxAttempts: PositiveSafeIntegerSchema,
    maxInputTokens: PositiveSafeIntegerSchema,
    maxOutputTokens: PositiveSafeIntegerSchema,
    maxWallClockMs: PositiveSafeIntegerSchema,
    maxCapabilityInvocations: NonnegativeSafeIntegerSchema,
    maxCostMicrounits: NonnegativeSafeIntegerSchema,
    maxOwnerConcurrentRuns: PositiveSafeIntegerSchema,
    maxSystemConcurrentRuns: PositiveSafeIntegerSchema,
    minimumAttemptStartRemainingMs: PositiveSafeIntegerSchema,
    attemptTimeoutMs: PositiveSafeIntegerSchema,
  })
  .superRefine((budget, context) => {
    if (budget.attemptTimeoutMs > budget.maxWallClockMs) {
      context.addIssue({ code: 'custom', path: ['attemptTimeoutMs'] })
    }
    if (budget.minimumAttemptStartRemainingMs > budget.attemptTimeoutMs) {
      context.addIssue({
        code: 'custom',
        path: ['minimumAttemptStartRemainingMs'],
      })
    }
    if (budget.maxOwnerConcurrentRuns > budget.maxSystemConcurrentRuns) {
      context.addIssue({
        code: 'custom',
        path: ['maxOwnerConcurrentRuns'],
      })
    }
  })

export type ExecutionBudget = Readonly<z.infer<typeof ExecutionBudgetSchema>>

export interface PlayerRuntimeBudgetInput {
  readonly runtimeType: 'player'
  readonly attemptTimeoutSeconds: number
  readonly decisionDeadlineSeconds: number
}

export interface CoachRuntimeBudgetInput {
  readonly runtimeType: 'coach'
}

export type RuntimeBudgetInput<TRuntime extends RuntimeType> =
  TRuntime extends 'player' ? PlayerRuntimeBudgetInput : CoachRuntimeBudgetInput

export interface RuntimeBudgetPolicy<TRuntime extends RuntimeType> {
  readonly runtimeType: TRuntime
  readonly policyVersion: number
  createSnapshot(input: RuntimeBudgetInput<TRuntime>): ExecutionBudget
}

const runtimeBudgetPolicies = new WeakSet<object>()

export function createRuntimeBudgetPolicy<TRuntime extends RuntimeType>(input: {
  readonly runtimeType: TRuntime
  readonly policyVersion: number
  readonly validationInput: RuntimeBudgetInput<TRuntime>
  readonly createSnapshot: (input: RuntimeBudgetInput<TRuntime>) => unknown
}): RuntimeBudgetPolicy<TRuntime> {
  if (
    (input.runtimeType !== 'player' && input.runtimeType !== 'coach') ||
    !Number.isSafeInteger(input.policyVersion) ||
    input.policyVersion <= 0 ||
    typeof input.createSnapshot !== 'function'
  ) {
    throw new FoundationProtocolError('invalidExecutionBudget')
  }

  const createValidatedSnapshot = (
    snapshotInput: RuntimeBudgetInput<TRuntime>,
  ): ExecutionBudget =>
    createExecutionBudget(input.createSnapshot(snapshotInput))

  createValidatedSnapshot(input.validationInput)
  const policy = Object.freeze({
    runtimeType: input.runtimeType,
    policyVersion: input.policyVersion,
    createSnapshot: createValidatedSnapshot,
  })
  runtimeBudgetPolicies.add(policy)
  return policy
}

export function isRuntimeBudgetPolicy(
  value: unknown,
): value is RuntimeBudgetPolicy<RuntimeType> {
  return (
    typeof value === 'object' &&
    value !== null &&
    runtimeBudgetPolicies.has(value)
  )
}

export const ExecutionUsageSchema = z.strictObject({
  attempts: NonnegativeSafeIntegerSchema,
  inputTokens: NonnegativeSafeIntegerSchema,
  outputTokens: NonnegativeSafeIntegerSchema,
  capabilityInvocations: NonnegativeSafeIntegerSchema,
  costMicrounits: NonnegativeSafeIntegerSchema,
  elapsedMs: NonnegativeSafeIntegerSchema,
})

export type ExecutionUsage = Readonly<z.infer<typeof ExecutionUsageSchema>>

const AnticipatedExecutionUsageSchema = ExecutionUsageSchema.omit({
  attempts: true,
})

const ExecutionBudgetCheckSchema = z.strictObject({
  purpose: z.enum(['continue', 'startAttempt']),
  anticipatedUsage: AnticipatedExecutionUsageSchema,
})

export type ExecutionBudgetCheck = Readonly<
  z.infer<typeof ExecutionBudgetCheckSchema>
>

export type BudgetDecision =
  | { readonly kind: 'allowed'; readonly remainingWallClockMs: number }
  | {
      readonly kind: 'exhausted'
      readonly reason:
        | 'attempts'
        | 'inputTokens'
        | 'outputTokens'
        | 'capabilityInvocations'
        | 'cost'
        | 'wallClock'
        | 'minimumAttemptWindow'
    }

export function createExecutionBudget(input: unknown): ExecutionBudget {
  const parsed = ExecutionBudgetSchema.safeParse(input)
  if (!parsed.success) {
    throw new FoundationProtocolError('invalidExecutionBudget')
  }
  return Object.freeze(parsed.data)
}

export function evaluateExecutionBudget(
  budgetInput: unknown,
  usageInput: unknown,
  checkInput: unknown,
): BudgetDecision {
  let budget: ExecutionBudget
  try {
    budget = createExecutionBudget(budgetInput)
  } catch {
    throw new FoundationProtocolError('invalidExecutionBudget')
  }
  const usage = ExecutionUsageSchema.safeParse(usageInput)
  if (!usage.success) {
    throw new FoundationProtocolError('invalidExecutionBudget')
  }

  const check = ExecutionBudgetCheckSchema.safeParse(checkInput)
  if (!check.success) {
    throw new FoundationProtocolError('invalidExecutionBudget')
  }
  const anticipatedAttempts = check.data.purpose === 'startAttempt' ? 1 : 0

  const limits = [
    ['attempts', usage.data.attempts, anticipatedAttempts, budget.maxAttempts],
    [
      'inputTokens',
      usage.data.inputTokens,
      check.data.anticipatedUsage.inputTokens,
      budget.maxInputTokens,
    ],
    [
      'outputTokens',
      usage.data.outputTokens,
      check.data.anticipatedUsage.outputTokens,
      budget.maxOutputTokens,
    ],
    [
      'capabilityInvocations',
      usage.data.capabilityInvocations,
      check.data.anticipatedUsage.capabilityInvocations,
      budget.maxCapabilityInvocations,
    ],
    [
      'cost',
      usage.data.costMicrounits,
      check.data.anticipatedUsage.costMicrounits,
      budget.maxCostMicrounits,
    ],
    [
      'wallClock',
      usage.data.elapsedMs,
      check.data.anticipatedUsage.elapsedMs,
      budget.maxWallClockMs,
    ],
  ] as const

  for (const [reason, consumed, anticipated, maximum] of limits) {
    if (consumed > maximum || anticipated > maximum - consumed) {
      return Object.freeze({ kind: 'exhausted', reason })
    }
  }

  const remainingWallClockMs = budget.maxWallClockMs - usage.data.elapsedMs
  if (
    check.data.purpose === 'startAttempt' &&
    remainingWallClockMs < budget.minimumAttemptStartRemainingMs
  ) {
    return Object.freeze({
      kind: 'exhausted',
      reason: 'minimumAttemptWindow',
    })
  }

  return Object.freeze({ kind: 'allowed', remainingWallClockMs })
}
