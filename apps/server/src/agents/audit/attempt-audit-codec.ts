import { z } from 'zod'
import { readCurrentPersistedJson } from '../../persisted-json.js'
import type { PersistedJsonReadResult } from '../../persisted-json.js'
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

const AttemptAuditLifecycleSchema = z.enum([
  'started',
  'completed',
  'failed',
  'cancelled',
  'stale',
])
const AttemptValidationStatusSchema = z.enum(['notRun', 'valid', 'invalid'])
const AttemptStartFactsSchema = z.strictObject({
  actualTimeoutMs: PositiveSafeIntegerSchema,
  remainingDeadlineMsAtStart: NonnegativeSafeIntegerSchema,
  requestProjectionHash: Sha256DigestSchema,
  reservedInputTokens: NonnegativeSafeIntegerSchema,
  reservedOutputTokens: NonnegativeSafeIntegerSchema,
  reservedCostMicrounits: NonnegativeSafeIntegerSchema,
})

const StartedAttemptAuditSchema = AttemptStartFactsSchema.extend({
  lifecycle: z.literal('started'),
  usageAccounting: z.literal('pending'),
  costAccounting: z.literal('pending'),
})
const CompletedAttemptAuditSchema = AttemptStartFactsSchema.extend({
  lifecycle: z.literal('completed'),
  responseProjectionHash: Sha256DigestSchema,
  validationStatus: z.enum(['valid', 'invalid']),
  usageAccounting: z.literal('providerReported'),
  costAccounting: z.enum(['providerReportedSplit', 'allInputAtCacheMiss']),
})
const FailedAttemptAuditSchema = AttemptStartFactsSchema.extend({
  lifecycle: z.literal('failed'),
  responseProjectionHash: Sha256DigestSchema.nullable(),
  validationStatus: z.enum(['notRun', 'invalid']),
  usageAccounting: z.enum([
    'providerReported',
    'reservedUpperBound',
    'notIncurred',
  ]),
  costAccounting: z.enum([
    'providerReportedSplit',
    'allInputAtCacheMiss',
    'reservedUpperBound',
    'notIncurred',
  ]),
})
const CancelledAttemptAuditSchema = AttemptStartFactsSchema.extend({
  lifecycle: z.literal('cancelled'),
  responseProjectionHash: z.null(),
  validationStatus: z.literal('notRun'),
  usageAccounting: z.enum(['reservedUpperBound', 'notIncurred']),
  costAccounting: z.enum(['reservedUpperBound', 'notIncurred']),
})
const StaleAttemptAuditSchema = AttemptStartFactsSchema.extend({
  lifecycle: z.literal('stale'),
  responseProjectionHash: Sha256DigestSchema.nullable(),
  validationStatus: AttemptValidationStatusSchema,
  usageAccounting: z.enum(['providerReported', 'reservedUpperBound']),
  costAccounting: z.enum([
    'providerReportedSplit',
    'allInputAtCacheMiss',
    'reservedUpperBound',
  ]),
})

const AttemptAuditSchema = z.discriminatedUnion('lifecycle', [
  StartedAttemptAuditSchema,
  CompletedAttemptAuditSchema,
  FailedAttemptAuditSchema,
  CancelledAttemptAuditSchema,
  StaleAttemptAuditSchema,
])

export type AttemptAudit = Readonly<z.infer<typeof AttemptAuditSchema>>

const StartedAttemptPayloadSchema = AttemptStartFactsSchema.extend({
  usageAccounting: z.literal('pending'),
  costAccounting: z.literal('pending'),
})
const CompletedAttemptPayloadSchema = StartedAttemptPayloadSchema.extend({
  responseProjectionHash: Sha256DigestSchema,
  validationStatus: z.enum(['valid', 'invalid']),
  usageAccounting: z.literal('providerReported'),
  costAccounting: z.enum(['providerReportedSplit', 'allInputAtCacheMiss']),
})
const FailedAttemptPayloadSchema = StartedAttemptPayloadSchema.extend({
  responseProjectionHash: Sha256DigestSchema.nullable(),
  validationStatus: z.enum(['notRun', 'invalid']),
  usageAccounting: z.enum([
    'providerReported',
    'reservedUpperBound',
    'notIncurred',
  ]),
  costAccounting: z.enum([
    'providerReportedSplit',
    'allInputAtCacheMiss',
    'reservedUpperBound',
    'notIncurred',
  ]),
})
const CancelledAttemptPayloadSchema = StartedAttemptPayloadSchema.extend({
  responseProjectionHash: z.null(),
  validationStatus: z.literal('notRun'),
  usageAccounting: z.enum(['reservedUpperBound', 'notIncurred']),
  costAccounting: z.enum(['reservedUpperBound', 'notIncurred']),
})
const StaleAttemptPayloadSchema = StartedAttemptPayloadSchema.extend({
  responseProjectionHash: Sha256DigestSchema.nullable(),
  validationStatus: AttemptValidationStatusSchema,
  usageAccounting: z.enum(['providerReported', 'reservedUpperBound']),
  costAccounting: z.enum([
    'providerReportedSplit',
    'allInputAtCacheMiss',
    'reservedUpperBound',
  ]),
})

