export type PersistedJsonReadResult<Value> =
  | { readonly kind: 'decoded'; readonly value: Value }
  | { readonly kind: 'unknownVersion' }
  | { readonly kind: 'invalidPayload' }

export interface PersistedJsonReader<Value> {
  read(
    rowPayloadVersion: unknown,
    payload: unknown,
  ): PersistedJsonReadResult<Value>
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function readCurrentPersistedJson<Value>(input: {
  readonly rowPayloadVersion: unknown
  readonly payload: unknown
  readonly currentRowPayloadVersion: number
  readonly decode: (stored: {
    readonly payloadVersion: number
    readonly payload: unknown
  }) => Value
  readonly isPayloadValidationError: (error: unknown) => boolean
}): PersistedJsonReadResult<Value> {
  if (!isPositiveSafeInteger(input.rowPayloadVersion)) {
    return { kind: 'invalidPayload' }
  }
  if (input.rowPayloadVersion !== input.currentRowPayloadVersion) {
    return { kind: 'unknownVersion' }
  }
  try {
    return {
      kind: 'decoded',
      value: input.decode({
        payloadVersion: input.rowPayloadVersion,
        payload: input.payload,
      }),
    }
  } catch (error) {
    if (input.isPayloadValidationError(error)) {
      return { kind: 'invalidPayload' }
    }
    throw error
  }
}
