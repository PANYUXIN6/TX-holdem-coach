import { z } from 'zod'
import {
  readCurrentPersistedJson,
  type PersistedJsonReader,
} from '../../persisted-json.js'
import {
  CompletedHandResultSchema,
  type CompletedHandResult,
} from '../../poker/hand-result.js'
import {
  HandAuditPayloadValidationError,
  HandAuditPayloadVersionError,
} from './errors.js'

export const COMPLETED_HAND_RESULT_PAYLOAD_VERSION = 1 as const

export interface StoredCompletedHandResult {
  readonly payloadVersion: typeof COMPLETED_HAND_RESULT_PAYLOAD_VERSION
  readonly payload: {
    readonly result: CompletedHandResult
  }
}

const StoredCompletedResultInputSchema = z.strictObject({
  payloadVersion: z.literal(COMPLETED_HAND_RESULT_PAYLOAD_VERSION),
  payload: z.strictObject({
    result: CompletedHandResultSchema,
  }),
})
const PositiveIntegerSchema = z.number().int().positive()

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

export function decodeCurrentCompletedHandResult(
  input: unknown,
): StoredCompletedHandResult {
  if (!isRecord(input)) throw new HandAuditPayloadValidationError()
  const rowVersion = PositiveIntegerSchema.safeParse(input.payloadVersion)
  if (!rowVersion.success) throw new HandAuditPayloadValidationError()
  if (rowVersion.data !== COMPLETED_HAND_RESULT_PAYLOAD_VERSION) {
    throw new HandAuditPayloadVersionError('completedResultRowVersion')
  }
  if (!isRecord(input.payload)) throw new HandAuditPayloadValidationError()
  try {
    const parsed = StoredCompletedResultInputSchema.parse(input)
    return deepFreeze(structuredClone(parsed))
  } catch (error) {
    if (error instanceof HandAuditPayloadVersionError) throw error
    throw new HandAuditPayloadValidationError()
  }
}

export function encodeCompletedHandResult(
  input: unknown,
): StoredCompletedHandResult {
  let result: CompletedHandResult
  try {
    result = CompletedHandResultSchema.parse(input)
  } catch {
    throw new HandAuditPayloadValidationError()
  }
  return decodeCurrentCompletedHandResult({
    payloadVersion: COMPLETED_HAND_RESULT_PAYLOAD_VERSION,
    payload: { result },
  })
}

export const currentCompletedHandResultReader: PersistedJsonReader<CompletedHandResult> =
  Object.freeze({
    read(rowPayloadVersion: unknown, payload: unknown) {
      return readCurrentPersistedJson({
        rowPayloadVersion,
        payload,
        currentRowPayloadVersion: COMPLETED_HAND_RESULT_PAYLOAD_VERSION,
        decode: (stored) =>
          decodeCurrentCompletedHandResult(stored).payload.result,
        isPayloadValidationError: (error) =>
          error instanceof HandAuditPayloadValidationError,
      })
    },
  })
