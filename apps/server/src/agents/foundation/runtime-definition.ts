import { z } from 'zod'
import {
  AuditVersionReferenceSchema,
  PositiveSafeIntegerSchema,
  type AuditVersionReference,
} from '../audit/audit-primitives.js'
import type { CapabilityManifest } from './capability-protocol.js'
import type { RuntimeBudgetPolicy } from './execution-budget.js'
import type { RuntimeStateMachineDefinition } from './runtime-state-machine.js'

export const RuntimeTypeSchema = z.enum(['player', 'coach'])
export type RuntimeType = z.infer<typeof RuntimeTypeSchema>

export const RuntimeComponentReferenceSchema = AuditVersionReferenceSchema
export type RuntimeComponentReference = AuditVersionReference

export const RuntimeCommitGateReferenceSchema = z.strictObject({
  runtimeType: RuntimeTypeSchema,
  ...AuditVersionReferenceSchema.shape,
})

export interface RuntimeCommitGateReference<
  TRuntime extends RuntimeType,
> extends RuntimeComponentReference {
  readonly runtimeType: TRuntime
}

export const RuntimeDefinitionVersionSchema = PositiveSafeIntegerSchema

export interface RuntimeDefinitionBase<
  TRuntime extends RuntimeType,
  TContextKind extends string,
  TState extends string,
> {
  readonly runtimeType: TRuntime
  readonly runtimeDefinitionVersion: number
  readonly contextSchemaVersion: number
  readonly contextKinds: readonly TContextKind[]
  readonly contextPolicy: RuntimeComponentReference
  readonly promptModules: readonly RuntimeComponentReference[]
  readonly capabilityManifest: CapabilityManifest<TRuntime>
  readonly budgetPolicy: RuntimeBudgetPolicy<TRuntime>
  readonly routePolicy: RuntimeComponentReference
  readonly outputSchema: RuntimeComponentReference
  readonly validator: RuntimeComponentReference
  readonly commitGate: RuntimeCommitGateReference<TRuntime>
  readonly recoveryPolicy: RuntimeComponentReference
  readonly stateMachine: RuntimeStateMachineDefinition<TRuntime, TState>
  readonly modelToolPolicy: 'none'
}

export type AnyRuntimeDefinition = RuntimeDefinitionBase<
  RuntimeType,
  string,
  string
>

export interface RuntimeDefinitionMap {
  readonly player: RuntimeDefinitionBase<'player', string, string>
  readonly coach: RuntimeDefinitionBase<'coach', string, string>
}
