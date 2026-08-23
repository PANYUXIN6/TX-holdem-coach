import { createHash } from 'node:crypto'
import { canonicalJson, type JsonValue } from '../../persisted-json.js'
import type { CapabilityManifest } from './capability-protocol.js'
import { FoundationProtocolError } from './errors.js'
import type { ExecutionBudget } from './execution-budget.js'
import {
  isRuntimeCommitAuthority,
  type RuntimeCommitAuthority,
} from './runtime-ports.js'
import type {
  RuntimeComponentReference,
  RuntimeType,
} from './runtime-definition.js'
import { RuntimeComponentReferenceSchema } from './runtime-definition.js'

export interface CapabilityDefinition<
  TRuntime extends RuntimeType,
  TInput extends JsonValue = JsonValue,
  TOutput extends JsonValue = JsonValue,
> {
  readonly runtimeType: TRuntime
  readonly capability: RuntimeComponentReference
  readonly mode: 'readOnly' | 'deterministicCompute'
  readonly inputSchema: RuntimeComponentReference
  readonly outputSchema: RuntimeComponentReference
  readonly timeoutMs: number
  readonly parseInput: (input: unknown) => TInput
  readonly parseOutput: (input: unknown) => TOutput
  readonly execute: (input: TInput, signal: AbortSignal) => Promise<TOutput>
}

export interface CapabilityInvocationAudit {
  readonly capability: RuntimeComponentReference
  readonly authorized: true
  readonly inputSchemaVersion: number
  readonly inputHash: string
  readonly outputSchemaVersion: number | null
  readonly outputHash: string | null
  readonly budgetCost: 1
  readonly durationMs: number
  readonly errorCode: string | null
}

export interface CapabilityExecutionControlPort {
  reserveInvocation(input: {
    readonly capability: RuntimeComponentReference
    readonly inputSchemaVersion: number
    readonly inputHash: string
  }): Promise<
    | { readonly kind: 'reserved'; readonly reservationId: string }
    | { readonly kind: 'budgetExhausted' }
    | { readonly kind: 'authorityLost' }
  >
  finishInvocation(input: {
    readonly reservationId: string
    readonly audit: CapabilityInvocationAudit
  }): Promise<'recorded' | 'stale' | 'authorityLost'>
}

export interface CapabilityExecutor<TRuntime extends RuntimeType> {
  invoke<TOutput extends JsonValue>(input: {
    readonly runtimeType: TRuntime
    readonly authority: RuntimeCommitAuthority<TRuntime>
    readonly capability: RuntimeComponentReference
    readonly payload: unknown
    readonly signal: AbortSignal
    readonly control: CapabilityExecutionControlPort
  }): Promise<TOutput>
}

function referenceKey(reference: RuntimeComponentReference): string {
  return `${reference.id}@${String(reference.version)}`
}

function hashJson(value: JsonValue): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

function createCombinedAbort(
  parentSignal: AbortSignal,
  timeoutMs: number,
): {
  readonly signal: AbortSignal
  readonly cleanup: () => void
  readonly timedOut: () => boolean
} {
  const controller = new AbortController()
  let timeoutTriggered = false
  const onParentAbort = (): void => controller.abort('runtime_cancelled')
  if (parentSignal.aborted) {
    onParentAbort()
  } else {
    parentSignal.addEventListener('abort', onParentAbort, { once: true })
  }
  const timeout = setTimeout(() => {
    timeoutTriggered = true
    controller.abort('capability_timeout')
  }, timeoutMs)
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout)
      parentSignal.removeEventListener('abort', onParentAbort)
    },
    timedOut: () => timeoutTriggered,
  }
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

