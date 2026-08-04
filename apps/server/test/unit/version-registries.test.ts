import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { createHandStartedEventDraft } from '../../src/poker/hand-result.js'
import {
  createPrivateEventVersionRegistry,
  productionPrivateEventVersionRegistry,
} from '../../src/sessions/authoritative-state/private-event-version-registry.js'
import {
  CurrentPayloadValidationError,
  VersionRegistryConfigurationError,
} from '../../src/sessions/authoritative-state/errors.js'
import { createPrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'
import {
  createSnapshotVersionRegistry,
  productionSnapshotVersionRegistry,
} from '../../src/sessions/authoritative-state/snapshot-version-registry.js'
import { encodePrivateEventV1 } from '../../src/sessions/authoritative-state/private-event-codec-v1.js'
import { encodeSnapshotV1 } from '../../src/sessions/authoritative-state/snapshot-codec-v1.js'
import { createTestPokerState } from '../poker/create-test-poker-state.js'

const handId = '10000000-0000-4000-8000-000000000001'

function currentState() {
  const poker = createTestPokerState()
  return createPrivateTableState({
    stateVersion: 1,
    poker,
    completedHandCount: 0,
    seatAccounting: poker.seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      cumulativeBuyIn: 2_000,
    })),
    lastCompletedHandSummary: null,
  })
}

function currentEvent() {
  return createHandStartedEventDraft({
    handId,
    handNumber: 1,
    participantSeatNumbers: [0, 1, 2, 3, 4, 5],
    buttonSeatNumber: 0,
    smallBlindSeatNumber: 1,
    bigBlindSeatNumber: 2,
    positions: [
      { seatNumber: 0, position: 'BTN' },
      { seatNumber: 1, position: 'SB' },
      { seatNumber: 2, position: 'BB' },
      { seatNumber: 3, position: 'UTG' },
      { seatNumber: 4, position: 'HJ' },
      { seatNumber: 5, position: 'CO' },
    ],
    startingStacks: [0, 1, 2, 3, 4, 5].map((seatNumber) => ({
      seatNumber,
      stack: 2_000,
    })),
  })
}

