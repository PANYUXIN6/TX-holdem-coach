import { ZodError } from 'zod'
import {
  ATTEMPT_AUDIT_PAYLOAD_VERSION,
  ATTEMPT_AUDIT_SCHEMA_VERSION,
  AttemptAuditLifecycleSchema,
  encodeAttemptAuditV1,
  readAttemptAuditV1,
  type AttemptAuditLifecycle,
  type AttemptAuditV1,
} from './attempt-audit-codec-v1.js'
import {
  AgentAuditPayloadValidationError,
  AgentAuditVersionRegistryConfigurationError,
} from './errors.js'

export interface AttemptAuditVersionIdentity {
  readonly rowPayloadVersion: number
  readonly envelopeSchemaVersion: number
}

export type AttemptAuditVersionRegistration =
  | {
      readonly kind: 'current'
      readonly identity: AttemptAuditVersionIdentity
      readonly decode: (input: unknown) => AttemptAuditV1
    }
  | {
      readonly kind: 'legacy'
      readonly identity: AttemptAuditVersionIdentity
      readonly decode: (input: unknown) => unknown
      readonly migrate: (decoded: unknown) => unknown
    }

export type AttemptAuditVersionReadResult =
  | { readonly kind: 'decoded'; readonly value: AttemptAuditV1 }
  | { readonly kind: 'unknownVersion' }
  | { readonly kind: 'invalidPayload' }

export interface AttemptAuditVersionRegistry {
  read(
    lifecycle: unknown,
    rowPayloadVersion: unknown,
    payload: unknown,
  ): AttemptAuditVersionReadResult
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function identityKey(identity: AttemptAuditVersionIdentity): string {
  return `${identity.rowPayloadVersion}:${identity.envelopeSchemaVersion}`
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const nestedValue of Object.values(value)) deepFreeze(nestedValue)
    Object.freeze(value)
  }
  return value
}

function isPayloadValidationError(error: unknown): boolean {
  return (
    error instanceof AgentAuditPayloadValidationError ||
    error instanceof ZodError
  )
}

export function createAttemptAuditVersionRegistry(
  registrations: readonly AttemptAuditVersionRegistration[],
): AttemptAuditVersionRegistry {
  const byIdentity = new Map<string, AttemptAuditVersionRegistration>()
  for (const registration of registrations) {
    if (
      !isPositiveSafeInteger(registration.identity.rowPayloadVersion) ||
      !isPositiveSafeInteger(registration.identity.envelopeSchemaVersion) ||
      byIdentity.has(identityKey(registration.identity))
    ) {
      throw new AgentAuditVersionRegistryConfigurationError()
    }
    byIdentity.set(identityKey(registration.identity), deepFreeze(registration))
  }

  return deepFreeze({
    read(
      lifecycleInput: unknown,
      rowPayloadVersion: unknown,
      payload: unknown,
    ): AttemptAuditVersionReadResult {
      const lifecycle = AttemptAuditLifecycleSchema.safeParse(lifecycleInput)
      if (
        !lifecycle.success ||
        !isPositiveSafeInteger(rowPayloadVersion) ||
        !isRecord(payload) ||
        !isPositiveSafeInteger(payload.attemptAuditSchemaVersion)
      ) {
        return { kind: 'invalidPayload' }
      }
      const registration = byIdentity.get(
        identityKey({
          rowPayloadVersion,
          envelopeSchemaVersion: payload.attemptAuditSchemaVersion,
        }),
      )
      if (registration === undefined) return { kind: 'unknownVersion' }
      try {
        const row = {
          lifecycle: lifecycle.data,
          payloadVersion: rowPayloadVersion,
          payload,
        }
        const value =
          registration.kind === 'current'
            ? registration.decode(row)
            : migratedAttempt(lifecycle.data, registration, row)
        return deepFreeze({ kind: 'decoded', value })
      } catch (error) {
        if (isPayloadValidationError(error)) return { kind: 'invalidPayload' }
        throw error
      }
    },
  })
}

function migratedAttempt(
  lifecycle: AttemptAuditLifecycle,
  registration: Extract<AttemptAuditVersionRegistration, { kind: 'legacy' }>,
  row: unknown,
): AttemptAuditV1 {
  const encoded = encodeAttemptAuditV1(
    registration.migrate(registration.decode(row)),
  )
  if (encoded.lifecycle !== lifecycle) {
    throw new AgentAuditPayloadValidationError()
  }
  return readAttemptAuditV1(encoded)
}

export const productionAttemptAuditVersionRegistry =
  createAttemptAuditVersionRegistry([
    {
      kind: 'current',
      identity: {
        rowPayloadVersion: ATTEMPT_AUDIT_PAYLOAD_VERSION,
        envelopeSchemaVersion: ATTEMPT_AUDIT_SCHEMA_VERSION,
      },
      decode: readAttemptAuditV1,
    },
  ])
