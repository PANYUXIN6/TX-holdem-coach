import { z } from 'zod'
import {
  HandAuditPayloadValidationError,
  HandAuditPayloadVersionError,
} from './errors.js'
import {
  createHandStartCheckpointV2,
  type HandStartCheckpointV2,
} from './hand-start-checkpoint.js'

export const HAND_START_CHECKPOINT_V2_PAYLOAD_VERSION = 2 as const
export const CHECKPOINT_V2_SCHEMA_VERSION = 2 as const

export interface StoredHandStartCheckpointV2 {
  readonly payloadVersion: typeof HAND_START_CHECKPOINT_V2_PAYLOAD_VERSION
  readonly payload: {
    readonly checkpointSchemaVersion: typeof CHECKPOINT_V2_SCHEMA_VERSION
    readonly checkpoint: HandStartCheckpointV2
  }
}

const StoredCheckpointInputSchema = z.strictObject({
  payloadVersion: z.literal(HAND_START_CHECKPOINT_V2_PAYLOAD_VERSION),
  payload: z.strictObject({
    checkpointSchemaVersion: z.literal(CHECKPOINT_V2_SCHEMA_VERSION),
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

export function decodeCurrentHandStartCheckpointV2(
  input: unknown,
): StoredHandStartCheckpointV2 {
  if (!isRecord(input)) throw new HandAuditPayloadValidationError()
  const rowVersion = PositiveIntegerSchema.safeParse(input.payloadVersion)
  if (!rowVersion.success) throw new HandAuditPayloadValidationError()
  if (rowVersion.data !== HAND_START_CHECKPOINT_V2_PAYLOAD_VERSION) {
    throw new HandAuditPayloadVersionError('checkpointRowVersion')
  }
  if (!isRecord(input.payload)) throw new HandAuditPayloadValidationError()
  const envelopeVersion = PositiveIntegerSchema.safeParse(
    input.payload.checkpointSchemaVersion,
  )
  if (!envelopeVersion.success) throw new HandAuditPayloadValidationError()
  if (envelopeVersion.data !== CHECKPOINT_V2_SCHEMA_VERSION) {
    throw new HandAuditPayloadVersionError('checkpointEnvelopeVersion')
  }
  try {
    const parsed = StoredCheckpointInputSchema.parse(input)
    return deepFreeze({
      payloadVersion: HAND_START_CHECKPOINT_V2_PAYLOAD_VERSION,
      payload: {
        checkpointSchemaVersion: CHECKPOINT_V2_SCHEMA_VERSION,
        checkpoint: createHandStartCheckpointV2(parsed.payload.checkpoint),
      },
    })
  } catch (error) {
    if (error instanceof HandAuditPayloadVersionError) throw error
    throw new HandAuditPayloadValidationError()
  }
}

export function encodeHandStartCheckpointV2(
  input: unknown,
): StoredHandStartCheckpointV2 {
  const checkpoint = createHandStartCheckpointV2(input)
  return decodeCurrentHandStartCheckpointV2({
    payloadVersion: HAND_START_CHECKPOINT_V2_PAYLOAD_VERSION,
    payload: {
      checkpointSchemaVersion: CHECKPOINT_V2_SCHEMA_VERSION,
      checkpoint,
    },
  })
}
