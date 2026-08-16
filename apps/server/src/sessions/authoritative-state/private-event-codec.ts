import { z } from 'zod'
import {
  readCurrentPersistedJson,
  type PersistedJsonReader,
} from '../../persisted-json.js'
import {
  CurrentPayloadValidationError,
  CurrentPayloadVersionError,
} from './errors.js'
import { createPrivateEvent, type PrivateEvent } from './private-event.js'

export const PRIVATE_EVENT_PAYLOAD_VERSION = 1 as const

export interface StoredPrivateEvent {
  readonly payloadVersion: typeof PRIVATE_EVENT_PAYLOAD_VERSION
  readonly payload: {
    readonly event: PrivateEvent
  }
}

const PrivateEventInputSchema = z.strictObject({
  payloadVersion: z.literal(PRIVATE_EVENT_PAYLOAD_VERSION),
  payload: z.strictObject({
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

export function decodeCurrentPrivateEvent(input: unknown): StoredPrivateEvent {
  if (!isRecord(input)) throw new CurrentPayloadValidationError()
  const rowVersion = PayloadVersionSchema.safeParse(input.payloadVersion)
  if (!rowVersion.success) throw new CurrentPayloadValidationError()
  if (rowVersion.data !== PRIVATE_EVENT_PAYLOAD_VERSION) {
    throw new CurrentPayloadVersionError('eventRowVersion')
  }
  if (!isRecord(input.payload)) throw new CurrentPayloadValidationError()
  try {
    const parsed = PrivateEventInputSchema.parse(input)
    return deepFreeze({
      payloadVersion: PRIVATE_EVENT_PAYLOAD_VERSION,
      payload: {
        event: createPrivateEvent(parsed.payload.event),
      },
    })
  } catch {
    throw new CurrentPayloadValidationError()
  }
}

export function encodeCurrentPrivateEvent(input: unknown): StoredPrivateEvent {
  const event = createPrivateEvent(input)
  return decodeCurrentPrivateEvent({
    payloadVersion: PRIVATE_EVENT_PAYLOAD_VERSION,
    payload: { event },
  })
}

export const currentPrivateEventReader: PersistedJsonReader<PrivateEvent> =
  Object.freeze({
    read(rowPayloadVersion: unknown, payload: unknown) {
      return readCurrentPersistedJson({
        rowPayloadVersion,
        payload,
        currentRowPayloadVersion: PRIVATE_EVENT_PAYLOAD_VERSION,
        decode: (stored) => decodeCurrentPrivateEvent(stored).payload.event,
        isPayloadValidationError: (error) =>
          error instanceof CurrentPayloadValidationError,
      })
    },
  })
