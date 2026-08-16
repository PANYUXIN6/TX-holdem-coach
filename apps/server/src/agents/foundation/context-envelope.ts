import { createHash } from 'node:crypto'
import { z } from 'zod'
import { canonicalJson, type JsonValue } from '../../personas/config.js'
import {
  RuntimeComponentReferenceSchema,
  RuntimeTypeSchema,
  type RuntimeComponentReference,
  type RuntimeDefinitionBase,
  type RuntimeType,
} from './runtime-definition.js'
import {
  createExecutionBudget,
  type ExecutionBudget,
} from './execution-budget.js'
import { FoundationProtocolError } from './errors.js'

export interface ContextSection {
  readonly sectionId: string
  readonly schema: RuntimeComponentReference
  readonly payload: unknown
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

declare const preparedContextEnvelopeBrand: unique symbol

export interface PreparedContextEnvelope<TRuntime extends RuntimeType> {
  readonly runtimeType: TRuntime
  readonly serialized: string
  readonly sha256: string
  readonly estimatedInputTokens: number
  readonly [preparedContextEnvelopeBrand]: never
}

const preparedContextEnvelopes = new WeakSet<object>()

const CanonicalContextNameSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z][A-Za-z0-9]*$/)

const ContextEnvelopeSchema = z.strictObject({
  runtimeType: RuntimeTypeSchema,
  runtimeDefinitionVersion: z.number().int().positive().safe(),
  contextSchemaVersion: z.number().int().positive().safe(),
  contextKind: CanonicalContextNameSchema,
  promptModules: z.array(RuntimeComponentReferenceSchema),
  sourceVersions: z.array(
    z.strictObject({
      source: RuntimeComponentReferenceSchema,
      contentVersion: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[a-z0-9][a-z0-9._:@/-]*$/),
    }),
  ),
  sections: z.array(
    z.strictObject({
      sectionId: CanonicalContextNameSchema,
      schema: RuntimeComponentReferenceSchema,
      payload: z.unknown(),
    }),
  ),
})

const contextSectionPlans = Object.freeze({
  player: Object.freeze({
    decision: Object.freeze([
      'protocol',
      'persona',
      'observation',
      'memory',
      'metrics',
      'strategy',
      'candidates',
      'constraints',
    ]),
  }),
  coach: Object.freeze({
    decisionAnalysis: Object.freeze([
      'protocol',
      'decisionCase',
      'metrics',
      'baseline',
      'evidence',
      'frozenAssessment',
      'constraints',
    ]),
    hindsight: Object.freeze([
      'protocol',
      'frozenProcessAnalysis',
      'minimalHindsightFacts',
      'constraints',
    ]),
  }),
})

const baseForbiddenFieldNames = new Set([
  'apiKey',
  'authorization',
  'databaseOwnerId',
  'fencingToken',
  'leaseOwner',
  'reasoning_content',
])

const sharedContextSourcePrefixes = Object.freeze(['provider.'] as const)

function isAllowedContextSource(
  runtimeType: RuntimeType,
  { source, contentVersion }: ContextSourceVersion,
): boolean {
  if (source.id === 'foundation.token-estimator') {
    return source.version === 1 && contentVersion === 'v1'
  }
  return (
    source.id.startsWith(`${runtimeType}.`) ||
    source.id.startsWith('foundation.') ||
    sharedContextSourcePrefixes.some((prefix) => source.id.startsWith(prefix))
  )
}

function referencesEqual(
  left: readonly RuntimeComponentReference[],
  right: readonly RuntimeComponentReference[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (reference, index) =>
        reference.id === right[index]?.id &&
        reference.version === right[index]?.version,
    )
  )
}

function expectedSectionIds(
  runtimeType: RuntimeType,
  contextKind: string,
): readonly string[] | undefined {
  if (runtimeType === 'player' && contextKind === 'decision') {
    return contextSectionPlans.player.decision
  }
  if (runtimeType === 'coach' && contextKind === 'decisionAnalysis') {
    return contextSectionPlans.coach.decisionAnalysis
  }
  if (runtimeType === 'coach' && contextKind === 'hindsight') {
    return contextSectionPlans.coach.hindsight
  }
  return undefined
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function validateJsonAndSensitiveContent(
  value: unknown,
  forbiddenFieldNames: ReadonlySet<string>,
  ancestors: Set<object>,
): asserts value is JsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return
  }
  if (typeof value === 'string') {
    if (
      /(?:postgres(?:ql)?:\/\/|authorization\s*:\s*bearer|\bsk-[a-z0-9_-]{8,})/i.test(
        value,
      )
    ) {
      throw new FoundationProtocolError('contextSensitiveContentRejected')
    }
    return
  }
  if (typeof value !== 'object' || value === null || ancestors.has(value)) {
    throw new FoundationProtocolError('contextEnvelopeInvalid')
  }
  ancestors.add(value)
  if (Array.isArray(value)) {
    for (const entry of value) {
      validateJsonAndSensitiveContent(entry, forbiddenFieldNames, ancestors)
    }
  } else {
    if (!isPlainObject(value)) {
      throw new FoundationProtocolError('contextEnvelopeInvalid')
    }
    for (const [key, entry] of Object.entries(value)) {
      if (forbiddenFieldNames.has(key.toLowerCase())) {
        throw new FoundationProtocolError('contextSensitiveContentRejected')
      }
      validateJsonAndSensitiveContent(entry, forbiddenFieldNames, ancestors)
    }
  }
  ancestors.delete(value)
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nestedValue of Object.values(value)) deepFreeze(nestedValue)
    Object.freeze(value)
  }
  return value
}

