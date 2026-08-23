import {
  RuntimeComponentReferenceSchema,
  RuntimeCommitGateReferenceSchema,
  RuntimeDefinitionVersionSchema,
  RuntimeTypeSchema,
  type AnyRuntimeDefinition,
  type RuntimeDefinitionMap,
  type RuntimeType,
} from './runtime-definition.js'
import {
  RuntimeRegistryConfigurationError,
  RuntimeResolutionError,
} from './errors.js'
import { isRuntimeBudgetPolicy } from './execution-budget.js'
import { isCapabilityManifest } from './capability-protocol.js'

export interface RuntimeRegistry<
  TDefinitions extends RuntimeDefinitionMap = RuntimeDefinitionMap,
> {
  resolveCurrent<TRuntime extends RuntimeType>(
    runtimeType: TRuntime,
  ): TDefinitions[TRuntime]
  resolveExact<TRuntime extends RuntimeType>(
    runtimeType: TRuntime,
    runtimeDefinitionVersion: number,
  ): TDefinitions[TRuntime]
}

function cloneValue<Value>(value: Value): Value {
  if (
    isRuntimeBudgetPolicy(value) ||
    isCapabilityManifest(value, 'player') ||
    isCapabilityManifest(value, 'coach')
  ) {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((entry) => cloneValue(entry)) as Value
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)]),
    ) as Value
  }
  return value
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nestedValue of Object.values(value)) deepFreeze(nestedValue)
    Object.freeze(value)
  }
  return value
}

function isRuntimeCompatibleReference(
  runtimeType: RuntimeType,
  id: string,
): boolean {
  return (
    id.startsWith(`${runtimeType}.`) ||
    id.startsWith('foundation.') ||
    id.startsWith('provider.')
  )
}

function validateDefinition(definition: AnyRuntimeDefinition): void {
  const references = [
    definition.contextPolicy,
    ...definition.promptModules,
    definition.routePolicy,
    definition.outputSchema,
    definition.validator,
    definition.recoveryPolicy,
  ]
  if (
    !RuntimeTypeSchema.safeParse(definition.runtimeType).success ||
    !RuntimeDefinitionVersionSchema.safeParse(
      definition.runtimeDefinitionVersion,
    ).success ||
    !RuntimeDefinitionVersionSchema.safeParse(definition.contextSchemaVersion)
      .success ||
    definition.contextKinds.length === 0 ||
    new Set(definition.contextKinds).size !== definition.contextKinds.length ||
    definition.contextKinds.some(
      (kind) => !/^[a-z][A-Za-z0-9]{0,79}$/.test(kind),
    ) ||
    new Set(
      definition.promptModules.map(
        (reference) => `${reference.id}@${String(reference.version)}`,
      ),
    ).size !== definition.promptModules.length ||
    references.some(
      (reference) =>
        !RuntimeComponentReferenceSchema.safeParse(reference).success ||
        !isRuntimeCompatibleReference(definition.runtimeType, reference.id),
    ) ||
    !RuntimeCommitGateReferenceSchema.safeParse(definition.commitGate)
      .success ||
    definition.commitGate.runtimeType !== definition.runtimeType ||
    !definition.commitGate.id.startsWith(`${definition.runtimeType}.commit-`) ||
    !isCapabilityManifest(
      definition.capabilityManifest,
      definition.runtimeType,
    ) ||
    !isRuntimeBudgetPolicy(definition.budgetPolicy) ||
    definition.budgetPolicy.runtimeType !== definition.runtimeType ||
    !RuntimeDefinitionVersionSchema.safeParse(
      definition.budgetPolicy.policyVersion,
    ).success ||
    definition.modelToolPolicy !== 'none'
  ) {
    throw new RuntimeRegistryConfigurationError('invalidDefinition')
  }
  for (const grant of definition.capabilityManifest.grants) {
    if (
      grant.runtimeType !== definition.runtimeType ||
      !grant.capability.id.startsWith(`${definition.runtimeType}.`) ||
      grant.capability.id.startsWith(`${definition.runtimeType}.commit-`)
    ) {
      throw new RuntimeRegistryConfigurationError('crossRuntimeReference')
    }
  }
}

export function createRuntimeRegistry<
  TDefinitions extends RuntimeDefinitionMap,
>(input: {
  readonly definitions: TDefinitions
}): RuntimeRegistry<TDefinitions> {
  if (
    input.definitions === null ||
    typeof input.definitions !== 'object' ||
    Array.isArray(input.definitions) ||
    Object.keys(input.definitions).sort().join(',') !== 'coach,player'
  ) {
    throw new RuntimeRegistryConfigurationError('invalidDefinition')
  }

  validateDefinition(input.definitions.player)
  validateDefinition(input.definitions.coach)
  if (
    input.definitions.player.runtimeType !== 'player' ||
    input.definitions.coach.runtimeType !== 'coach'
  ) {
    throw new RuntimeRegistryConfigurationError('invalidDefinition')
  }
  const definitions = deepFreeze({
    player: cloneValue(input.definitions.player),
    coach: cloneValue(input.definitions.coach),
  }) as TDefinitions

  function resolveCurrent<TRuntime extends RuntimeType>(
    runtimeType: TRuntime,
  ): TDefinitions[TRuntime] {
    if (!RuntimeTypeSchema.safeParse(runtimeType).success) {
      throw new RuntimeResolutionError('unsupportedRuntime')
    }
    return definitions[runtimeType]
  }

  function resolveExact<TRuntime extends RuntimeType>(
    runtimeType: TRuntime,
    runtimeDefinitionVersion: number,
  ): TDefinitions[TRuntime] {
    if (!RuntimeTypeSchema.safeParse(runtimeType).success) {
      throw new RuntimeResolutionError('unsupportedRuntime')
    }
    const version = RuntimeDefinitionVersionSchema.safeParse(
      runtimeDefinitionVersion,
    )
    if (!version.success) {
      throw new RuntimeResolutionError('unknownRuntimeVersion')
    }
    const definition = resolveCurrent(runtimeType)
    if (definition.runtimeDefinitionVersion !== version.data) {
      throw new RuntimeResolutionError('unknownRuntimeVersion')
    }
    return definition
  }

  const registry: RuntimeRegistry<TDefinitions> = {
    resolveCurrent,
    resolveExact,
  }
  return Object.freeze(registry)
}
