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
