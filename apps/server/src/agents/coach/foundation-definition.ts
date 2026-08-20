import { createCapabilityManifest } from '../foundation/capability-protocol.js'
import {
  createExecutionBudget,
  createRuntimeBudgetPolicy,
  type RuntimeBudgetPolicy,
} from '../foundation/execution-budget.js'
import type {
  RuntimeComponentReference,
  RuntimeDefinitionBase,
} from '../foundation/runtime-definition.js'

const coachCommitGate = Object.freeze({
  runtimeType: 'coach' as const,
  id: 'coach.commit-review',
  version: 1,
})

const coachCapabilityReferences = Object.freeze([
  { id: 'coach.compute-decision-metrics', version: 1 },
  { id: 'coach.lookup-strategy-baseline', version: 1 },
  { id: 'coach.get-opponent-evidence', version: 1 },
] as const satisfies readonly RuntimeComponentReference[])

export const coachRuntimeBudgetPolicy: RuntimeBudgetPolicy<'coach'> =
  createRuntimeBudgetPolicy({
    runtimeType: 'coach',
    policyVersion: 1,
    validationInput: { runtimeType: 'coach' },
    createSnapshot: () =>
      createExecutionBudget({
        budgetSchemaVersion: 1,
        maxAttempts: 4,
        maxInputTokens: 20_000,
        maxOutputTokens: 3_000,
        maxWallClockMs: 120_000,
        maxCapabilityInvocations: 3,
        maxCostMicrounits: 2_000_000,
        maxOwnerConcurrentRuns: 1,
        maxSystemConcurrentRuns: 2,
        minimumAttemptStartRemainingMs: 5_000,
        attemptTimeoutMs: 30_000,
      }),
  })

const coachCapabilityManifest = createCapabilityManifest({
  manifest: {
    runtimeType: 'coach',
    manifestVersion: 1,
    grants: coachCapabilityReferences.map((capability) => ({
      runtimeType: 'coach' as const,
      capability,
      maxInvocations: 1,
    })),
  },
  commitGate: coachCommitGate,
  maxCapabilityInvocations: 3,
})

export type CoachRuntimeDefinition = RuntimeDefinitionBase<
  'coach',
  'decisionAnalysis' | 'hindsight'
>

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const nestedValue of Object.values(value)) deepFreeze(nestedValue)
    if (!Object.isFrozen(value)) Object.freeze(value)
  }
  return value
}

export const coachRuntimeDefinition: CoachRuntimeDefinition = deepFreeze({
  runtimeType: 'coach',
  runtimeDefinitionVersion: 1,
  contextSchemaVersion: 1,
  contextKinds: Object.freeze(['decisionAnalysis', 'hindsight'] as const),
  contextPolicy: { id: 'coach.context-policy', version: 1 },
  promptModules: Object.freeze([
    { id: 'coach.prompt.system', version: 1 },
    { id: 'coach.prompt.review', version: 1 },
  ]),
  capabilityManifest: coachCapabilityManifest,
  budgetPolicy: coachRuntimeBudgetPolicy,
  routePolicy: { id: 'coach.route-policy', version: 1 },
  outputSchema: { id: 'coach.output.review', version: 1 },
  validator: { id: 'coach.validator.review', version: 1 },
  commitGate: coachCommitGate,
  recoveryPolicy: { id: 'coach.recovery.process-restart-cancel', version: 1 },
  modelToolPolicy: 'none',
})