export function createCapabilityExecutor<TRuntime extends RuntimeType>(input: {
  readonly runtimeType: TRuntime
  readonly manifest: CapabilityManifest<TRuntime>
  readonly budget: ExecutionBudget
  readonly definitions: readonly CapabilityDefinition<TRuntime>[]
}): CapabilityExecutor<TRuntime> {
  if (input.manifest.runtimeType !== input.runtimeType) {
    throw new FoundationProtocolError('capabilityRuntimeMismatch')
  }
  const definitions = new Map<string, CapabilityDefinition<TRuntime>>()
  for (const definition of input.definitions) {
    const capability = RuntimeComponentReferenceSchema.safeParse(
      definition.capability,
    )
    const inputSchema = RuntimeComponentReferenceSchema.safeParse(
      definition.inputSchema,
    )
    const outputSchema = RuntimeComponentReferenceSchema.safeParse(
      definition.outputSchema,
    )
    if (
      definition.runtimeType !== input.runtimeType ||
      !capability.success ||
      !inputSchema.success ||
      !outputSchema.success ||
      capability.data.id.startsWith(`${input.runtimeType}.commit-`) ||
      (definition.mode !== 'readOnly' &&
        definition.mode !== 'deterministicCompute') ||
      !Number.isSafeInteger(definition.timeoutMs) ||
      definition.timeoutMs <= 0 ||
      typeof definition.parseInput !== 'function' ||
      typeof definition.parseOutput !== 'function' ||
      typeof definition.execute !== 'function'
    ) {
      throw new FoundationProtocolError('capabilityRuntimeMismatch')
    }
    const snapshot = deepFreeze({
      runtimeType: definition.runtimeType,
      capability: { ...capability.data },
      mode: definition.mode,
      inputSchema: { ...inputSchema.data },
      outputSchema: { ...outputSchema.data },
      timeoutMs: definition.timeoutMs,
      parseInput: definition.parseInput,
      parseOutput: definition.parseOutput,
      execute: definition.execute,
    }) as CapabilityDefinition<TRuntime>
    const key = referenceKey(snapshot.capability)
    if (definitions.has(key)) {
      throw new FoundationProtocolError('capabilityNotDeclared')
    }
    definitions.set(key, snapshot)
  }
  const grants = new Map(
    input.manifest.grants.map((grant) => [
      referenceKey(grant.capability),
      grant,
    ]),
  )

  return Object.freeze({
    async invoke<TOutput extends JsonValue>(invocation: {
      readonly runtimeType: TRuntime
      readonly authority: RuntimeCommitAuthority<TRuntime>
      readonly capability: RuntimeComponentReference
      readonly payload: unknown
      readonly signal: AbortSignal
      readonly control: CapabilityExecutionControlPort
    }): Promise<TOutput> {
      if (
        invocation.runtimeType !== input.runtimeType ||
        !isRuntimeCommitAuthority(invocation.authority, input.runtimeType)
      ) {
        throw new FoundationProtocolError('capabilityAuthorityLost')
      }
      if (invocation.signal.aborted) {
        throw new FoundationProtocolError('capabilityCancelled')
      }
      const key = referenceKey(invocation.capability)
      const definition = definitions.get(key)
      const grant = grants.get(key)
      if (definition === undefined || grant === undefined) {
        throw new FoundationProtocolError('capabilityNotDeclared')
      }
      let parsedInput: JsonValue
      try {
        parsedInput = definition.parseInput(invocation.payload)
        canonicalJson(parsedInput)
      } catch {
        throw new FoundationProtocolError('capabilitySchemaRejected')
      }
      if (invocation.signal.aborted) {
        throw new FoundationProtocolError('capabilityCancelled')
      }
      const inputHash = hashJson(parsedInput)
      const reservation = await invocation.control.reserveInvocation({
        capability: invocation.capability,
        inputSchemaVersion: definition.inputSchema.version,
        inputHash,
      })
      if (reservation.kind === 'budgetExhausted') {
        throw new FoundationProtocolError('capabilityBudgetExhausted')
      }
      if (reservation.kind === 'authorityLost') {
        throw new FoundationProtocolError('capabilityAuthorityLost')
      }

      const startedAt = performance.now()
      const combined = createCombinedAbort(
        invocation.signal,
        Math.min(definition.timeoutMs, input.budget.attemptTimeoutMs),
      )
      let output: JsonValue | undefined
      let failure: FoundationProtocolError | undefined
      try {
        if (combined.signal.aborted) {
          throw new Error('capability_aborted')
        }
        const rawOutput = await Promise.race([
          definition.execute(parsedInput, combined.signal),
          new Promise<never>((_resolve, reject) => {
            combined.signal.addEventListener(
              'abort',
              () => reject(new Error('capability_aborted')),
              { once: true },
            )
          }),
        ])
        if (combined.signal.aborted) {
          throw new Error('capability_aborted')
        }
        try {
          output = deepFreeze(
            structuredClone(definition.parseOutput(rawOutput)),
          )
          canonicalJson(output)
        } catch {
          failure = new FoundationProtocolError('capabilitySchemaRejected')
        }
      } catch {
        failure = new FoundationProtocolError(
          combined.timedOut()
            ? 'capabilityTimeout'
            : invocation.signal.aborted
              ? 'capabilityCancelled'
              : 'capabilityExecutionFailed',
        )
      } finally {
        combined.cleanup()
      }
      if (failure === undefined && invocation.signal.aborted) {
        failure = new FoundationProtocolError('capabilityCancelled')
      }
      const auditResult = await invocation.control.finishInvocation({
        reservationId: reservation.reservationId,
        audit: {
          capability: invocation.capability,
          authorized: true,
          inputSchemaVersion: definition.inputSchema.version,
          inputHash,
          outputSchemaVersion:
            failure === undefined ? definition.outputSchema.version : null,
          outputHash:
            failure === undefined && output !== undefined
              ? hashJson(output)
              : null,
          budgetCost: 1,
          durationMs: Math.max(0, Math.ceil(performance.now() - startedAt)),
          errorCode: failure?.failure ?? null,
        },
      })
      if (auditResult === 'authorityLost') {
        throw new FoundationProtocolError('capabilityAuthorityLost')
      }
      if (auditResult === 'stale') {
        throw new FoundationProtocolError('capabilityDeadlineExhausted')
      }
      if (failure !== undefined) throw failure
      if (invocation.signal.aborted) {
        throw new FoundationProtocolError('capabilityCancelled')
      }
      return output as TOutput
    },
  })
}
