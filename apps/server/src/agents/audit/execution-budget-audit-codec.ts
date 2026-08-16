import { z } from 'zod'
import {
  createExecutionBudget,
  type ExecutionBudget,
} from '../foundation/execution-budget.js'
import { FoundationProtocolError } from '../foundation/errors.js'
import {
  readCurrentPersistedJson,
  type PersistedJsonReader,
} from '../../persisted-json.js'
import { PositiveSafeIntegerSchema } from './audit-primitives.js'
import {
  AgentAuditPayloadValidationError,
  AgentAuditPayloadVersionError,
} from './errors.js'

export const EXECUTION_BUDGET_AUDIT_PAYLOAD_VERSION = 1 as const

export type ExecutionBudgetAudit = ExecutionBudget

export interface StoredExecutionBudgetAudit {
  readonly payloadVersion: typeof EXECUTION_BUDGET_AUDIT_PAYLOAD_VERSION
  readonly payload: {
    readonly budget: ExecutionBudgetAudit
  }
}

const StoredExecutionBudgetAuditSchema = z.strictObject({
  payloadVersion: z.literal(EXECUTION_BUDGET_AUDIT_PAYLOAD_VERSION),
  payload: z.strictObject({
    budget: z.unknown(),
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

function parseExecutionBudget(input: unknown): ExecutionBudgetAudit {
  try {
    return createExecutionBudget(input)
  } catch (error) {
    if (error instanceof FoundationProtocolError) {
      throw new AgentAuditPayloadValidationError()
    }
    throw error
  }
}

export function decodeCurrentExecutionBudgetAudit(
  input: unknown,
): StoredExecutionBudgetAudit {
  if (!isRecord(input)) throw new AgentAuditPayloadValidationError()
  const rowVersion = PositiveSafeIntegerSchema.safeParse(input.payloadVersion)
  if (!rowVersion.success) throw new AgentAuditPayloadValidationError()
  if (rowVersion.data !== EXECUTION_BUDGET_AUDIT_PAYLOAD_VERSION) {
    throw new AgentAuditPayloadVersionError('executionBudgetRowVersion')
  }
  if (!isRecord(input.payload)) throw new AgentAuditPayloadValidationError()

  const parsed = StoredExecutionBudgetAuditSchema.safeParse(input)
  if (!parsed.success) throw new AgentAuditPayloadValidationError()
  return deepFreeze({
    payloadVersion: EXECUTION_BUDGET_AUDIT_PAYLOAD_VERSION,
    payload: { budget: parseExecutionBudget(parsed.data.payload.budget) },
  })
}

export function encodeExecutionBudgetAudit(
  input: unknown,
): StoredExecutionBudgetAudit {
  const budget = parseExecutionBudget(input)
  return decodeCurrentExecutionBudgetAudit({
    payloadVersion: EXECUTION_BUDGET_AUDIT_PAYLOAD_VERSION,
    payload: {
      budget,
    },
  })
}

export const currentExecutionBudgetAuditReader: PersistedJsonReader<ExecutionBudgetAudit> =
  Object.freeze({
    read(rowPayloadVersion: unknown, payload: unknown) {
      return readCurrentPersistedJson({
        rowPayloadVersion,
        payload,
        currentRowPayloadVersion: EXECUTION_BUDGET_AUDIT_PAYLOAD_VERSION,
        decode: (stored) =>
          decodeCurrentExecutionBudgetAudit(stored).payload.budget,
        isPayloadValidationError: (error) =>
          error instanceof AgentAuditPayloadValidationError,
      })
    },
  })
