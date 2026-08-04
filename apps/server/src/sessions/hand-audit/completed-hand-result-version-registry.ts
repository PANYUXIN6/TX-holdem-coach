import { ZodError } from 'zod'
import {
  CompletedHandResultSchema,
  type CompletedHandResult,
} from '../../poker/hand-result.js'
import {
  COMPLETED_HAND_RESULT_PAYLOAD_VERSION,
  decodeCurrentCompletedHandResultV1,
  HAND_RESULT_SCHEMA_VERSION,
} from './completed-hand-result-codec-v1.js'
import {
  HandAuditPayloadValidationError,
  HandAuditVersionRegistryConfigurationError,
} from './errors.js'

export interface CompletedHandResultVersionIdentity {
  readonly rowPayloadVersion: number
  readonly envelopeSchemaVersion: number
}

export type CompletedHandResultVersionRegistration =
  | {
      readonly kind: 'current'
      readonly identity: CompletedHandResultVersionIdentity
      readonly decode: (input: unknown) => CompletedHandResult
    }
  | {
      readonly kind: 'legacy'
      readonly identity: CompletedHandResultVersionIdentity
      readonly decode: (input: unknown) => unknown
      readonly migrate: (decoded: unknown) => unknown
    }

export type CompletedHandResultVersionReadResult =
  | { readonly kind: 'decoded'; readonly value: CompletedHandResult }
  | { readonly kind: 'unknownVersion' }
  | { readonly kind: 'invalidPayload' }

export interface CompletedHandResultVersionRegistry {
  read(
    rowPayloadVersion: unknown,
    payload: unknown,
  ): CompletedHandResultVersionReadResult
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function identityKey(identity: CompletedHandResultVersionIdentity): string {
  return `${identity.rowPayloadVersion}:${identity.envelopeSchemaVersion}`
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const nestedValue of Object.values(value)) deepFreeze(nestedValue)
    Object.freeze(value)
  }
  return value
}

export function createCompletedHandResultVersionRegistry(
  registrations: readonly CompletedHandResultVersionRegistration[],
): CompletedHandResultVersionRegistry {
  const byIdentity = new Map<string, CompletedHandResultVersionRegistration>()
  for (const registration of registrations) {
    if (
      !isPositiveSafeInteger(registration.identity.rowPayloadVersion) ||
      !isPositiveSafeInteger(registration.identity.envelopeSchemaVersion) ||
      byIdentity.has(identityKey(registration.identity))
    ) {
      throw new HandAuditVersionRegistryConfigurationError()
    }
    byIdentity.set(identityKey(registration.identity), deepFreeze(registration))
  }

  return deepFreeze({
    read(
      rowPayloadVersion: unknown,
      payload: unknown,
    ): CompletedHandResultVersionReadResult {
      if (
        !isPositiveSafeInteger(rowPayloadVersion) ||
        !isRecord(payload) ||
        !isPositiveSafeInteger(payload.resultSchemaVersion)
      ) {
        return { kind: 'invalidPayload' }
      }
      const registration = byIdentity.get(
        identityKey({
          rowPayloadVersion,
          envelopeSchemaVersion: payload.resultSchemaVersion,
        }),
      )
      if (registration === undefined) return { kind: 'unknownVersion' }
      try {
        const row = { payloadVersion: rowPayloadVersion, payload }
        const value =
          registration.kind === 'current'
            ? registration.decode(row)
            : CompletedHandResultSchema.parse(
                registration.migrate(registration.decode(row)),
              )
        return deepFreeze({
          kind: 'decoded',
          value: structuredClone(value),
        })
      } catch (error) {
        if (
          error instanceof HandAuditPayloadValidationError ||
          error instanceof ZodError
        ) {
          return { kind: 'invalidPayload' }
        }
        throw error
      }
    },
  })
}

export const productionCompletedHandResultVersionRegistry =
  createCompletedHandResultVersionRegistry([
    {
      kind: 'current',
      identity: {
        rowPayloadVersion: COMPLETED_HAND_RESULT_PAYLOAD_VERSION,
        envelopeSchemaVersion: HAND_RESULT_SCHEMA_VERSION,
      },
      decode: (input) =>
        decodeCurrentCompletedHandResultV1(input).payload.result,
    },
  ])
