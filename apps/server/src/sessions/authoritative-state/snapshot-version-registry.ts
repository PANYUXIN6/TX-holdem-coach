import { ZodError } from 'zod'
import {
  AuthoritativeStateValidationError,
  CurrentPayloadValidationError,
  VersionRegistryConfigurationError,
} from './errors.js'
import {
  createPrivateTableState,
  type PrivateTableState,
} from './private-table-state.js'
import {
  decodeCurrentSnapshotV1,
  PRIVATE_TABLE_STATE_PAYLOAD_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
} from './snapshot-codec-v1.js'

export interface SnapshotVersionIdentity {
  readonly rowPayloadVersion: number
  readonly envelopeSchemaVersion: number
}

export type SnapshotVersionRegistration =
  | {
      readonly kind: 'current'
      readonly identity: SnapshotVersionIdentity
      readonly decode: (input: unknown) => PrivateTableState
    }
  | {
      readonly kind: 'legacy'
      readonly identity: SnapshotVersionIdentity
      readonly decode: (input: unknown) => unknown
      readonly migrate: (decoded: unknown) => unknown
    }

export type SnapshotVersionReadResult =
  | { readonly kind: 'decoded'; readonly value: PrivateTableState }
  | { readonly kind: 'unknownVersion' }
  | { readonly kind: 'invalidPayload' }

export interface SnapshotVersionRegistry {
  read(rowPayloadVersion: unknown, payload: unknown): SnapshotVersionReadResult
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value > 0
}

function identityKey(identity: SnapshotVersionIdentity): string {
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

export function createSnapshotVersionRegistry(
  registrations: readonly SnapshotVersionRegistration[],
): SnapshotVersionRegistry {
  const byIdentity = new Map<string, SnapshotVersionRegistration>()
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
    ): SnapshotVersionReadResult {
      if (
        !isPositiveSafeInteger(rowPayloadVersion) ||
        !isRecord(payload) ||
        !isPositiveSafeInteger(payload.snapshotSchemaVersion)
      ) {
        return { kind: 'invalidPayload' }
      }
      const registration = byIdentity.get(
        identityKey({
          rowPayloadVersion,
          envelopeSchemaVersion: payload.snapshotSchemaVersion,
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
            : createPrivateTableState(
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

export const productionSnapshotVersionRegistry = createSnapshotVersionRegistry([
  {
    kind: 'current',
    identity: {
      rowPayloadVersion: PRIVATE_TABLE_STATE_PAYLOAD_VERSION,
      envelopeSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
    },
    decode: (input) => decodeCurrentSnapshotV1(input).payload.state,
  },
])
