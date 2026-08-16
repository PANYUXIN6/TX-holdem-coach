import { z } from 'zod'
import {
  createPrivateTableState,
  type PrivateTableState,
} from './private-table-state.js'
import {
  CurrentPayloadValidationError,
  CurrentPayloadVersionError,
} from './errors.js'
import {
  readCurrentPersistedJson,
  type PersistedJsonReader,
} from '../../persisted-json.js'

export const PRIVATE_TABLE_STATE_PAYLOAD_VERSION = 1 as const

export interface StoredTableSnapshotV1 {
  readonly payloadVersion: typeof PRIVATE_TABLE_STATE_PAYLOAD_VERSION
  readonly payload: {
    readonly state: PrivateTableState
  }
}

const SnapshotInputSchema = z.strictObject({
  payloadVersion: z.literal(PRIVATE_TABLE_STATE_PAYLOAD_VERSION),
  payload: z.strictObject({
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
  try {
    const parsed = SnapshotInputSchema.parse(input)
    return deepFreeze({
      payloadVersion: PRIVATE_TABLE_STATE_PAYLOAD_VERSION,
      payload: {
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
    payload: { state },
  })
}

export const currentSnapshotReader: PersistedJsonReader<PrivateTableState> =
  Object.freeze({
    read(rowPayloadVersion: unknown, payload: unknown) {
      return readCurrentPersistedJson({
        rowPayloadVersion,
        payload,
        currentRowPayloadVersion: PRIVATE_TABLE_STATE_PAYLOAD_VERSION,
        decode: (stored) => decodeCurrentSnapshotV1(stored).payload.state,
        isPayloadValidationError: (error) =>
          error instanceof CurrentPayloadValidationError,
      })
    },
  })
