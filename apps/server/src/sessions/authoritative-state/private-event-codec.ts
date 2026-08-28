import { z } from 'zod'
import type { PersistedJsonReader } from '../../persisted-json.js'
import {
  CurrentPayloadValidationError,
  CurrentPayloadVersionError,
} from './errors.js'
import {
  createPrivateEvent,
  createPrivateEventV1,
  type PrivateEvent,
  type PrivateEventV1,
} from './private-event.js'

export const LEGACY_PRIVATE_EVENT_PAYLOAD_VERSION = 1 as const
export const PRIVATE_EVENT_PAYLOAD_VERSION = 2 as const

export interface StoredPrivateEventV1 {
  readonly payloadVersion: typeof LEGACY_PRIVATE_EVENT_PAYLOAD_VERSION
  readonly payload: {
    readonly event: PrivateEventV1
  }
}

export interface StoredPrivateEvent {
  readonly payloadVersion: typeof PRIVATE_EVENT_PAYLOAD_VERSION
  readonly payload: {
    readonly event: PrivateEvent
  }
}

const PrivateEventV1InputSchema = z.strictObject({
  payloadVersion: z.literal(LEGACY_PRIVATE_EVENT_PAYLOAD_VERSION),
  payload: z.strictObject({
    event: z.unknown(),
  }),
})
const PrivateEventV2InputSchema = z.strictObject({
  payloadVersion: z.literal(PRIVATE_EVENT_PAYLOAD_VERSION),
  payload: z.strictObject({
    event: z.unknown(),
  }),
})
const PayloadVersionSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)

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

function decodePrivateEventV1(input: unknown): StoredPrivateEventV1 {
  if (!isRecord(input)) throw new CurrentPayloadValidationError()
  const rowVersion = PayloadVersionSchema.safeParse(input.payloadVersion)
  if (!rowVersion.success) throw new CurrentPayloadValidationError()
  if (rowVersion.data !== LEGACY_PRIVATE_EVENT_PAYLOAD_VERSION) {
    throw new CurrentPayloadVersionError('eventRowVersion')
  }
  if (!isRecord(input.payload)) throw new CurrentPayloadValidationError()
  try {
    const parsed = PrivateEventV1InputSchema.parse(input)
    return deepFreeze({
      payloadVersion: LEGACY_PRIVATE_EVENT_PAYLOAD_VERSION,
      payload: {
        event: createPrivateEventV1(parsed.payload.event),
      },
    })
  } catch {
    throw new CurrentPayloadValidationError()
  }
}

export function decodePrivateEventV1Row(input: unknown): StoredPrivateEventV1 {
  return decodePrivateEventV1(input)
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
    const parsed = PrivateEventV2InputSchema.parse(input)
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

export const privateEventReader: PersistedJsonReader<PrivateEvent> =
  Object.freeze({
    read(rowPayloadVersion: unknown, payload: unknown) {
      const version = PayloadVersionSchema.safeParse(rowPayloadVersion)
      if (!version.success) return { kind: 'invalidPayload' as const }
      try {
        if (version.data === LEGACY_PRIVATE_EVENT_PAYLOAD_VERSION) {
          return {
            kind: 'decoded' as const,
            value: decodePrivateEventV1({
              payloadVersion: version.data,
              payload,
            }).payload.event,
          }
        }
        if (version.data === PRIVATE_EVENT_PAYLOAD_VERSION) {
          return {
            kind: 'decoded' as const,
            value: decodeCurrentPrivateEvent({
              payloadVersion: version.data,
              payload,
            }).payload.event,
          }
        }
        return { kind: 'unknownVersion' as const }
      } catch (error) {
        if (
          error instanceof CurrentPayloadValidationError ||
          error instanceof CurrentPayloadVersionError
        ) {
          return { kind: 'invalidPayload' as const }
        }
        throw error
      }
    },
  })

export const currentPrivateEventReader = privateEventReader