const StoredAttemptAuditSchema = z.discriminatedUnion('lifecycle', [
  z.strictObject({
    lifecycle: z.literal('started'),
    payloadVersion: z.literal(ATTEMPT_AUDIT_PAYLOAD_VERSION),
    payload: StartedAttemptPayloadSchema,
  }),
  z.strictObject({
    lifecycle: z.literal('completed'),
    payloadVersion: z.literal(ATTEMPT_AUDIT_PAYLOAD_VERSION),
    payload: CompletedAttemptPayloadSchema,
  }),
  z.strictObject({
    lifecycle: z.literal('failed'),
    payloadVersion: z.literal(ATTEMPT_AUDIT_PAYLOAD_VERSION),
    payload: FailedAttemptPayloadSchema,
  }),
  z.strictObject({
    lifecycle: z.literal('cancelled'),
    payloadVersion: z.literal(ATTEMPT_AUDIT_PAYLOAD_VERSION),
    payload: CancelledAttemptPayloadSchema,
  }),
  z.strictObject({
    lifecycle: z.literal('stale'),
    payloadVersion: z.literal(ATTEMPT_AUDIT_PAYLOAD_VERSION),
    payload: StaleAttemptPayloadSchema,
  }),
])

export type StoredAttemptAudit = Readonly<
  z.infer<typeof StoredAttemptAuditSchema>
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

function decodedAttempt(stored: StoredAttemptAudit): AttemptAudit {
  return deepFreeze({
    lifecycle: stored.lifecycle,
    ...stored.payload,
  }) as AttemptAudit
}

export function decodeCurrentAttemptAudit(input: unknown): StoredAttemptAudit {
  if (!isRecord(input)) throw new AgentAuditPayloadValidationError()
  const rowVersion = PositiveSafeIntegerSchema.safeParse(input.payloadVersion)
  if (!rowVersion.success) throw new AgentAuditPayloadValidationError()
  if (rowVersion.data !== ATTEMPT_AUDIT_PAYLOAD_VERSION) {
    throw new AgentAuditPayloadVersionError('attemptAuditRowVersion')
  }
  if (!isRecord(input.payload)) throw new AgentAuditPayloadValidationError()

  const parsed = StoredAttemptAuditSchema.safeParse(input)
  if (!parsed.success) throw new AgentAuditPayloadValidationError()
  return deepFreeze(parsed.data)
}

export function encodeAttemptAudit(input: unknown): StoredAttemptAudit {
  const attempt = AttemptAuditSchema.safeParse(input)
  if (!attempt.success) throw new AgentAuditPayloadValidationError()
  const { lifecycle, ...facts } = attempt.data
  return decodeCurrentAttemptAudit({
    lifecycle,
    payloadVersion: ATTEMPT_AUDIT_PAYLOAD_VERSION,
    payload: {
      ...facts,
    },
  })
}

function readAttemptAudit(stored: unknown): AttemptAudit {
  return decodedAttempt(decodeCurrentAttemptAudit(stored))
}

export function readCurrentAttemptAudit(
  lifecycle: unknown,
  rowPayloadVersion: unknown,
  payload: unknown,
): PersistedJsonReadResult<AttemptAudit> {
  const parsedLifecycle = AttemptAuditLifecycleSchema.safeParse(lifecycle)
  if (!parsedLifecycle.success) return { kind: 'invalidPayload' }
  return readCurrentPersistedJson({
    rowPayloadVersion,
    payload,
    currentRowPayloadVersion: ATTEMPT_AUDIT_PAYLOAD_VERSION,
    decode: (stored) =>
      readAttemptAudit({ lifecycle: parsedLifecycle.data, ...stored }),
    isPayloadValidationError: (error) =>
      error instanceof AgentAuditPayloadValidationError,
  })
}
