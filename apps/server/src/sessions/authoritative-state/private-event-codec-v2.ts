import { z } from 'zod'
import {
  CurrentPayloadValidationError,
  CurrentPayloadVersionError,
} from './errors.js'
import {
  createPrivateEventV2,
  type PrivateEventV2,
} from './private-event-v2.js'

export const PRIVATE_EVENT_V2_PAYLOAD_VERSION = 2 as const
export const EVENT_V2_SCHEMA_VERSION = 2 as const

export interface StoredPrivateEventV2 {
  readonly payloadVersion: typeof PRIVATE_EVENT_V2_PAYLOAD_VERSION
  readonly payload: {
    readonly eventSchemaVersion: typeof EVENT_V2_SCHEMA_VERSION
    readonly event: PrivateEventV2
  }
}

const PrivateEventInputSchema = z.strictObject({
  payloadVersion: z.literal(PRIVATE_EVENT_V2_PAYLOAD_VERSION),
  payload: z.strictObject({
    eventSchemaVersion: z.literal(EVENT_V2_SCHEMA_VERSION),
    event: z.unknown(),
  }),
})
const PayloadVersionSchema = z.number().int().positive()

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const nestedValue of Object.values(value)) deepFreeze(nestedValue)
    Object.freeze(value)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function decodeCurrentPrivateEventV2(
  input: unknown,
): StoredPrivateEventV2 {
  if (!isRecord(input)) throw new CurrentPayloadValidationError()
  const rowVersion = PayloadVersionSchema.safeParse(input.payloadVersion)
  if (!rowVersion.success) throw new CurrentPayloadValidationError()
  if (rowVersion.data !== PRIVATE_EVENT_V2_PAYLOAD_VERSION) {
    throw new CurrentPayloadVersionError('eventRowVersion')
  }
  if (!isRecord(input.payload)) throw new CurrentPayloadValidationError()
  const envelopeVersion = PayloadVersionSchema.safeParse(
    input.payload.eventSchemaVersion,
  )
  if (!envelopeVersion.success) throw new CurrentPayloadValidationError()
  if (envelopeVersion.data !== EVENT_V2_SCHEMA_VERSION) {
    throw new CurrentPayloadVersionError('eventEnvelopeVersion')
  }
  try {
    const parsed = PrivateEventInputSchema.parse(input)
    return deepFreeze({
      payloadVersion: PRIVATE_EVENT_V2_PAYLOAD_VERSION,
      payload: {
        eventSchemaVersion: EVENT_V2_SCHEMA_VERSION,
        event: createPrivateEventV2(parsed.payload.event),
      },
    })
  } catch {
    throw new CurrentPayloadValidationError()
  }
}

export function encodePrivateEventV2(input: unknown): StoredPrivateEventV2 {
  const event = createPrivateEventV2(input)
  return decodeCurrentPrivateEventV2({
    payloadVersion: PRIVATE_EVENT_V2_PAYLOAD_VERSION,
    payload: { eventSchemaVersion: EVENT_V2_SCHEMA_VERSION, event },
  })
}
