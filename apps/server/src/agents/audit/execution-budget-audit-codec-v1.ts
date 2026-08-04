import { z } from 'zod'
import {
  NonnegativeSafeIntegerSchema,
  PositiveSafeIntegerSchema,
} from './audit-primitives.js'
import {
  AgentAuditPayloadValidationError,
  AgentAuditPayloadVersionError,
} from './errors.js'

export const EXECUTION_BUDGET_AUDIT_PAYLOAD_VERSION = 1 as const
export const EXECUTION_BUDGET_AUDIT_SCHEMA_VERSION = 1 as const

const ExecutionBudgetAuditV1Schema = z.strictObject({
  maxAttempts: PositiveSafeIntegerSchema,
  maxInputTokens: PositiveSafeIntegerSchema,
  maxOutputTokens: PositiveSafeIntegerSchema,
  maxWallClockMs: PositiveSafeIntegerSchema,
  maxCapabilityInvocations: NonnegativeSafeIntegerSchema,
  maxCostMicrounits: NonnegativeSafeIntegerSchema,
})

export type ExecutionBudgetAuditV1 = Readonly<
  z.infer<typeof ExecutionBudgetAuditV1Schema>
>

export interface StoredExecutionBudgetAuditV1 {
  readonly payloadVersion: typeof EXECUTION_BUDGET_AUDIT_PAYLOAD_VERSION
  readonly payload: {
    readonly executionBudgetAuditSchemaVersion: typeof EXECUTION_BUDGET_AUDIT_SCHEMA_VERSION
    readonly budget: ExecutionBudgetAuditV1
  }
}

const StoredExecutionBudgetAuditV1Schema = z.strictObject({
  payloadVersion: z.literal(EXECUTION_BUDGET_AUDIT_PAYLOAD_VERSION),
  payload: z.strictObject({
    executionBudgetAuditSchemaVersion: z.literal(
      EXECUTION_BUDGET_AUDIT_SCHEMA_VERSION,
    ),
    budget: ExecutionBudgetAuditV1Schema,
  }),
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const nestedValue of Object.values(value)) deepFreeze(nestedValue)
    Object.freeze(value)
  }
  return value
}

export function decodeCurrentExecutionBudgetAuditV1(
  input: unknown,
): StoredExecutionBudgetAuditV1 {
  if (!isRecord(input)) throw new AgentAuditPayloadValidationError()
  const rowVersion = PositiveSafeIntegerSchema.safeParse(input.payloadVersion)
  if (!rowVersion.success) throw new AgentAuditPayloadValidationError()
  if (rowVersion.data !== EXECUTION_BUDGET_AUDIT_PAYLOAD_VERSION) {
    throw new AgentAuditPayloadVersionError('executionBudgetRowVersion')
  }
  if (!isRecord(input.payload)) throw new AgentAuditPayloadValidationError()
  const envelopeVersion = PositiveSafeIntegerSchema.safeParse(
    input.payload.executionBudgetAuditSchemaVersion,
  )
  if (!envelopeVersion.success) throw new AgentAuditPayloadValidationError()
  if (envelopeVersion.data !== EXECUTION_BUDGET_AUDIT_SCHEMA_VERSION) {
    throw new AgentAuditPayloadVersionError('executionBudgetEnvelopeVersion')
  }

  const parsed = StoredExecutionBudgetAuditV1Schema.safeParse(input)
  if (!parsed.success) throw new AgentAuditPayloadValidationError()
  return deepFreeze(parsed.data)
}

export function encodeExecutionBudgetAuditV1(
  input: unknown,
): StoredExecutionBudgetAuditV1 {
  const budget = ExecutionBudgetAuditV1Schema.safeParse(input)
  if (!budget.success) throw new AgentAuditPayloadValidationError()
  return decodeCurrentExecutionBudgetAuditV1({
    payloadVersion: EXECUTION_BUDGET_AUDIT_PAYLOAD_VERSION,
    payload: {
      executionBudgetAuditSchemaVersion: EXECUTION_BUDGET_AUDIT_SCHEMA_VERSION,
      budget: budget.data,
    },
  })
}
