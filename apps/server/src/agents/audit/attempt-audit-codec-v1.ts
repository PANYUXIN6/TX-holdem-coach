import { z } from 'zod'
import {
  NonnegativeSafeIntegerSchema,
  PositiveSafeIntegerSchema,
  Sha256DigestSchema,
} from './audit-primitives.js'
import {
  AgentAuditPayloadValidationError,
  AgentAuditPayloadVersionError,
} from './errors.js'

export const ATTEMPT_AUDIT_PAYLOAD_VERSION = 1 as const
export const ATTEMPT_AUDIT_SCHEMA_VERSION = 1 as const

export const AttemptAuditLifecycleSchema = z.enum([
  'started',
  'completed',
  'failed',
  'cancelled',
  'stale',
])
export type AttemptAuditLifecycle = z.infer<typeof AttemptAuditLifecycleSchema>

export const AttemptValidationStatusSchema = z.enum([
  'notRun',
  'valid',
  'invalid',
])
export type AttemptValidationStatus = z.infer<
  typeof AttemptValidationStatusSchema
>

const AttemptStartFactsSchema = z.strictObject({
  actualTimeoutMs: PositiveSafeIntegerSchema,
  remainingDeadlineMsAtStart: NonnegativeSafeIntegerSchema,
  requestProjectionHash: Sha256DigestSchema,
})

const StartedAttemptAuditV1Schema = AttemptStartFactsSchema.extend({
  lifecycle: z.literal('started'),
})
const CompletedAttemptAuditV1Schema = AttemptStartFactsSchema.extend({
  lifecycle: z.literal('completed'),
  responseProjectionHash: Sha256DigestSchema,
  validationStatus: z.enum(['valid', 'invalid']),
})
const FailedAttemptAuditV1Schema = AttemptStartFactsSchema.extend({
  lifecycle: z.literal('failed'),
  responseProjectionHash: Sha256DigestSchema.nullable(),
  validationStatus: z.enum(['notRun', 'invalid']),
})
const CancelledAttemptAuditV1Schema = AttemptStartFactsSchema.extend({
  lifecycle: z.literal('cancelled'),
  responseProjectionHash: z.null(),
  validationStatus: z.literal('notRun'),
})
const StaleAttemptAuditV1Schema = AttemptStartFactsSchema.extend({
  lifecycle: z.literal('stale'),
  responseProjectionHash: Sha256DigestSchema.nullable(),
  validationStatus: AttemptValidationStatusSchema,
})

const AttemptAuditV1Schema = z.discriminatedUnion('lifecycle', [
  StartedAttemptAuditV1Schema,
  CompletedAttemptAuditV1Schema,
  FailedAttemptAuditV1Schema,
  CancelledAttemptAuditV1Schema,
  StaleAttemptAuditV1Schema,
])

export type AttemptAuditV1 = Readonly<z.infer<typeof AttemptAuditV1Schema>>

const StartedAttemptPayloadV1Schema = AttemptStartFactsSchema.extend({
  attemptAuditSchemaVersion: z.literal(ATTEMPT_AUDIT_SCHEMA_VERSION),
})
const CompletedAttemptPayloadV1Schema = StartedAttemptPayloadV1Schema.extend({
  responseProjectionHash: Sha256DigestSchema,
  validationStatus: z.enum(['valid', 'invalid']),
})
const FailedAttemptPayloadV1Schema = StartedAttemptPayloadV1Schema.extend({
  responseProjectionHash: Sha256DigestSchema.nullable(),
  validationStatus: z.enum(['notRun', 'invalid']),
})
const CancelledAttemptPayloadV1Schema = StartedAttemptPayloadV1Schema.extend({
  responseProjectionHash: z.null(),
  validationStatus: z.literal('notRun'),
})
const StaleAttemptPayloadV1Schema = StartedAttemptPayloadV1Schema.extend({
  responseProjectionHash: Sha256DigestSchema.nullable(),
  validationStatus: AttemptValidationStatusSchema,
})

const StoredAttemptAuditV1Schema = z.discriminatedUnion('lifecycle', [
  z.strictObject({
    lifecycle: z.literal('started'),
    payloadVersion: z.literal(ATTEMPT_AUDIT_PAYLOAD_VERSION),
    payload: StartedAttemptPayloadV1Schema,
  }),
  z.strictObject({
    lifecycle: z.literal('completed'),
    payloadVersion: z.literal(ATTEMPT_AUDIT_PAYLOAD_VERSION),
    payload: CompletedAttemptPayloadV1Schema,
  }),
  z.strictObject({
    lifecycle: z.literal('failed'),
    payloadVersion: z.literal(ATTEMPT_AUDIT_PAYLOAD_VERSION),
    payload: FailedAttemptPayloadV1Schema,
  }),
  z.strictObject({
    lifecycle: z.literal('cancelled'),
    payloadVersion: z.literal(ATTEMPT_AUDIT_PAYLOAD_VERSION),
    payload: CancelledAttemptPayloadV1Schema,
  }),
  z.strictObject({
    lifecycle: z.literal('stale'),
    payloadVersion: z.literal(ATTEMPT_AUDIT_PAYLOAD_VERSION),
    payload: StaleAttemptPayloadV1Schema,
  }),
])

export type StoredAttemptAuditV1 = Readonly<
  z.infer<typeof StoredAttemptAuditV1Schema>
>

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

function decodedAttempt(stored: StoredAttemptAuditV1): AttemptAuditV1 {
  const { attemptAuditSchemaVersion: _schemaVersion, ...facts } = stored.payload
  return deepFreeze({ lifecycle: stored.lifecycle, ...facts }) as AttemptAuditV1
}

export function decodeCurrentAttemptAuditV1(
  input: unknown,
): StoredAttemptAuditV1 {
  if (!isRecord(input)) throw new AgentAuditPayloadValidationError()
  const rowVersion = PositiveSafeIntegerSchema.safeParse(input.payloadVersion)
  if (!rowVersion.success) throw new AgentAuditPayloadValidationError()
  if (rowVersion.data !== ATTEMPT_AUDIT_PAYLOAD_VERSION) {
    throw new AgentAuditPayloadVersionError('attemptAuditRowVersion')
  }
  if (!isRecord(input.payload)) throw new AgentAuditPayloadValidationError()
  const envelopeVersion = PositiveSafeIntegerSchema.safeParse(
    input.payload.attemptAuditSchemaVersion,
  )
  if (!envelopeVersion.success) throw new AgentAuditPayloadValidationError()
  if (envelopeVersion.data !== ATTEMPT_AUDIT_SCHEMA_VERSION) {
    throw new AgentAuditPayloadVersionError('attemptAuditEnvelopeVersion')
  }

  const parsed = StoredAttemptAuditV1Schema.safeParse(input)
  if (!parsed.success) throw new AgentAuditPayloadValidationError()
  return deepFreeze(parsed.data)
}

export function encodeAttemptAuditV1(input: unknown): StoredAttemptAuditV1 {
  const attempt = AttemptAuditV1Schema.safeParse(input)
  if (!attempt.success) throw new AgentAuditPayloadValidationError()
  const { lifecycle, ...facts } = attempt.data
  return decodeCurrentAttemptAuditV1({
    lifecycle,
    payloadVersion: ATTEMPT_AUDIT_PAYLOAD_VERSION,
    payload: {
      attemptAuditSchemaVersion: ATTEMPT_AUDIT_SCHEMA_VERSION,
      ...facts,
    },
  })
}

export function readAttemptAuditV1(stored: unknown): AttemptAuditV1 {
  return decodedAttempt(decodeCurrentAttemptAuditV1(stored))
}
