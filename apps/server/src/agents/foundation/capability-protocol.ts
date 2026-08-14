import { z } from 'zod'
import {
  NonnegativeSafeIntegerSchema,
  PositiveSafeIntegerSchema,
  type AuditVersionReference,
} from '../audit/audit-primitives.js'
import { FoundationProtocolError } from './errors.js'
import {
  RuntimeComponentReferenceSchema,
  RuntimeTypeSchema,
  type RuntimeCommitGateReference,
  type RuntimeComponentReference,
  type RuntimeType,
} from './runtime-definition.js'

export type CapabilityMode = 'readOnly' | 'deterministicCompute'

export interface CapabilityDefinition<TRuntime extends RuntimeType> {
  readonly runtimeType: TRuntime
  readonly capability: RuntimeComponentReference
  readonly mode: CapabilityMode
  readonly inputSchema: RuntimeComponentReference
  readonly outputSchema: RuntimeComponentReference
  readonly timeoutMs: number
}

export interface CapabilityGrant<TRuntime extends RuntimeType> {
  readonly runtimeType: TRuntime
  readonly capability: RuntimeComponentReference
  readonly maxInvocations: number
}

export interface CapabilityManifest<TRuntime extends RuntimeType> {
  readonly runtimeType: TRuntime
  readonly manifestVersion: number
  readonly grants: readonly CapabilityGrant<TRuntime>[]
}

export interface CapabilityInvocationIntent<TRuntime extends RuntimeType> {
  readonly runtimeType: TRuntime
  readonly capability: RuntimeComponentReference
}

const CapabilityDefinitionSchema = z.strictObject({
  runtimeType: RuntimeTypeSchema,
  capability: RuntimeComponentReferenceSchema,
  mode: z.enum(['readOnly', 'deterministicCompute']),
  inputSchema: RuntimeComponentReferenceSchema,
  outputSchema: RuntimeComponentReferenceSchema,
  timeoutMs: PositiveSafeIntegerSchema,
})

const CapabilityManifestSchema = z.strictObject({
  runtimeType: RuntimeTypeSchema,
  manifestVersion: PositiveSafeIntegerSchema,
  grants: z.array(
    z.strictObject({
      runtimeType: RuntimeTypeSchema,
      capability: RuntimeComponentReferenceSchema,
      maxInvocations: PositiveSafeIntegerSchema,
    }),
  ),
})

function referenceKey(reference: AuditVersionReference): string {
  return `${reference.id}@${String(reference.version)}`
}

function hasRuntimeNamespace(
  runtimeType: RuntimeType,
  reference: RuntimeComponentReference,
): boolean {
  return reference.id.startsWith(`${runtimeType}.`)
}

function hasRuntimeOrFoundationNamespace(
  runtimeType: RuntimeType,
  reference: RuntimeComponentReference,
): boolean {
  return (
    hasRuntimeNamespace(runtimeType, reference) ||
    reference.id.startsWith('foundation.')
  )
}

function isCommitGateId(runtimeType: RuntimeType, id: string): boolean {
  return id.startsWith(`${runtimeType}.commit-`)
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nestedValue of Object.values(value)) deepFreeze(nestedValue)
    Object.freeze(value)
  }
  return value
}

export function createCapabilityDefinition<TRuntime extends RuntimeType>(
  input: CapabilityDefinition<TRuntime>,
): CapabilityDefinition<TRuntime> {
  const parsed = CapabilityDefinitionSchema.safeParse(input)
  if (
    !parsed.success ||
    !hasRuntimeNamespace(parsed.data.runtimeType, parsed.data.capability) ||
    !hasRuntimeOrFoundationNamespace(
      parsed.data.runtimeType,
      parsed.data.inputSchema,
    ) ||
    !hasRuntimeOrFoundationNamespace(
      parsed.data.runtimeType,
      parsed.data.outputSchema,
    )
  ) {
    throw new FoundationProtocolError('capabilityRuntimeMismatch')
  }
  return deepFreeze(
    structuredClone(parsed.data),
  ) as CapabilityDefinition<TRuntime>
}

