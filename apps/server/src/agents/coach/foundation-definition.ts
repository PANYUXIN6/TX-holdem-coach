import {
  createCapabilityDefinition,
  createCapabilityManifest,
  type CapabilityDefinition,
} from '../foundation/capability-protocol.js'
import {
  createExecutionBudget,
  createRuntimeBudgetPolicy,
  type RuntimeBudgetPolicy,
} from '../foundation/execution-budget.js'
import type {
  RuntimeComponentReference,
  RuntimeDefinitionBase,
} from '../foundation/runtime-definition.js'
import { createRuntimeStateMachineDefinition } from '../foundation/runtime-state-machine.js'

export type CoachRuntimeState =
  | 'decisionContextPending'
  | 'evidencePending'
  | 'decisionAnalysisPending'
  | 'hindsightContextPending'
  | 'hindsightAnalysisPending'
  | 'reportValidationPending'
  | 'commitPending'
  | 'succeeded'
  | 'cancelled'
  | 'failed'

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

export const coachCapabilityDefinitions: readonly CapabilityDefinition<'coach'>[] =
  Object.freeze(
    coachCapabilityReferences.map((capability) =>
      createCapabilityDefinition({
        runtimeType: 'coach',
        capability,
        mode:
          capability.id === 'coach.get-opponent-evidence'
            ? 'readOnly'
            : 'deterministicCompute',
        inputSchema: {
          id: `${capability.id}.input`,
          version: 1,
        },
        outputSchema: {
          id: `${capability.id}.output`,
          version: 1,
        },
        timeoutMs: 2_000,
      }),
    ),
  )

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

const coachActiveStates = [
  'decisionContextPending',
  'evidencePending',
  'decisionAnalysisPending',
  'hindsightContextPending',
  'hindsightAnalysisPending',
  'reportValidationPending',
  'commitPending',
] as const

export const coachRuntimeStateMachine = createRuntimeStateMachineDefinition<
  'coach',
  CoachRuntimeState
>({
  runtimeType: 'coach',
  stateMachineVersion: 1,
  initialState: 'decisionContextPending',
  states: [...coachActiveStates, 'succeeded', 'cancelled', 'failed'],
  checkpointStates: [
    'decisionAnalysisPending',
    'hindsightContextPending',
    'hindsightAnalysisPending',
    'reportValidationPending',
    'commitPending',
  ],
  terminalStates: ['succeeded', 'cancelled', 'failed'],
  transitions: [
    {
      from: 'decisionContextPending',
      event: 'decisionContextPrepared',
      to: 'evidencePending',
    },
    {
      from: 'evidencePending',
      event: 'evidencePrepared',
      to: 'decisionAnalysisPending',
    },
    {
      from: 'decisionAnalysisPending',
      event: 'decisionAnalysisCompleted',
      to: 'hindsightContextPending',
    },
    {
      from: 'decisionAnalysisPending',
      event: 'repairRequested',
      to: 'decisionAnalysisPending',
    },
    {
      from: 'hindsightContextPending',
      event: 'hindsightContextPrepared',
      to: 'hindsightAnalysisPending',
    },
    {
      from: 'hindsightAnalysisPending',
      event: 'hindsightAnalysisCompleted',
      to: 'reportValidationPending',
    },
    {
      from: 'hindsightAnalysisPending',
      event: 'repairRequested',
      to: 'hindsightAnalysisPending',
    },
    {
      from: 'reportValidationPending',
      event: 'reportValid',
      to: 'commitPending',
    },
    { from: 'commitPending', event: 'commitSucceeded', to: 'succeeded' },
    ...coachActiveStates.flatMap((from) => [
      { from, event: 'cancel', to: 'cancelled' as const },
      { from, event: 'fail', to: 'failed' as const },
    ]),
  ],
})

export type CoachRuntimeDefinition = RuntimeDefinitionBase<
  'coach',
  'decisionAnalysis' | 'hindsight',
  CoachRuntimeState
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
  recoveryPolicy: { id: 'coach.recovery.frozen-checkpoint', version: 1 },
  stateMachine: coachRuntimeStateMachine,
  modelToolPolicy: 'none',
})
