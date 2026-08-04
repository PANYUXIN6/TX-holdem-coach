import { z } from 'zod'
import {
  HandAuditPayloadValidationError,
  HandAuditPayloadVersionError,
} from './errors.js'
import {
  createHandStartCheckpointV1,
  type HandStartCheckpointV1,
} from './hand-start-checkpoint.js'

export const HAND_START_CHECKPOINT_PAYLOAD_VERSION = 1 as const
export const CHECKPOINT_SCHEMA_VERSION = 1 as const

export interface StoredHandStartCheckpointV1 {
  readonly payloadVersion: typeof HAND_START_CHECKPOINT_PAYLOAD_VERSION
  readonly payload: {
    readonly checkpointSchemaVersion: typeof CHECKPOINT_SCHEMA_VERSION
    readonly checkpoint: HandStartCheckpointV1
  }
}

const StoredCheckpointInputSchema = z.strictObject({
  payloadVersion: z.literal(HAND_START_CHECKPOINT_PAYLOAD_VERSION),
  payload: z.strictObject({
    checkpointSchemaVersion: z.literal(CHECKPOINT_SCHEMA_VERSION),
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

export function decodeCurrentHandStartCheckpointV1(
  input: unknown,
): StoredHandStartCheckpointV1 {
  if (!isRecord(input)) throw new HandAuditPayloadValidationError()
  const rowVersion = PositiveIntegerSchema.safeParse(input.payloadVersion)
  if (!rowVersion.success) throw new HandAuditPayloadValidationError()
  if (rowVersion.data !== HAND_START_CHECKPOINT_PAYLOAD_VERSION) {
    throw new HandAuditPayloadVersionError('checkpointRowVersion')
  }
  if (!isRecord(input.payload)) throw new HandAuditPayloadValidationError()
  const envelopeVersion = PositiveIntegerSchema.safeParse(
    input.payload.checkpointSchemaVersion,
  )
  if (!envelopeVersion.success) throw new HandAuditPayloadValidationError()
  if (envelopeVersion.data !== CHECKPOINT_SCHEMA_VERSION) {
    throw new HandAuditPayloadVersionError('checkpointEnvelopeVersion')
  }
  try {
    const parsed = StoredCheckpointInputSchema.parse(input)
    return deepFreeze({
      payloadVersion: HAND_START_CHECKPOINT_PAYLOAD_VERSION,
      payload: {
        checkpointSchemaVersion: CHECKPOINT_SCHEMA_VERSION,
        checkpoint: createHandStartCheckpointV1(parsed.payload.checkpoint),
      },
    })
  } catch (error) {
    if (error instanceof HandAuditPayloadVersionError) throw error
    throw new HandAuditPayloadValidationError()
  }
}

export function encodeHandStartCheckpointV1(
  input: unknown,
): StoredHandStartCheckpointV1 {
  const checkpoint = createHandStartCheckpointV1(input)
  return decodeCurrentHandStartCheckpointV1({
    payloadVersion: HAND_START_CHECKPOINT_PAYLOAD_VERSION,
    payload: {
      checkpointSchemaVersion: CHECKPOINT_SCHEMA_VERSION,
      checkpoint,
    },
  })
}
