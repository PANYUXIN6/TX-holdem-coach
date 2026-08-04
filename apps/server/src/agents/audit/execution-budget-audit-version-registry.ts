import { ZodError } from 'zod'
import {
  AgentAuditPayloadValidationError,
  AgentAuditVersionRegistryConfigurationError,
} from './errors.js'
import {
  decodeCurrentExecutionBudgetAuditV1,
  encodeExecutionBudgetAuditV1,
  EXECUTION_BUDGET_AUDIT_PAYLOAD_VERSION,
  EXECUTION_BUDGET_AUDIT_SCHEMA_VERSION,
  type ExecutionBudgetAuditV1,
} from './execution-budget-audit-codec-v1.js'

export interface ExecutionBudgetAuditVersionIdentity {
  readonly rowPayloadVersion: number
  readonly envelopeSchemaVersion: number
}

export type ExecutionBudgetAuditVersionRegistration =
  | {
      readonly kind: 'current'
      readonly identity: ExecutionBudgetAuditVersionIdentity
      readonly decode: (input: unknown) => ExecutionBudgetAuditV1
    }
  | {
      readonly kind: 'legacy'
      readonly identity: ExecutionBudgetAuditVersionIdentity
      readonly decode: (input: unknown) => unknown
      readonly migrate: (decoded: unknown) => unknown
    }

export type ExecutionBudgetAuditVersionReadResult =
  | { readonly kind: 'decoded'; readonly value: ExecutionBudgetAuditV1 }
  | { readonly kind: 'unknownVersion' }
  | { readonly kind: 'invalidPayload' }

export interface ExecutionBudgetAuditVersionRegistry {
  read(
    rowPayloadVersion: unknown,
    payload: unknown,
  ): ExecutionBudgetAuditVersionReadResult
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function identityKey(identity: ExecutionBudgetAuditVersionIdentity): string {
  return `${identity.rowPayloadVersion}:${identity.envelopeSchemaVersion}`
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const nestedValue of Object.values(value)) deepFreeze(nestedValue)
    Object.freeze(value)
  }
  return value
}

function isPayloadValidationError(error: unknown): boolean {
  return (
    error instanceof AgentAuditPayloadValidationError ||
    error instanceof ZodError
  )
}

export function createExecutionBudgetAuditVersionRegistry(
  registrations: readonly ExecutionBudgetAuditVersionRegistration[],
): ExecutionBudgetAuditVersionRegistry {
  const byIdentity = new Map<string, ExecutionBudgetAuditVersionRegistration>()
  for (const registration of registrations) {
    if (
      !isPositiveSafeInteger(registration.identity.rowPayloadVersion) ||
      !isPositiveSafeInteger(registration.identity.envelopeSchemaVersion) ||
      byIdentity.has(identityKey(registration.identity))
    ) {
      throw new AgentAuditVersionRegistryConfigurationError()
    }
    byIdentity.set(identityKey(registration.identity), deepFreeze(registration))
  }

  return deepFreeze({
    read(
      rowPayloadVersion: unknown,
      payload: unknown,
    ): ExecutionBudgetAuditVersionReadResult {
      if (
        !isPositiveSafeInteger(rowPayloadVersion) ||
        !isRecord(payload) ||
        !isPositiveSafeInteger(payload.executionBudgetAuditSchemaVersion)
      ) {
        return { kind: 'invalidPayload' }
      }
      const registration = byIdentity.get(
        identityKey({
          rowPayloadVersion,
          envelopeSchemaVersion: payload.executionBudgetAuditSchemaVersion,
        }),
      )
      if (registration === undefined) return { kind: 'unknownVersion' }
      try {
        const row = { payloadVersion: rowPayloadVersion, payload }
        const value =
          registration.kind === 'current'
            ? registration.decode(row)
            : encodeExecutionBudgetAuditV1(
                registration.migrate(registration.decode(row)),
              ).payload.budget
        return deepFreeze({ kind: 'decoded', value })
      } catch (error) {
        if (isPayloadValidationError(error)) return { kind: 'invalidPayload' }
        throw error
      }
    },
  })
}

export const productionExecutionBudgetAuditVersionRegistry =
  createExecutionBudgetAuditVersionRegistry([
    {
      kind: 'current',
      identity: {
        rowPayloadVersion: EXECUTION_BUDGET_AUDIT_PAYLOAD_VERSION,
        envelopeSchemaVersion: EXECUTION_BUDGET_AUDIT_SCHEMA_VERSION,
      },
      decode: (input) =>
        decodeCurrentExecutionBudgetAuditV1(input).payload.budget,
    },
  ])
