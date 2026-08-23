import { createHash } from 'node:crypto'
import { z } from 'zod'
import { canonicalJson, type JsonValue } from '../../persisted-json.js'
import { FoundationProtocolError } from './errors.js'
import type { ExecutionBudget } from './execution-budget.js'
import {
  RuntimeComponentReferenceSchema,
  RuntimeTypeSchema,
  type RuntimeComponentReference,
  type RuntimeType,
} from './runtime-definition.js'
import type { RuntimeRegistry } from './runtime-registry.js'

export const TOKEN_ESTIMATOR_REFERENCE = Object.freeze({
  id: 'foundation.token-estimator.utf8-upper-bound',
  version: 1,
})

export interface ContextSection {
  readonly sectionId: string
  readonly schema: RuntimeComponentReference
  readonly payload: JsonValue
}

export interface ContextSourceVersion {
  readonly source: RuntimeComponentReference
  readonly contentVersion: string
}

export interface ContextEnvelope<
  TRuntime extends RuntimeType,
  TContextKind extends string,
> {
  readonly runtimeType: TRuntime
  readonly runtimeDefinitionVersion: number
  readonly contextSchemaVersion: number
  readonly contextKind: TContextKind
  readonly promptModules: readonly RuntimeComponentReference[]
  readonly sourceVersions: readonly ContextSourceVersion[]
  readonly sections: readonly ContextSection[]
}

export interface ContextSectionDefinition {
  readonly sectionId: string
  readonly schema: RuntimeComponentReference
  readonly parse: (input: unknown) => JsonValue
}

export interface ContextKindDefinition<TContextKind extends string> {
  readonly contextKind: TContextKind
  readonly sections: readonly ContextSectionDefinition[]
}

export interface ContextPolicyDefinition<
  TRuntime extends RuntimeType,
  TContextKind extends string,
> {
  readonly runtimeType: TRuntime
  readonly policy: RuntimeComponentReference
  readonly tokenEstimator: RuntimeComponentReference
  readonly kinds: readonly ContextKindDefinition<TContextKind>[]
  readonly maximumSerializedBytes: number
}

export interface SensitiveValueScanner {
  assertSafe(value: JsonValue | string): void
}

declare const preparedContextEnvelopeBrand: unique symbol

export interface PreparedContextEnvelope<
  TRuntime extends RuntimeType = RuntimeType,
> {
  readonly runtimeType: TRuntime
  readonly contextKind: string
  readonly contextPolicy: RuntimeComponentReference
  readonly tokenEstimator: RuntimeComponentReference
  readonly serialized: string
  readonly byteLength: number
  readonly sha256: string
  readonly estimatedInputTokens: number
  readonly [preparedContextEnvelopeBrand]: never
}

const preparedContexts = new WeakSet<object>()
const contextPolicies = new WeakSet<object>()
const ContextEnvelopeCommonSchema = z.strictObject({
  runtimeType: RuntimeTypeSchema,
  runtimeDefinitionVersion: z.number().int().positive().safe(),
  contextSchemaVersion: z.number().int().positive().safe(),
  contextKind: z.string().regex(/^[a-z][A-Za-z0-9]{0,79}$/),
  promptModules: z.array(RuntimeComponentReferenceSchema),
  sourceVersions: z.array(
    z.strictObject({
      source: RuntimeComponentReferenceSchema,
      contentVersion: z.string().trim().min(1).max(256),
    }),
  ),
  sections: z.array(
    z.strictObject({
      sectionId: z.string().regex(/^[a-z][A-Za-z0-9]{0,79}$/),
      schema: RuntimeComponentReferenceSchema,
      payload: z.unknown(),
    }),
  ),
})

