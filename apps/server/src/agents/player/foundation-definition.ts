import { z } from 'zod'
import { createCapabilityManifest } from '../foundation/capability-protocol.js'
import {
  createExecutionBudget,
  createRuntimeBudgetPolicy,
  type PlayerRuntimeBudgetInput,
  type RuntimeBudgetPolicy,
} from '../foundation/execution-budget.js'
import type {
  RuntimeComponentReference,
  RuntimeDefinitionBase,
} from '../foundation/runtime-definition.js'

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

export const playerRuntimeBudgetPolicy: RuntimeBudgetPolicy<'player'> =
  createRuntimeBudgetPolicy({
    runtimeType: 'player',
    policyVersion: 1,
    validationInput: {
      runtimeType: 'player',
      attemptTimeoutSeconds: 15,
      decisionDeadlineSeconds: 45,
    },
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

const playerCapabilityManifest = createCapabilityManifest({
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

export type PlayerRuntimeDefinition = RuntimeDefinitionBase<
  'player',
  'decision'
>

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const nestedValue of Object.values(value)) deepFreeze(nestedValue)
    if (!Object.isFrozen(value)) Object.freeze(value)
  }
  return value
}

export const playerRuntimeDefinition: PlayerRuntimeDefinition = deepFreeze({
  runtimeType: 'player',
  runtimeDefinitionVersion: 1,
  contextSchemaVersion: 1,
  contextKinds: Object.freeze(['decision'] as const),
  contextPolicy: { id: 'player.context-policy', version: 1 },
  promptModules: Object.freeze([
    { id: 'player.prompt.system', version: 1 },
    { id: 'player.prompt.decision', version: 1 },
  ]),
  capabilityManifest: playerCapabilityManifest,
  budgetPolicy: playerRuntimeBudgetPolicy,
  routePolicy: { id: 'player.route-policy', version: 1 },
  outputSchema: { id: 'player.output.decision', version: 1 },
  validator: { id: 'player.validator.decision', version: 1 },
  commitGate: playerCommitGate,
  recoveryPolicy: {
    id: 'player.recovery.process-restart-cancel',
    version: 1,
  },
  modelToolPolicy: 'none',
})
