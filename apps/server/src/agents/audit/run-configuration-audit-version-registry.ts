import { ZodError } from 'zod'
import {
  AgentAuditPayloadValidationError,
  AgentAuditVersionRegistryConfigurationError,
} from './errors.js'
import {
  decodeCurrentRunConfigurationAuditV1,
  encodeRunConfigurationAuditV1,
  RUN_CONFIGURATION_AUDIT_PAYLOAD_VERSION,
  RUN_CONFIGURATION_AUDIT_SCHEMA_VERSION,
  type RunConfigurationAuditV1,
} from './run-configuration-audit-codec-v1.js'

export interface RunConfigurationAuditVersionIdentity {
  readonly rowPayloadVersion: number
  readonly envelopeSchemaVersion: number
}

export type RunConfigurationAuditVersionRegistration =
  | {
      readonly kind: 'current'
      readonly identity: RunConfigurationAuditVersionIdentity
      readonly decode: (input: unknown) => RunConfigurationAuditV1
    }
  | {
      readonly kind: 'legacy'
      readonly identity: RunConfigurationAuditVersionIdentity
      readonly decode: (input: unknown) => unknown
      readonly migrate: (decoded: unknown) => unknown
    }

export type RunConfigurationAuditVersionReadResult =
  | { readonly kind: 'decoded'; readonly value: RunConfigurationAuditV1 }
  | { readonly kind: 'unknownVersion' }
  | { readonly kind: 'invalidPayload' }

export interface RunConfigurationAuditVersionRegistry {
  read(
    rowPayloadVersion: unknown,
    payload: unknown,
  ): RunConfigurationAuditVersionReadResult
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function identityKey(identity: RunConfigurationAuditVersionIdentity): string {
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

export function createRunConfigurationAuditVersionRegistry(
  registrations: readonly RunConfigurationAuditVersionRegistration[],
): RunConfigurationAuditVersionRegistry {
  const byIdentity = new Map<string, RunConfigurationAuditVersionRegistration>()
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
      rowPayloadVersion: unknown,
      payload: unknown,
    ): RunConfigurationAuditVersionReadResult {
      if (
        !isPositiveSafeInteger(rowPayloadVersion) ||
        !isRecord(payload) ||
        !isPositiveSafeInteger(payload.runConfigurationAuditSchemaVersion)
      ) {
        return { kind: 'invalidPayload' }
      }
      const registration = byIdentity.get(
        identityKey({
          rowPayloadVersion,
          envelopeSchemaVersion: payload.runConfigurationAuditSchemaVersion,
        }),
      )
      if (registration === undefined) return { kind: 'unknownVersion' }
      try {
        const row = { payloadVersion: rowPayloadVersion, payload }
        const value =
          registration.kind === 'current'
            ? registration.decode(row)
            : encodeRunConfigurationAuditV1(
                registration.migrate(registration.decode(row)),
              ).payload.configuration
        return deepFreeze({ kind: 'decoded', value })
      } catch (error) {
        if (isPayloadValidationError(error)) return { kind: 'invalidPayload' }
        throw error
      }
    },
  })
}

export const productionRunConfigurationAuditVersionRegistry =
  createRunConfigurationAuditVersionRegistry([
    {
      kind: 'current',
      identity: {
        rowPayloadVersion: RUN_CONFIGURATION_AUDIT_PAYLOAD_VERSION,
        envelopeSchemaVersion: RUN_CONFIGURATION_AUDIT_SCHEMA_VERSION,
      },
      decode: (input) =>
        decodeCurrentRunConfigurationAuditV1(input).payload.configuration,
    },
  ])
