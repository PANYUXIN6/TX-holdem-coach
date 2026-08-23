import type { JsonValue } from '../../persisted-json.js'
import type { SensitiveValueScanner } from '../foundation/context-envelope.js'

const FORBIDDEN_KEYS = new Set([
  'authorization',
  'apikey',
  'databaseurl',
  'databaseownerid',
  'leaseowner',
  'fencingtoken',
  'reasoning',
  'reasoningtext',
  'reasoning_content',
])

const CREDENTIAL_PATTERNS = [
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/iu,
  /\bpostgres(?:ql)?:\/\/[^\s]+/iu,
  /\bhttps:\/\/[^\s/@]+:[^\s/@]+@[^\s]+/iu,
]

function assertSafeValue(value: JsonValue, secrets: readonly string[]): void {
  if (typeof value === 'string') {
    if (
      CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value)) ||
      secrets.some((secret) => secret.length > 0 && value.includes(secret))
    ) {
      throw new TypeError('敏感值被拒绝。')
    }
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertSafeValue(entry, secrets)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key.toLocaleLowerCase('en-US'))) {
        throw new TypeError('敏感字段被拒绝。')
      }
      assertSafeValue(entry, secrets)
    }
  }
}

export function createSensitiveValueScanner(
  input: {
    readonly secrets?: readonly string[]
  } = {},
): SensitiveValueScanner {
  const secrets = Object.freeze(
    [...(input.secrets ?? [])].filter((secret) => secret.length >= 8),
  )
  return Object.freeze({
    assertSafe(value: JsonValue | string): void {
      assertSafeValue(value, secrets)
    },
  })
}
