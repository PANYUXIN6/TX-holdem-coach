import { ZodError } from 'zod'
import { POKER_RULE_SET_VERSION_V1 } from '../../poker/poker-rule-set.js'
import {
  HandAuditPayloadValidationError,
  HandAuditVersionRegistryConfigurationError,
} from './errors.js'
import {
  CHECKPOINT_SCHEMA_VERSION,
  decodeCurrentHandStartCheckpointV1,
  HAND_START_CHECKPOINT_PAYLOAD_VERSION,
} from './hand-start-checkpoint-codec-v1.js'
import {
  CHECKPOINT_V2_SCHEMA_VERSION,
  decodeCurrentHandStartCheckpointV2,
  HAND_START_CHECKPOINT_V2_PAYLOAD_VERSION,
} from './hand-start-checkpoint-codec-v2.js'
import {
  createHandStartCheckpointV2,
  type HandStartCheckpointV1,
  type HandStartCheckpointV2,
} from './hand-start-checkpoint.js'

export interface HandStartCheckpointVersionIdentity {
  readonly rowPayloadVersion: number
  readonly envelopeSchemaVersion: number
}

export type HandStartCheckpointVersionRegistration =
  | {
      readonly kind: 'current'
      readonly identity: HandStartCheckpointVersionIdentity
      readonly decode: (input: unknown) => HandStartCheckpointV2
    }
  | {
      readonly kind: 'legacy'
      readonly identity: HandStartCheckpointVersionIdentity
      readonly decode: (input: unknown) => unknown
      readonly migrate: (decoded: unknown) => unknown
    }

export type HandStartCheckpointVersionReadResult =
  | { readonly kind: 'decoded'; readonly value: HandStartCheckpointV2 }
  | { readonly kind: 'unknownVersion' }
  | { readonly kind: 'invalidPayload' }

export interface HandStartCheckpointVersionRegistry {
  read(
    rowPayloadVersion: unknown,
    payload: unknown,
  ): HandStartCheckpointVersionReadResult
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function identityKey(identity: HandStartCheckpointVersionIdentity): string {
  return `${identity.rowPayloadVersion}:${identity.envelopeSchemaVersion}`
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const nestedValue of Object.values(value)) deepFreeze(nestedValue)
    Object.freeze(value)
  }
  return value
}

export function createHandStartCheckpointVersionRegistry(
  registrations: readonly HandStartCheckpointVersionRegistration[],
): HandStartCheckpointVersionRegistry {
  const byIdentity = new Map<string, HandStartCheckpointVersionRegistration>()
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
    ): HandStartCheckpointVersionReadResult {
      if (
        !isPositiveSafeInteger(rowPayloadVersion) ||
        !isRecord(payload) ||
        !isPositiveSafeInteger(payload.checkpointSchemaVersion)
      ) {
        return { kind: 'invalidPayload' }
      }
      const registration = byIdentity.get(
        identityKey({
          rowPayloadVersion,
          envelopeSchemaVersion: payload.checkpointSchemaVersion,
        }),
      )
      if (registration === undefined) return { kind: 'unknownVersion' }
      try {
        const row = { payloadVersion: rowPayloadVersion, payload }
        const value =
          registration.kind === 'current'
            ? registration.decode(row)
            : createHandStartCheckpointV2(
                registration.migrate(registration.decode(row)),
              )
        return deepFreeze({ kind: 'decoded', value })
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

export const productionHandStartCheckpointVersionRegistry =
  createHandStartCheckpointVersionRegistry([
    {
      kind: 'current',
      identity: {
        rowPayloadVersion: HAND_START_CHECKPOINT_V2_PAYLOAD_VERSION,
        envelopeSchemaVersion: CHECKPOINT_V2_SCHEMA_VERSION,
      },
      decode: (input) =>
        decodeCurrentHandStartCheckpointV2(input).payload.checkpoint,
    },
    {
      kind: 'legacy',
      identity: {
        rowPayloadVersion: HAND_START_CHECKPOINT_PAYLOAD_VERSION,
        envelopeSchemaVersion: CHECKPOINT_SCHEMA_VERSION,
      },
      decode: (input) =>
        decodeCurrentHandStartCheckpointV1(input).payload.checkpoint,
      migrate: (checkpoint) => ({
        pokerRuleSetVersion: POKER_RULE_SET_VERSION_V1,
        ...(checkpoint as HandStartCheckpointV1),
      }),
    },
  ])
