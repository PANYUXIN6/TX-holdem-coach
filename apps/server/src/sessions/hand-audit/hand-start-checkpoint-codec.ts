import { z } from 'zod'
import {
  readCurrentPersistedJson,
  type PersistedJsonReader,
} from '../../persisted-json.js'
import {
  HandAuditPayloadValidationError,
  HandAuditPayloadVersionError,
} from './errors.js'
import {
  createHandStartCheckpoint,
  type HandStartCheckpoint,
} from './hand-start-checkpoint.js'

export const HAND_START_CHECKPOINT_PAYLOAD_VERSION = 1 as const

export interface StoredHandStartCheckpoint {
  readonly payloadVersion: typeof HAND_START_CHECKPOINT_PAYLOAD_VERSION
  readonly payload: {
    readonly checkpoint: HandStartCheckpoint
  }
}

const StoredCheckpointInputSchema = z.strictObject({
  payloadVersion: z.literal(HAND_START_CHECKPOINT_PAYLOAD_VERSION),
  payload: z.strictObject({
    checkpoint: z.unknown(),
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

export function decodeCurrentHandStartCheckpoint(
  input: unknown,
): StoredHandStartCheckpoint {
  if (!isRecord(input)) throw new HandAuditPayloadValidationError()
  const rowVersion = PositiveIntegerSchema.safeParse(input.payloadVersion)
  if (!rowVersion.success) throw new HandAuditPayloadValidationError()
  if (rowVersion.data !== HAND_START_CHECKPOINT_PAYLOAD_VERSION) {
    throw new HandAuditPayloadVersionError('checkpointRowVersion')
  }
  if (!isRecord(input.payload)) throw new HandAuditPayloadValidationError()
  try {
    const parsed = StoredCheckpointInputSchema.parse(input)
    return deepFreeze({
      payloadVersion: HAND_START_CHECKPOINT_PAYLOAD_VERSION,
      payload: {
        checkpoint: createHandStartCheckpoint(parsed.payload.checkpoint),
      },
    })
  } catch (error) {
    if (error instanceof HandAuditPayloadVersionError) throw error
    throw new HandAuditPayloadValidationError()
  }
}

export function encodeCurrentHandStartCheckpoint(
  input: unknown,
): StoredHandStartCheckpoint {
  const checkpoint = createHandStartCheckpoint(input)
  return decodeCurrentHandStartCheckpoint({
    payloadVersion: HAND_START_CHECKPOINT_PAYLOAD_VERSION,
    payload: {
      checkpoint,
    },
  })
}

export const currentHandStartCheckpointReader: PersistedJsonReader<HandStartCheckpoint> =
  Object.freeze({
    read(rowPayloadVersion: unknown, payload: unknown) {
      return readCurrentPersistedJson({
        rowPayloadVersion,
        payload,
        currentRowPayloadVersion: HAND_START_CHECKPOINT_PAYLOAD_VERSION,
        decode: (stored) =>
          decodeCurrentHandStartCheckpoint(stored).payload.checkpoint,
        isPayloadValidationError: (error) =>
          error instanceof HandAuditPayloadValidationError,
      })
    },
  })
