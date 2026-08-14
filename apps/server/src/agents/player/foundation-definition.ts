import { z } from 'zod'
import {
  createCapabilityDefinition,
  createCapabilityManifest,
  type CapabilityDefinition,
} from '../foundation/capability-protocol.js'
import {
  createExecutionBudget,
  type PlayerRuntimeBudgetInput,
  type RuntimeBudgetPolicy,
} from '../foundation/execution-budget.js'
import type {
  RuntimeComponentReference,
  RuntimeDefinitionBase,
} from '../foundation/runtime-definition.js'
import { createRuntimeStateMachineDefinition } from '../foundation/runtime-state-machine.js'

export type PlayerRuntimeState =
  | 'contextPending'
  | 'preprocessing'
  | 'modelPending'
  | 'outputValidation'
  | 'commitPending'
  | 'succeeded'
  | 'paused'
  | 'stale'
  | 'cancelled'
  | 'failed'

const playerCommitGate = Object.freeze({
  runtimeType: 'player' as const,
  id: 'player.commit-poker-decision',
  version: 1,
})

const playerCapabilityReferences = Object.freeze([
  { id: 'player.read-session-memory', version: 1 },
  { id: 'player.compute-decision-metrics', version: 1 },
  { id: 'player.project-strategy', version: 1 },
  { id: 'player.project-opponent-features', version: 1 },
] as const satisfies readonly RuntimeComponentReference[])

export const playerCapabilityDefinitionsV1: readonly CapabilityDefinition<'player'>[] =
  Object.freeze(
    playerCapabilityReferences.map((capability) =>
      createCapabilityDefinition({
        runtimeType: 'player',
        capability,
        mode:
          capability.id === 'player.read-session-memory'
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

const PlayerBudgetInputSchema = z
  .strictObject({
    runtimeType: z.literal('player'),
    attemptTimeoutSeconds: z.number().int().min(5).max(30),
    decisionDeadlineSeconds: z.number().int().min(15).max(120),
  })
  .refine(
    ({ attemptTimeoutSeconds, decisionDeadlineSeconds }) =>
      decisionDeadlineSeconds >= attemptTimeoutSeconds,
  )

export const playerRuntimeBudgetPolicyV1: RuntimeBudgetPolicy<'player'> =
  Object.freeze({
    runtimeType: 'player',
    policyVersion: 1,
    createSnapshot: (input: PlayerRuntimeBudgetInput) => {
      const parsed = PlayerBudgetInputSchema.parse(input)
      return createExecutionBudget({
        budgetSchemaVersion: 1,
        maxAttempts: 3,
        maxInputTokens: 12_000,
        maxOutputTokens: 1_500,
        maxWallClockMs: parsed.decisionDeadlineSeconds * 1_000,
        maxCapabilityInvocations: 4,
        maxCostMicrounits: 500_000,
        maxOwnerConcurrentRuns: 2,
        maxSystemConcurrentRuns: 4,
        minimumAttemptStartRemainingMs: 5_000,
        attemptTimeoutMs: parsed.attemptTimeoutSeconds * 1_000,
      })
    },
  })

const playerCapabilityManifestV1 = createCapabilityManifest({
  manifest: {
    runtimeType: 'player',
    manifestVersion: 1,
    grants: playerCapabilityReferences.map((capability) => ({
      runtimeType: 'player' as const,
      capability,
      maxInvocations: 1,
    })),
  },
  commitGate: playerCommitGate,
  maxCapabilityInvocations: 4,
})

const playerActiveStates = [
  'contextPending',
  'preprocessing',
  'modelPending',
  'outputValidation',
  'commitPending',
] as const

export const playerRuntimeStateMachineV1 = createRuntimeStateMachineDefinition<
  'player',
  PlayerRuntimeState
>({
  runtimeType: 'player',
  stateMachineVersion: 1,
  initialState: 'contextPending',
  states: [
    ...playerActiveStates,
    'succeeded',
    'paused',
    'stale',
    'cancelled',
    'failed',
  ],
  checkpointStates: [
    'contextPending',
    'modelPending',
    'outputValidation',
    'commitPending',
  ],
  terminalStates: ['succeeded', 'paused', 'stale', 'cancelled', 'failed'],
  transitions: [
    { from: 'contextPending', event: 'contextPrepared', to: 'preprocessing' },
    {
      from: 'preprocessing',
      event: 'preprocessingCompleted',
      to: 'modelPending',
    },
    { from: 'modelPending', event: 'modelCompleted', to: 'outputValidation' },
    { from: 'outputValidation', event: 'outputValid', to: 'commitPending' },
    {
      from: 'outputValidation',
      event: 'repairRequested',
      to: 'modelPending',
    },
    { from: 'commitPending', event: 'commitSucceeded', to: 'succeeded' },
    ...playerActiveStates.flatMap((from) => [
      { from, event: 'pause', to: 'paused' as const },
      { from, event: 'markStale', to: 'stale' as const },
      { from, event: 'cancel', to: 'cancelled' as const },
      { from, event: 'fail', to: 'failed' as const },
    ]),
  ],
})

export type PlayerRuntimeDefinitionV1 = RuntimeDefinitionBase<
  'player',
  'decision',
  PlayerRuntimeState
>

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const nestedValue of Object.values(value)) deepFreeze(nestedValue)
    if (!Object.isFrozen(value)) Object.freeze(value)
  }
  return value
}

export const playerRuntimeDefinitionV1: PlayerRuntimeDefinitionV1 = deepFreeze({
  runtimeType: 'player',
  runtimeDefinitionVersion: 1,
  contextSchemaVersion: 1,
  contextKinds: Object.freeze(['decision'] as const),
  contextPolicy: { id: 'player.context-policy', version: 1 },
  promptModules: Object.freeze([
    { id: 'player.prompt.system', version: 1 },
    { id: 'player.prompt.decision', version: 1 },
  ]),
  capabilityManifest: playerCapabilityManifestV1,
  budgetPolicy: playerRuntimeBudgetPolicyV1,
  routePolicy: { id: 'player.route-policy', version: 1 },
  outputSchema: { id: 'player.output.decision', version: 1 },
  validator: { id: 'player.validator.decision', version: 1 },
  commitGate: playerCommitGate,
  recoveryPolicy: {
    id: 'player.recovery.process-restart-cancel',
    version: 1,
  },
  stateMachine: playerRuntimeStateMachineV1,
  modelToolPolicy: 'none',
})