export function createCapabilityManifest<TRuntime extends RuntimeType>(input: {
  readonly manifest: CapabilityManifest<TRuntime>
  readonly commitGate: RuntimeCommitGateReference<TRuntime>
  readonly maxCapabilityInvocations: number
}): CapabilityManifest<TRuntime> {
  const parsed = CapabilityManifestSchema.safeParse(input.manifest)
  const maximum = NonnegativeSafeIntegerSchema.safeParse(
    input.maxCapabilityInvocations,
  )
  if (!parsed.success || !maximum.success) {
    throw new FoundationProtocolError('capabilityNotDeclared')
  }

  const keys = new Set<string>()
  let total = 0
  for (const grant of parsed.data.grants) {
    if (
      grant.runtimeType !== parsed.data.runtimeType ||
      !hasRuntimeNamespace(parsed.data.runtimeType, grant.capability)
    ) {
      throw new FoundationProtocolError('capabilityRuntimeMismatch')
    }
    if (isCommitGateId(parsed.data.runtimeType, grant.capability.id)) {
      throw new FoundationProtocolError('commitGateNotExecutableAsCapability')
    }
    const key = referenceKey(grant.capability)
    if (keys.has(key)) {
      throw new FoundationProtocolError('capabilityNotDeclared')
    }
    keys.add(key)
    total += grant.maxInvocations
  }
  if (!Number.isSafeInteger(total) || total > maximum.data) {
    throw new FoundationProtocolError('executionBudgetExhausted')
  }

  return deepFreeze(
    structuredClone(parsed.data),
  ) as unknown as CapabilityManifest<TRuntime>
}

export function authorizeCapabilityInvocation<
  TRuntime extends RuntimeType,
>(input: {
  readonly intent: CapabilityInvocationIntent<TRuntime>
  readonly manifest: CapabilityManifest<TRuntime>
  readonly definitions: readonly CapabilityDefinition<TRuntime>[]
  readonly commitGate: RuntimeCommitGateReference<TRuntime>
  readonly stateDeclaredCapabilities: readonly RuntimeComponentReference[]
  readonly invocationCount: number
}): CapabilityDefinition<TRuntime> {
  if (isCommitGateId(input.intent.runtimeType, input.intent.capability.id)) {
    throw new FoundationProtocolError('commitGateNotExecutableAsCapability')
  }
  if (
    input.intent.runtimeType !== input.manifest.runtimeType ||
    input.intent.runtimeType !== input.commitGate.runtimeType
  ) {
    throw new FoundationProtocolError('capabilityRuntimeMismatch')
  }
  const intentKey = referenceKey(input.intent.capability)
  if (
    !input.stateDeclaredCapabilities.some(
      (reference) => referenceKey(reference) === intentKey,
    )
  ) {
    throw new FoundationProtocolError('capabilityNotDeclared')
  }
  const grant = input.manifest.grants.find(
    ({ capability }) => referenceKey(capability) === intentKey,
  )
  if (grant === undefined) {
    throw new FoundationProtocolError('capabilityNotDeclared')
  }
  if (
    input.intent.runtimeType !== grant.runtimeType ||
    !hasRuntimeNamespace(input.intent.runtimeType, input.intent.capability)
  ) {
    throw new FoundationProtocolError('capabilityRuntimeMismatch')
  }
  if (
    !Number.isSafeInteger(input.invocationCount) ||
    input.invocationCount < 0 ||
    input.invocationCount >= grant.maxInvocations
  ) {
    throw new FoundationProtocolError('executionBudgetExhausted')
  }
  const definition = input.definitions.find(
    ({ capability }) => referenceKey(capability) === intentKey,
  )
  if (definition === undefined) {
    throw new FoundationProtocolError('capabilityNotDeclared')
  }
  if (definition.runtimeType !== input.intent.runtimeType) {
    throw new FoundationProtocolError('capabilityRuntimeMismatch')
  }
  return definition
}
