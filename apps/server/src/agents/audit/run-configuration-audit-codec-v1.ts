import { z } from 'zod'
import {
  AuditVersionReferenceSchema,
  PositiveSafeIntegerSchema,
} from './audit-primitives.js'
import {
  AgentAuditPayloadValidationError,
  AgentAuditPayloadVersionError,
} from './errors.js'

export const RUN_CONFIGURATION_AUDIT_PAYLOAD_VERSION = 1 as const
export const RUN_CONFIGURATION_AUDIT_SCHEMA_VERSION = 1 as const

const UniqueReferencesSchema = z
  .array(AuditVersionReferenceSchema)
  .superRefine((references, context) => {
    if (new Set(references.map(({ id }) => id)).size !== references.length) {
      context.addIssue({
        code: 'custom',
        message: '审计版本引用标识必须唯一。',
      })
    }
  })

const RunConfigurationAuditV1Schema = z.strictObject({
  runtime: z.enum(['player', 'coach']),
  runtimeDefinitionVersion: PositiveSafeIntegerSchema,
  contextSchemaVersion: PositiveSafeIntegerSchema,
  promptModules: UniqueReferencesSchema,
  capabilityManifest: AuditVersionReferenceSchema,
  capabilities: UniqueReferencesSchema,
  routePolicy: AuditVersionReferenceSchema,
  outputSchema: AuditVersionReferenceSchema,
  validator: AuditVersionReferenceSchema,
  commitGate: AuditVersionReferenceSchema,
  recoveryPolicy: AuditVersionReferenceSchema,
  dataDependencies: UniqueReferencesSchema,
})

export type RunConfigurationAuditV1 = Readonly<
  z.infer<typeof RunConfigurationAuditV1Schema>
>

export interface StoredRunConfigurationAuditV1 {
  readonly payloadVersion: typeof RUN_CONFIGURATION_AUDIT_PAYLOAD_VERSION
  readonly payload: {
    readonly runConfigurationAuditSchemaVersion: typeof RUN_CONFIGURATION_AUDIT_SCHEMA_VERSION
    readonly configuration: RunConfigurationAuditV1
  }
}

const StoredRunConfigurationAuditV1Schema = z.strictObject({
  payloadVersion: z.literal(RUN_CONFIGURATION_AUDIT_PAYLOAD_VERSION),
  payload: z.strictObject({
    runConfigurationAuditSchemaVersion: z.literal(
      RUN_CONFIGURATION_AUDIT_SCHEMA_VERSION,
    ),
    configuration: RunConfigurationAuditV1Schema,
  }),
})

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

export function decodeCurrentRunConfigurationAuditV1(
  input: unknown,
): StoredRunConfigurationAuditV1 {
  if (!isRecord(input)) throw new AgentAuditPayloadValidationError()
  const rowVersion = PositiveSafeIntegerSchema.safeParse(input.payloadVersion)
  if (!rowVersion.success) throw new AgentAuditPayloadValidationError()
  if (rowVersion.data !== RUN_CONFIGURATION_AUDIT_PAYLOAD_VERSION) {
    throw new AgentAuditPayloadVersionError('runConfigurationRowVersion')
  }
  if (!isRecord(input.payload)) throw new AgentAuditPayloadValidationError()
  const envelopeVersion = PositiveSafeIntegerSchema.safeParse(
    input.payload.runConfigurationAuditSchemaVersion,
  )
  if (!envelopeVersion.success) throw new AgentAuditPayloadValidationError()
  if (envelopeVersion.data !== RUN_CONFIGURATION_AUDIT_SCHEMA_VERSION) {
    throw new AgentAuditPayloadVersionError('runConfigurationEnvelopeVersion')
  }

  const parsed = StoredRunConfigurationAuditV1Schema.safeParse(input)
  if (!parsed.success) throw new AgentAuditPayloadValidationError()
  return deepFreeze(parsed.data)
}

export function encodeRunConfigurationAuditV1(
  input: unknown,
): StoredRunConfigurationAuditV1 {
  const configuration = RunConfigurationAuditV1Schema.safeParse(input)
  if (!configuration.success) throw new AgentAuditPayloadValidationError()
  return decodeCurrentRunConfigurationAuditV1({
    payloadVersion: RUN_CONFIGURATION_AUDIT_PAYLOAD_VERSION,
    payload: {
      runConfigurationAuditSchemaVersion:
        RUN_CONFIGURATION_AUDIT_SCHEMA_VERSION,
      configuration: configuration.data,
    },
  })
}
