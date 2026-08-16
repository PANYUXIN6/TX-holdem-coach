import { z } from 'zod'
import {
  readCurrentPersistedJson,
  type PersistedJsonReader,
} from '../../persisted-json.js'
import {
  AuditVersionReferenceSchema,
  PositiveSafeIntegerSchema,
} from './audit-primitives.js'
import {
  AgentAuditPayloadValidationError,
  AgentAuditPayloadVersionError,
} from './errors.js'

export const RUN_CONFIGURATION_AUDIT_PAYLOAD_VERSION = 1 as const

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

const RunConfigurationAuditSchema = z.strictObject({
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

export type RunConfigurationAudit = Readonly<
  z.infer<typeof RunConfigurationAuditSchema>
>

export interface StoredRunConfigurationAudit {
  readonly payloadVersion: typeof RUN_CONFIGURATION_AUDIT_PAYLOAD_VERSION
  readonly payload: {
    readonly configuration: RunConfigurationAudit
  }
}

const StoredRunConfigurationAuditSchema = z.strictObject({
  payloadVersion: z.literal(RUN_CONFIGURATION_AUDIT_PAYLOAD_VERSION),
  payload: z.strictObject({
    configuration: RunConfigurationAuditSchema,
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

export function decodeCurrentRunConfigurationAudit(
  input: unknown,
): StoredRunConfigurationAudit {
  if (!isRecord(input)) throw new AgentAuditPayloadValidationError()
  const rowVersion = PositiveSafeIntegerSchema.safeParse(input.payloadVersion)
  if (!rowVersion.success) throw new AgentAuditPayloadValidationError()
  if (rowVersion.data !== RUN_CONFIGURATION_AUDIT_PAYLOAD_VERSION) {
    throw new AgentAuditPayloadVersionError('runConfigurationRowVersion')
  }
  if (!isRecord(input.payload)) throw new AgentAuditPayloadValidationError()

  const parsed = StoredRunConfigurationAuditSchema.safeParse(input)
  if (!parsed.success) throw new AgentAuditPayloadValidationError()
  return deepFreeze(parsed.data)
}

export function encodeRunConfigurationAudit(
  input: unknown,
): StoredRunConfigurationAudit {
  const configuration = RunConfigurationAuditSchema.safeParse(input)
  if (!configuration.success) throw new AgentAuditPayloadValidationError()
  return decodeCurrentRunConfigurationAudit({
    payloadVersion: RUN_CONFIGURATION_AUDIT_PAYLOAD_VERSION,
    payload: {
      configuration: configuration.data,
    },
  })
}

export const currentRunConfigurationAuditReader: PersistedJsonReader<RunConfigurationAudit> =
  Object.freeze({
    read(rowPayloadVersion: unknown, payload: unknown) {
      return readCurrentPersistedJson({
        rowPayloadVersion,
        payload,
        currentRowPayloadVersion: RUN_CONFIGURATION_AUDIT_PAYLOAD_VERSION,
        decode: (stored) =>
          decodeCurrentRunConfigurationAudit(stored).payload.configuration,
        isPayloadValidationError: (error) =>
          error instanceof AgentAuditPayloadValidationError,
      })
    },
  })
