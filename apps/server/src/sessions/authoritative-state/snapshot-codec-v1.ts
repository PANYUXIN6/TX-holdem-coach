import { z } from 'zod'
import {
  createPrivateTableState,
  type PrivateTableState,
} from './private-table-state.js'
import {
  CurrentPayloadValidationError,
  CurrentPayloadVersionError,
} from './errors.js'

export const PRIVATE_TABLE_STATE_PAYLOAD_VERSION = 1 as const
export const SNAPSHOT_SCHEMA_VERSION = 1 as const

export interface StoredTableSnapshotV1 {
  readonly payloadVersion: typeof PRIVATE_TABLE_STATE_PAYLOAD_VERSION
  readonly payload: {
    readonly snapshotSchemaVersion: typeof SNAPSHOT_SCHEMA_VERSION
    readonly state: PrivateTableState
  }
}

const SnapshotInputSchema = z.strictObject({
  payloadVersion: z.literal(PRIVATE_TABLE_STATE_PAYLOAD_VERSION),
  payload: z.strictObject({
    snapshotSchemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION),
    state: z.unknown(),
  }),
})
const PayloadVersionSchema = z.number().int().positive()

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const nestedValue of Object.values(value)) {
      deepFreeze(nestedValue)
    }
    Object.freeze(value)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function decodeCurrentSnapshotV1(input: unknown): StoredTableSnapshotV1 {
  if (!isRecord(input)) {
    throw new CurrentPayloadValidationError()
  }
  const rowVersion = PayloadVersionSchema.safeParse(input.payloadVersion)
  if (!rowVersion.success) {
    throw new CurrentPayloadValidationError()
  }
  if (rowVersion.data !== PRIVATE_TABLE_STATE_PAYLOAD_VERSION) {
    throw new CurrentPayloadVersionError('snapshotRowVersion')
  }
  if (!isRecord(input.payload)) {
    throw new CurrentPayloadValidationError()
  }
  const envelopeVersion = PayloadVersionSchema.safeParse(
    input.payload.snapshotSchemaVersion,
  )
  if (!envelopeVersion.success) {
    throw new CurrentPayloadValidationError()
  }
  if (envelopeVersion.data !== SNAPSHOT_SCHEMA_VERSION) {
    throw new CurrentPayloadVersionError('snapshotEnvelopeVersion')
  }
  try {
    const parsed = SnapshotInputSchema.parse(input)
    return deepFreeze({
      payloadVersion: PRIVATE_TABLE_STATE_PAYLOAD_VERSION,
      payload: {
        snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
        state: createPrivateTableState(parsed.payload.state),
      },
    })
  } catch {
    throw new CurrentPayloadValidationError()
  }
}

export function encodeSnapshotV1(input: unknown): StoredTableSnapshotV1 {
  const state = createPrivateTableState(input)
  return decodeCurrentSnapshotV1({
    payloadVersion: PRIVATE_TABLE_STATE_PAYLOAD_VERSION,
    payload: { snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION, state },
  })
}