describe('authoritative-state version registries', () => {
  test('reads the production snapshot and private-event V1 into current domain contracts', () => {
    const snapshot = encodeSnapshotV1(currentState())
    const event = encodePrivateEventV1(currentEvent())

    expect(
      productionSnapshotVersionRegistry.read(
        snapshot.payloadVersion,
        snapshot.payload,
      ),
    ).toEqual({ kind: 'decoded', value: snapshot.payload.state })
    expect(
      productionPrivateEventVersionRegistry.read(
        event.payloadVersion,
        event.payload,
      ),
    ).toEqual({ kind: 'decoded', value: event.payload.event })
  })

  test('uses explicitly injected legacy decoders and deterministic migrations', () => {
    const state = currentState()
    const event = currentEvent()
    const snapshotRegistry = createSnapshotVersionRegistry([
      {
        kind: 'legacy',
        identity: { rowPayloadVersion: 7, envelopeSchemaVersion: 3 },
        decode: (input) => {
          if (
            typeof input !== 'object' ||
            input === null ||
            !('payload' in input)
          ) {
            throw new CurrentPayloadValidationError()
          }
          return (input as { readonly payload: { readonly value: unknown } })
            .payload.value
        },
        migrate: (decoded) => decoded,
      },
    ])
    const eventRegistry = createPrivateEventVersionRegistry([
      {
        kind: 'legacy',
        identity: { rowPayloadVersion: 8, envelopeSchemaVersion: 4 },
        decode: (input) => {
          if (
            typeof input !== 'object' ||
            input === null ||
            !('payload' in input)
          ) {
            throw new CurrentPayloadValidationError()
          }
          return (input as { readonly payload: { readonly value: unknown } })
            .payload.value
        },
        migrate: (decoded) => decoded,
      },
    ])

    const snapshotResult = snapshotRegistry.read(7, {
      snapshotSchemaVersion: 3,
      value: state,
    })
    const secondSnapshotResult = snapshotRegistry.read(7, {
      snapshotSchemaVersion: 3,
      value: state,
    })
    expect(snapshotResult).toEqual({ kind: 'decoded', value: state })
    expect(secondSnapshotResult).toEqual(snapshotResult)
    expect(
      eventRegistry.read(8, { eventSchemaVersion: 4, value: event }),
    ).toEqual({ kind: 'decoded', value: event })
  })

  test('distinguishes malformed identities, unknown composite versions and invalid registered payloads', () => {
    const snapshot = encodeSnapshotV1(currentState())
    const event = encodePrivateEventV1(currentEvent())

    expect(
      productionSnapshotVersionRegistry.read('1', snapshot.payload),
    ).toEqual({ kind: 'invalidPayload' })
    expect(
      productionPrivateEventVersionRegistry.read(1, {
        ...event.payload,
        eventSchemaVersion: 1.5,
      }),
    ).toEqual({ kind: 'invalidPayload' })
    expect(
      productionSnapshotVersionRegistry.read(1, {
        ...snapshot.payload,
        snapshotSchemaVersion: 2,
      }),
    ).toEqual({ kind: 'unknownVersion' })
    expect(
      productionPrivateEventVersionRegistry.read(2, event.payload),
    ).toEqual({ kind: 'unknownVersion' })
    expect(
      productionSnapshotVersionRegistry.read(1, {
        ...snapshot.payload,
        state: {},
      }),
    ).toEqual({ kind: 'invalidPayload' })
    expect(
      productionPrivateEventVersionRegistry.read(1, {
        ...event.payload,
        event: {},
      }),
    ).toEqual({ kind: 'invalidPayload' })
  })

  test('rejects invalid migrated output and duplicate composite registrations', () => {
    const legacySnapshot = {
      kind: 'legacy' as const,
      identity: { rowPayloadVersion: 5, envelopeSchemaVersion: 6 },
      decode: () => ({}),
      migrate: () => ({}),
    }
    const registry = createSnapshotVersionRegistry([legacySnapshot])

    expect(registry.read(5, { snapshotSchemaVersion: 6 })).toEqual({
      kind: 'invalidPayload',
    })
    expect(() =>
      createSnapshotVersionRegistry([legacySnapshot, legacySnapshot]),
    ).toThrow(VersionRegistryConfigurationError)
  })

  test('classifies Zod failures from injected legacy decoders as invalid payloads', () => {
    const snapshotRegistry = createSnapshotVersionRegistry([
      {
        kind: 'legacy',
        identity: { rowPayloadVersion: 7, envelopeSchemaVersion: 3 },
        decode: (input) =>
          z
            .strictObject({
              payloadVersion: z.literal(7),
              payload: z.strictObject({
                snapshotSchemaVersion: z.literal(3),
                value: z.unknown(),
              }),
            })
            .parse(input),
        migrate: () => ({}),
      },
    ])
    const eventRegistry = createPrivateEventVersionRegistry([
      {
        kind: 'legacy',
        identity: { rowPayloadVersion: 8, envelopeSchemaVersion: 4 },
        decode: (input) =>
          z
            .strictObject({
              payloadVersion: z.literal(8),
              payload: z.strictObject({
                eventSchemaVersion: z.literal(4),
                value: z.unknown(),
              }),
            })
            .parse(input),
        migrate: () => ({}),
      },
    ])

    expect(snapshotRegistry.read(7, { snapshotSchemaVersion: 3 })).toEqual({
      kind: 'invalidPayload',
    })
    expect(eventRegistry.read(8, { eventSchemaVersion: 4 })).toEqual({
      kind: 'invalidPayload',
    })
  })

  test('does not hide programming errors from injected version handlers', () => {
    const registry = createSnapshotVersionRegistry([
      {
        kind: 'legacy',
        identity: { rowPayloadVersion: 7, envelopeSchemaVersion: 3 },
        decode: () => {
          throw new Error('programming error')
        },
        migrate: (decoded) => decoded,
      },
    ])

    expect(() => registry.read(7, { snapshotSchemaVersion: 3 })).toThrow(
      'programming error',
    )
  })

  test('freezes constructed registries without exposing mutable production registration', () => {
    expect(Object.isFrozen(productionSnapshotVersionRegistry)).toBe(true)
    expect(Object.isFrozen(productionPrivateEventVersionRegistry)).toBe(true)
    expect('register' in productionSnapshotVersionRegistry).toBe(false)
    expect('register' in productionPrivateEventVersionRegistry).toBe(false)
    expect(
      productionSnapshotVersionRegistry.read(7, {
        snapshotSchemaVersion: 3,
      }),
    ).toEqual({ kind: 'unknownVersion' })
  })
})
