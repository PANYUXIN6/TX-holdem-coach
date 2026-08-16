import { ZodError } from 'zod'
import {
  AgentAuditPayloadValidationError,
  AgentAuditVersionRegistryConfigurationError,
} from './errors.js'
import {
  decodeCurrentExecutionBudgetAuditV1,
  encodeExecutionBudgetAuditV1,
  EXECUTION_BUDGET_AUDIT_PAYLOAD_VERSION,
  type ExecutionBudgetAuditV1,
} from './execution-budget-audit-codec-v1.js'
import {
  isPositiveSafeInteger,
  type PersistedJsonReadResult,
} from '../../persisted-json.js'

export interface ExecutionBudgetAuditVersionIdentity {
  readonly rowPayloadVersion: number
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
  PersistedJsonReadResult<ExecutionBudgetAuditV1>

export interface ExecutionBudgetAuditVersionRegistry {
  read(
    rowPayloadVersion: unknown,
    payload: unknown,
  ): ExecutionBudgetAuditVersionReadResult
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
  const byVersion = new Map<number, ExecutionBudgetAuditVersionRegistration>()
  for (const registration of registrations) {
    if (
      !isPositiveSafeInteger(registration.identity.rowPayloadVersion) ||
      byVersion.has(registration.identity.rowPayloadVersion)
    ) {
      throw new AgentAuditVersionRegistryConfigurationError()
    }
    byVersion.set(
      registration.identity.rowPayloadVersion,
      deepFreeze(registration),
    )
  }

  return deepFreeze({
    read(
      rowPayloadVersion: unknown,
      payload: unknown,
    ): ExecutionBudgetAuditVersionReadResult {
      if (!isPositiveSafeInteger(rowPayloadVersion)) {
        return { kind: 'invalidPayload' }
      }
      const registration = byVersion.get(rowPayloadVersion)
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
      },
      decode: (input) =>
        decodeCurrentExecutionBudgetAuditV1(input).payload.budget,
    },
  ])