export function prepareContextEnvelope<
  TRuntime extends RuntimeType,
  TContextKind extends string,
  TState extends string,
>(input: {
  readonly definition: RuntimeDefinitionBase<TRuntime, TContextKind, TState>
  readonly envelope: ContextEnvelope<TRuntime, TContextKind>
  readonly budget: ExecutionBudget
  readonly forbiddenFieldNames?: readonly string[]
}): PreparedContextEnvelope<TRuntime> {
  const parsed = ContextEnvelopeSchema.safeParse(input.envelope)
  if (!parsed.success) {
    throw new FoundationProtocolError('contextEnvelopeInvalid')
  }
  const envelope = parsed.data
  const expectedSections = expectedSectionIds(
    envelope.runtimeType,
    envelope.contextKind,
  )
  if (
    envelope.runtimeType !== input.definition.runtimeType ||
    envelope.runtimeDefinitionVersion !==
      input.definition.runtimeDefinitionVersion ||
    envelope.contextSchemaVersion !== input.definition.contextSchemaVersion ||
    !input.definition.contextKinds.includes(
      envelope.contextKind as TContextKind,
    ) ||
    !referencesEqual(envelope.promptModules, input.definition.promptModules) ||
    expectedSections === undefined ||
    !referencesEqual(
      envelope.sections.map(({ schema }) => schema),
      expectedSections.map((sectionId) => ({
        id: `${envelope.runtimeType}.context.${envelope.contextKind}.${sectionId}`,
        version: envelope.contextSchemaVersion,
      })),
    ) ||
    envelope.sections.some(
      ({ sectionId }, index) => sectionId !== expectedSections[index],
    ) ||
    new Set(
      envelope.sourceVersions.map(
        ({ source }) => `${source.id}@${String(source.version)}`,
      ),
    ).size !== envelope.sourceVersions.length ||
    envelope.sourceVersions.some(
      (sourceVersion) =>
        !isAllowedContextSource(envelope.runtimeType, sourceVersion),
    ) ||
    !envelope.sourceVersions.some(
      ({ source, contentVersion }) =>
        source.id === 'foundation.token-estimator' &&
        source.version === 1 &&
        contentVersion === 'v1',
    )
  ) {
    throw new FoundationProtocolError('contextEnvelopeInvalid')
  }

  const forbiddenFieldNames = new Set([
    ...[...baseForbiddenFieldNames].map((name) => name.toLowerCase()),
    ...(input.forbiddenFieldNames ?? []).map((name) => name.toLowerCase()),
  ])
  validateJsonAndSensitiveContent(envelope, forbiddenFieldNames, new Set())

  let serialized: string
  try {
    serialized = canonicalJson(envelope as JsonValue)
  } catch {
    throw new FoundationProtocolError('contextEnvelopeInvalid')
  }
  const budget = createExecutionBudget(input.budget)
  const byteLength = Buffer.byteLength(serialized, 'utf8')
  const estimatedInputTokens = Math.ceil(byteLength / 4)
  if (
    byteLength > budget.maxInputTokens * 4 ||
    estimatedInputTokens > budget.maxInputTokens
  ) {
    throw new FoundationProtocolError('contextBudgetExceeded')
  }

  const prepared = deepFreeze({
    runtimeType: envelope.runtimeType,
    serialized,
    sha256: createHash('sha256').update(serialized, 'utf8').digest('hex'),
    estimatedInputTokens,
  }) as PreparedContextEnvelope<TRuntime>
  preparedContextEnvelopes.add(prepared)
  return prepared
}

export function isPreparedContextEnvelope(
  value: unknown,
): value is PreparedContextEnvelope<RuntimeType> {
  return (
    typeof value === 'object' &&
    value !== null &&
    preparedContextEnvelopes.has(value)
  )
}
