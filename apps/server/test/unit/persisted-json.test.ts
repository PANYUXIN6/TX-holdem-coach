import { describe, expect, test } from 'vitest'
import { readCurrentPersistedJson } from '../../src/persisted-json.js'

class PayloadValidationError extends Error {}

function read(rowPayloadVersion: unknown, payload: unknown) {
  return readCurrentPersistedJson({
    rowPayloadVersion,
    payload,
    currentRowPayloadVersion: 2,
    decode(stored) {
      const value = stored.payload
      if (
        value === null ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        !('name' in value) ||
        typeof value.name !== 'string'
      ) {
        throw new PayloadValidationError()
      }
      return value.name
    },
    isPayloadValidationError: (error) =>
      error instanceof PayloadValidationError,
  })
}

describe('current persisted JSON reader', () => {
  test('decodes the only supported row payload version', () => {
    expect(read(2, { name: 'current' })).toEqual({
      kind: 'decoded',
      value: 'current',
    })
  })

  test('classifies positive unsupported versions uniformly', () => {
    expect(read(1, { name: 'legacy' })).toEqual({ kind: 'unknownVersion' })
    expect(read(3, null)).toEqual({ kind: 'unknownVersion' })
  })

  test('classifies malformed versions and payloads as corruption', () => {
    for (const version of ['2', null, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(read(version, { name: 'current' })).toEqual({
        kind: 'invalidPayload',
      })
    }
    expect(read(2, {})).toEqual({ kind: 'invalidPayload' })
  })

  test('does not hide unexpected decoder failures', () => {
    expect(() =>
      readCurrentPersistedJson({
        rowPayloadVersion: 1,
        payload: {},
        currentRowPayloadVersion: 1,
        decode() {
          throw new Error('unexpected')
        },
        isPayloadValidationError: () => false,
      }),
    ).toThrow('unexpected')
  })
})
