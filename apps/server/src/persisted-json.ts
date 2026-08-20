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

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftCodePoints = Array.from(left, (value) => value.codePointAt(0) ?? 0)
  const rightCodePoints = Array.from(
    right,
    (value) => value.codePointAt(0) ?? 0,
  )
  const length = Math.min(leftCodePoints.length, rightCodePoints.length)
  for (let index = 0; index < length; index += 1) {
    const difference =
      (leftCodePoints[index] ?? 0) - (rightCodePoints[index] ?? 0)
    if (difference !== 0) return difference
  }
  return leftCodePoints.length - rightCodePoints.length
}

export function canonicalJson(value: JsonValue): string {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('规范 JSON 不接受非有限数字。')
    }
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`
  }
  if (typeof value !== 'object') {
    throw new TypeError('规范 JSON 只接受 JSON 值。')
  }
  const objectValue = value as { readonly [key: string]: JsonValue }
  const entries = Object.keys(objectValue)
    .sort(compareUnicodeCodePoints)
    .map((key) => {
      const entry = objectValue[key]
      if (entry === undefined) {
        throw new TypeError('规范 JSON 不接受 undefined。')
      }
      return `${JSON.stringify(key)}:${canonicalJson(entry)}`
    })
  return `{${entries.join(',')}}`
}

function isPositiveSafeInteger(value: unknown): value is number {
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