function sameReference(
  left: RuntimeComponentReference,
  right: RuntimeComponentReference,
): boolean {
  return left.id === right.id && left.version === right.version
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(
    left,
    (character) => character.codePointAt(0) ?? 0,
  )
  const rightPoints = Array.from(
    right,
    (character) => character.codePointAt(0) ?? 0,
  )
  const length = Math.min(leftPoints.length, rightPoints.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (leftPoints[index] ?? 0) - (rightPoints[index] ?? 0)
    if (difference !== 0) return difference
  }
  return leftPoints.length - rightPoints.length
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

export function createContextPolicyDefinition<
  TRuntime extends RuntimeType,
  TContextKind extends string,
>(
  input: ContextPolicyDefinition<TRuntime, TContextKind>,
): ContextPolicyDefinition<TRuntime, TContextKind> {
  const runtimeType = RuntimeTypeSchema.safeParse(input.runtimeType)
  const policy = RuntimeComponentReferenceSchema.safeParse(input.policy)
  const tokenEstimator = RuntimeComponentReferenceSchema.safeParse(
    input.tokenEstimator,
  )
  if (
    !runtimeType.success ||
    !policy.success ||
    !tokenEstimator.success ||
    !sameReference(tokenEstimator.data, TOKEN_ESTIMATOR_REFERENCE) ||
    !Number.isSafeInteger(input.maximumSerializedBytes) ||
    input.maximumSerializedBytes <= 0 ||
    !Array.isArray(input.kinds) ||
    input.kinds.length === 0
  ) {
    throw new FoundationProtocolError('contextPolicyMismatch')
  }

  const contextKinds = new Set<string>()
  const kinds = input.kinds.map((kind: ContextKindDefinition<TContextKind>) => {
    if (
      !/^[a-z][A-Za-z0-9]{0,79}$/.test(kind.contextKind) ||
      contextKinds.has(kind.contextKind) ||
      !Array.isArray(kind.sections) ||
      kind.sections.length === 0
    ) {
      throw new FoundationProtocolError('contextPolicyMismatch')
    }
    contextKinds.add(kind.contextKind)
    const sectionIds = new Set<string>()
    const sections = kind.sections.map((section: ContextSectionDefinition) => {
      const schema = RuntimeComponentReferenceSchema.safeParse(section.schema)
      if (
        !/^[a-z][A-Za-z0-9]{0,79}$/.test(section.sectionId) ||
        sectionIds.has(section.sectionId) ||
        !schema.success ||
        typeof section.parse !== 'function'
      ) {
        throw new FoundationProtocolError('contextPolicyMismatch')
      }
      sectionIds.add(section.sectionId)
      return {
        sectionId: section.sectionId,
        schema: { ...schema.data },
        parse: section.parse,
      }
    })
    return { contextKind: kind.contextKind, sections }
  })
  const definition = deepFreeze({
    runtimeType: runtimeType.data,
    policy: { ...policy.data },
    tokenEstimator: { ...tokenEstimator.data },
    kinds,
    maximumSerializedBytes: input.maximumSerializedBytes,
  }) as unknown as ContextPolicyDefinition<TRuntime, TContextKind>
  contextPolicies.add(definition)
  return definition
}

export function isContextPolicyDefinition<
  TRuntime extends RuntimeType,
  TContextKind extends string,
>(
  value: unknown,
  runtimeType: TRuntime,
): value is ContextPolicyDefinition<TRuntime, TContextKind> {
  return (
    typeof value === 'object' &&
    value !== null &&
    contextPolicies.has(value) &&
    (value as { readonly runtimeType?: unknown }).runtimeType === runtimeType
  )
}

export function estimateUtf8UpperBoundTokens(
  serialized: string,
  messageCount: number,
): number {
  if (!Number.isSafeInteger(messageCount) || messageCount <= 0) {
    throw new FoundationProtocolError('invalidContextEnvelope')
  }
  const byteLength = Buffer.byteLength(serialized, 'utf8')
  const estimate = Math.ceil(byteLength / 3) + messageCount * 32
  if (!Number.isSafeInteger(estimate)) {
    throw new FoundationProtocolError('contextTokenExhausted')
  }
  return estimate
}

export function prepareContextEnvelope<
  TRuntime extends RuntimeType,
  TContextKind extends string,
>(input: {
  readonly envelope: ContextEnvelope<TRuntime, TContextKind>
  readonly policy: ContextPolicyDefinition<TRuntime, TContextKind>
  readonly registry: RuntimeRegistry
  readonly budget: ExecutionBudget
  readonly scanner: SensitiveValueScanner
}): PreparedContextEnvelope<TRuntime> {
  const parsed = ContextEnvelopeCommonSchema.safeParse(input.envelope)
  if (!parsed.success) {
    throw new FoundationProtocolError('invalidContextEnvelope')
  }
  if (
    !isContextPolicyDefinition(input.policy, parsed.data.runtimeType) ||
    parsed.data.runtimeType !== input.policy.runtimeType ||
    input.policy.runtimeType !== input.envelope.runtimeType
  ) {
    throw new FoundationProtocolError('contextRuntimeMismatch')
  }

  let definition
  try {
    definition = input.registry.resolveExact(
      input.envelope.runtimeType,
      input.envelope.runtimeDefinitionVersion,
    )
  } catch {
    throw new FoundationProtocolError('contextPolicyMismatch')
  }
  const promptMatches =
    definition.promptModules.length === parsed.data.promptModules.length &&
    definition.promptModules.every((reference, index) =>
      sameReference(reference, parsed.data.promptModules[index]!),
    )
  if (
    definition.contextSchemaVersion !== parsed.data.contextSchemaVersion ||
    !definition.contextKinds.includes(parsed.data.contextKind) ||
    !sameReference(definition.contextPolicy, input.policy.policy) ||
    !sameReference(input.policy.tokenEstimator, TOKEN_ESTIMATOR_REFERENCE) ||
    !promptMatches
  ) {
    throw new FoundationProtocolError('contextPolicyMismatch')
  }
  const kind = input.policy.kinds.find(
    (candidate) => candidate.contextKind === parsed.data.contextKind,
  )
  if (
    kind === undefined ||
    kind.sections.length !== parsed.data.sections.length ||
    !Number.isSafeInteger(input.policy.maximumSerializedBytes) ||
    input.policy.maximumSerializedBytes <= 0
  ) {
    throw new FoundationProtocolError('contextSectionMismatch')
  }

  const sections = kind.sections.map((sectionDefinition, index) => {
    const section = parsed.data.sections[index]
    if (
      section === undefined ||
      section.sectionId !== sectionDefinition.sectionId ||
      !sameReference(section.schema, sectionDefinition.schema)
    ) {
      throw new FoundationProtocolError('contextSectionMismatch')
    }
    try {
      return {
        sectionId: section.sectionId,
        schema: section.schema,
        payload: sectionDefinition.parse(section.payload),
      } satisfies ContextSection
    } catch {
      throw new FoundationProtocolError('contextSchemaRejected')
    }
  })
  const sourceKeys = new Set<string>()
  const sourceVersions = [...parsed.data.sourceVersions]
    .sort((left, right) => compareCodePoints(left.source.id, right.source.id))
    .map((entry) => {
      const key = entry.source.id
      if (sourceKeys.has(key)) {
        throw new FoundationProtocolError('invalidContextEnvelope')
      }
      sourceKeys.add(key)
      return entry
    })

  const projection = {
    runtimeType: parsed.data.runtimeType,
    runtimeDefinitionVersion: parsed.data.runtimeDefinitionVersion,
    contextSchemaVersion: parsed.data.contextSchemaVersion,
    contextKind: parsed.data.contextKind,
    promptModules: parsed.data.promptModules,
    sourceVersions,
    sections,
  } satisfies JsonValue
  try {
    input.scanner.assertSafe(projection)
  } catch {
    throw new FoundationProtocolError('sensitiveContextRejected')
  }
  let serialized: string
  try {
    serialized = canonicalJson(projection)
  } catch {
    throw new FoundationProtocolError('invalidContextEnvelope')
  }
  const byteLength = Buffer.byteLength(serialized, 'utf8')
  if (byteLength > input.policy.maximumSerializedBytes) {
    throw new FoundationProtocolError('contextSizeExhausted')
  }
  const estimatedInputTokens = estimateUtf8UpperBoundTokens(serialized, 1)
  if (estimatedInputTokens > input.budget.maxInputTokens) {
    throw new FoundationProtocolError('contextTokenExhausted')
  }
  const prepared = deepFreeze({
    runtimeType: input.envelope.runtimeType,
    contextKind: parsed.data.contextKind,
    contextPolicy: { ...input.policy.policy },
    tokenEstimator: { ...input.policy.tokenEstimator },
    serialized,
    byteLength,
    sha256: createHash('sha256').update(serialized, 'utf8').digest('hex'),
    estimatedInputTokens,
  }) as PreparedContextEnvelope<TRuntime>
  preparedContexts.add(prepared)
  return prepared
}

export function isPreparedContextEnvelope<TRuntime extends RuntimeType>(
  value: unknown,
  runtimeType: TRuntime,
): value is PreparedContextEnvelope<TRuntime> {
  return (
    typeof value === 'object' &&
    value !== null &&
    preparedContexts.has(value) &&
    (value as { readonly runtimeType?: unknown }).runtimeType === runtimeType
  )
}
