import { z } from 'zod'
import {
  readCurrentPersistedJson,
  type PersistedJsonReadResult,
} from '../../persisted-json.js'
import {
  DecisionAuditSnapshotV1Schema,
  PlayerCandidateSetSnapshotV1Schema,
  type DecisionAuditSnapshotV1Data,
  type PlayerCandidateSetSnapshotV1,
} from './player-decision-audit.js'
import {
  PlayerBoundedChoiceSchema,
  PlayerValidatorResultV1Schema,
  type PlayerBoundedChoiceV1,
  type PlayerValidatorResultV1,
} from './player-bounded-choice.js'
import {
  PlayerModelProjectionV1Schema,
  type PlayerModelProjectionV1,
} from './player-model-projection.js'

export const PLAYER_DECISION_PAYLOAD_VERSION = 1 as const

export class PlayerDecisionPayloadValidationError extends Error {
  public constructor() {
    super('Player Decision 持久化载荷无效。')
    this.name = 'PlayerDecisionPayloadValidationError'
  }
}

export class PlayerDecisionPayloadVersionError extends Error {
  public constructor() {
    super('Player Decision 持久化载荷版本无效。')
    this.name = 'PlayerDecisionPayloadVersionError'
  }
}

export interface StoredPlayerDecisionPayload<TPayload> {
  readonly payloadVersion: typeof PLAYER_DECISION_PAYLOAD_VERSION
  readonly payload: TPayload
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

function encode<T>(
  schema: z.ZodType<T>,
  value: unknown,
): StoredPlayerDecisionPayload<T> {
  try {
    return deepFreeze({
      payloadVersion: PLAYER_DECISION_PAYLOAD_VERSION,
      payload: schema.parse(value),
    })
  } catch {
    throw new PlayerDecisionPayloadValidationError()
  }
}

function decode<T>(
  schema: z.ZodType<T>,
  stored: { readonly payloadVersion: number; readonly payload: unknown },
): T {
  if (stored.payloadVersion !== PLAYER_DECISION_PAYLOAD_VERSION) {
    throw new PlayerDecisionPayloadVersionError()
  }
  try {
    return deepFreeze(schema.parse(stored.payload))
  } catch {
    throw new PlayerDecisionPayloadValidationError()
  }
}

function read<T>(input: {
  readonly rowPayloadVersion: number | null
  readonly payload: unknown
  readonly schema: z.ZodType<T>
}): PersistedJsonReadResult<T> {
  return readCurrentPersistedJson({
    rowPayloadVersion: input.rowPayloadVersion,
    payload: input.payload,
    currentRowPayloadVersion: PLAYER_DECISION_PAYLOAD_VERSION,
    decode: (stored) => decode(input.schema, stored),
    isPayloadValidationError: (error) =>
      error instanceof PlayerDecisionPayloadValidationError ||
      error instanceof PlayerDecisionPayloadVersionError,
  })
}

export const playerDecisionAuditSnapshotCodec = Object.freeze({
  encode: (value: unknown) => encode(DecisionAuditSnapshotV1Schema, value),
  decode: (stored: {
    readonly payloadVersion: number
    readonly payload: unknown
  }) => decode(DecisionAuditSnapshotV1Schema, stored),
  read: (rowPayloadVersion: number | null, payload: unknown) =>
    read({
      rowPayloadVersion,
      payload,
      schema: DecisionAuditSnapshotV1Schema,
    }),
}) satisfies {
  readonly encode: (
    value: unknown,
  ) => StoredPlayerDecisionPayload<DecisionAuditSnapshotV1Data>
  readonly decode: (stored: {
    readonly payloadVersion: number
    readonly payload: unknown
  }) => DecisionAuditSnapshotV1Data
  readonly read: (
    rowPayloadVersion: number | null,
    payload: unknown,
  ) => PersistedJsonReadResult<DecisionAuditSnapshotV1Data>
}

export const playerCandidateSetSnapshotCodec = Object.freeze({
  encode: (value: unknown) => encode(PlayerCandidateSetSnapshotV1Schema, value),
  decode: (stored: {
    readonly payloadVersion: number
    readonly payload: unknown
  }) => decode(PlayerCandidateSetSnapshotV1Schema, stored),
  read: (rowPayloadVersion: number | null, payload: unknown) =>
    read({
      rowPayloadVersion,
      payload,
      schema: PlayerCandidateSetSnapshotV1Schema,
    }),
}) satisfies {
  readonly encode: (
    value: unknown,
  ) => StoredPlayerDecisionPayload<PlayerCandidateSetSnapshotV1>
  readonly decode: (stored: {
    readonly payloadVersion: number
    readonly payload: unknown
  }) => PlayerCandidateSetSnapshotV1
  readonly read: (
    rowPayloadVersion: number | null,
    payload: unknown,
  ) => PersistedJsonReadResult<PlayerCandidateSetSnapshotV1>
}

export const playerModelProjectionCodec = Object.freeze({
  encode: (value: unknown) => encode(PlayerModelProjectionV1Schema, value),
  decode: (stored: {
    readonly payloadVersion: number
    readonly payload: unknown
  }) => decode(PlayerModelProjectionV1Schema, stored),
  read: (rowPayloadVersion: number | null, payload: unknown) =>
    read({ rowPayloadVersion, payload, schema: PlayerModelProjectionV1Schema }),
}) satisfies {
  readonly encode: (
    value: unknown,
  ) => StoredPlayerDecisionPayload<PlayerModelProjectionV1>
  readonly decode: (stored: {
    readonly payloadVersion: number
    readonly payload: unknown
  }) => PlayerModelProjectionV1
  readonly read: (
    rowPayloadVersion: number | null,
    payload: unknown,
  ) => PersistedJsonReadResult<PlayerModelProjectionV1>
}

export const playerModelChoiceCodec = Object.freeze({
  encode: (value: unknown) => encode(PlayerBoundedChoiceSchema, value),
  decode: (stored: {
    readonly payloadVersion: number
    readonly payload: unknown
  }) => decode(PlayerBoundedChoiceSchema, stored),
  read: (rowPayloadVersion: number | null, payload: unknown) =>
    read({ rowPayloadVersion, payload, schema: PlayerBoundedChoiceSchema }),
}) satisfies {
  readonly encode: (
    value: unknown,
  ) => StoredPlayerDecisionPayload<PlayerBoundedChoiceV1>
  readonly decode: (stored: {
    readonly payloadVersion: number
    readonly payload: unknown
  }) => PlayerBoundedChoiceV1
  readonly read: (
    rowPayloadVersion: number | null,
    payload: unknown,
  ) => PersistedJsonReadResult<PlayerBoundedChoiceV1>
}

export const playerValidatorResultCodec = Object.freeze({
  encode: (value: unknown) => encode(PlayerValidatorResultV1Schema, value),
  decode: (stored: {
    readonly payloadVersion: number
    readonly payload: unknown
  }) => decode(PlayerValidatorResultV1Schema, stored),
  read: (rowPayloadVersion: number | null, payload: unknown) =>
    read({ rowPayloadVersion, payload, schema: PlayerValidatorResultV1Schema }),
}) satisfies {
  readonly encode: (
    value: unknown,
  ) => StoredPlayerDecisionPayload<PlayerValidatorResultV1>
  readonly decode: (stored: {
    readonly payloadVersion: number
    readonly payload: unknown
  }) => PlayerValidatorResultV1
  readonly read: (
    rowPayloadVersion: number | null,
    payload: unknown,
  ) => PersistedJsonReadResult<PlayerValidatorResultV1>
}
