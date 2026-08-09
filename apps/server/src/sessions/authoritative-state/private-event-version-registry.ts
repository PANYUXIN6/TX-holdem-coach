import { ZodError } from 'zod'
import {
  AuthoritativeStateValidationError,
  CurrentPayloadValidationError,
  VersionRegistryConfigurationError,
} from './errors.js'
import {
  decodeCurrentPrivateEventV1,
  EVENT_SCHEMA_VERSION,
  PRIVATE_EVENT_PAYLOAD_VERSION,
} from './private-event-codec-v1.js'
import { type StoredPrivateEventV2 } from './private-event-codec-v2.js'
import {
  currentPrivateEventProtocol,
  type CurrentPrivateEventProtocol,
} from './current-private-event-protocol.js'
import {
  createPrivateEventV2,
  type PrivateEventV2,
} from './private-event-v2.js'

export interface PrivateEventVersionIdentity {
  readonly rowPayloadVersion: number
  readonly envelopeSchemaVersion: number
}

export type PrivateEventVersionRegistration =
  | {
      readonly kind: 'current'
      readonly identity: PrivateEventVersionIdentity
      readonly decode: (input: unknown) => PrivateEventV2
    }
  | {
      readonly kind: 'legacy'
      readonly identity: PrivateEventVersionIdentity
      readonly decode: (input: unknown) => unknown
      readonly migrate: (decoded: unknown) => unknown
    }

export type PrivateEventVersionReadResult =
  | { readonly kind: 'decoded'; readonly value: PrivateEventV2 }
  | { readonly kind: 'unknownVersion' }
  | { readonly kind: 'invalidPayload' }

export interface PrivateEventVersionRegistry {
  read(
    rowPayloadVersion: unknown,
    payload: unknown,
  ): PrivateEventVersionReadResult
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value > 0
}

function identityKey(identity: PrivateEventVersionIdentity): string {
  return `${identity.rowPayloadVersion}:${identity.envelopeSchemaVersion}`
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const nestedValue of Object.values(value)) {
      deepFreeze(nestedValue)
    }
    Object.freeze(value)
  }
  return value
}

function isPayloadValidationError(error: unknown): boolean {
  return (
    error instanceof CurrentPayloadValidationError ||
    error instanceof AuthoritativeStateValidationError ||
    error instanceof ZodError
  )
}

export function createPrivateEventVersionRegistry(
  input:
    | readonly PrivateEventVersionRegistration[]
    | {
        readonly current: CurrentPrivateEventProtocol<
          PrivateEventV2,
          StoredPrivateEventV2
        >
        readonly legacy: readonly PrivateEventVersionRegistration[]
      },
): PrivateEventVersionRegistry {
  const registrations: readonly PrivateEventVersionRegistration[] =
    'current' in input
      ? [
          {
            kind: 'current' as const,
            identity: input.current.identity,
            decode: input.current.decodeStoredCurrent,
          },
          ...input.legacy,
        ]
      : input
  const byIdentity = new Map<string, PrivateEventVersionRegistration>()
  for (const registration of registrations) {
    if (
      !isPositiveSafeInteger(registration.identity.rowPayloadVersion) ||
      !isPositiveSafeInteger(registration.identity.envelopeSchemaVersion) ||
      byIdentity.has(identityKey(registration.identity))
    ) {
      throw new VersionRegistryConfigurationError()
    }
    byIdentity.set(identityKey(registration.identity), deepFreeze(registration))
  }

  return deepFreeze({
    read(
      rowPayloadVersion: unknown,
      payload: unknown,
    ): PrivateEventVersionReadResult {
      if (
        !isPositiveSafeInteger(rowPayloadVersion) ||
        !isRecord(payload) ||
        !isPositiveSafeInteger(payload.eventSchemaVersion)
      ) {
        return { kind: 'invalidPayload' }
      }
      const registration = byIdentity.get(
        identityKey({
          rowPayloadVersion,
          envelopeSchemaVersion: payload.eventSchemaVersion,
        }),
      )
      if (registration === undefined) {
        return { kind: 'unknownVersion' }
      }
      try {
        const row = { payloadVersion: rowPayloadVersion, payload }
        const value =
          registration.kind === 'current'
            ? registration.decode(row)
            : createPrivateEventV2(
                registration.migrate(registration.decode(row)),
              )
        return deepFreeze({ kind: 'decoded', value })
      } catch (error) {
        if (isPayloadValidationError(error)) {
          return { kind: 'invalidPayload' }
        }
        throw error
      }
    },
  })
}

export const productionPrivateEventVersionRegistry =
  createPrivateEventVersionRegistry({
    current: currentPrivateEventProtocol,
    legacy: [
      {
        kind: 'legacy',
        identity: {
          rowPayloadVersion: PRIVATE_EVENT_PAYLOAD_VERSION,
          envelopeSchemaVersion: EVENT_SCHEMA_VERSION,
        },
        decode: (input) => decodeCurrentPrivateEventV1(input).payload.event,
        migrate: (decoded) => decoded,
      },
    ],
  })
