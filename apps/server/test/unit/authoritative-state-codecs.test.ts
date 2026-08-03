import { describe, expect, test } from 'vitest'
import {
  AuthoritativeStateValidationError,
  CurrentPayloadValidationError,
  CurrentPayloadVersionError,
} from '../../src/sessions/authoritative-state/errors.js'
import {
  createActionCommittedEventDraft,
  createHandCompletedEventDraft,
  createHandStartedEventDraft,
  createUncalledBetReturnedEventDraft,
} from '../../src/poker/hand-result.js'
import {
  EVENT_SCHEMA_VERSION,
  PRIVATE_EVENT_PAYLOAD_VERSION,
  decodeCurrentPrivateEventV1,
  encodePrivateEventV1,
} from '../../src/sessions/authoritative-state/private-event-codec-v1.js'
import { createPrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'
import {
  PRIVATE_TABLE_STATE_PAYLOAD_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  decodeCurrentSnapshotV1,
  encodeSnapshotV1,
} from '../../src/sessions/authoritative-state/snapshot-codec-v1.js'
import { createTestPokerState } from '../poker/create-test-poker-state.js'
import { createTestCompletedPokerResult } from '../poker/create-test-completed-poker-result.js'

function minimalPrivateTableState() {
  const poker = createTestPokerState()
  return createPrivateTableState({
    stateVersion: 0,
    poker,
    completedHandCount: 0,
    seatAccounting: poker.seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      cumulativeBuyIn: 2_000,
    })),
    lastCompletedHandSummary: null,
  })
}

describe('current authoritative-state codecs', () => {
  test('publishes four independently named current version constants', () => {
    expect({
      privateTableStatePayload: PRIVATE_TABLE_STATE_PAYLOAD_VERSION,
      snapshotEnvelope: SNAPSHOT_SCHEMA_VERSION,
      privateEventPayload: PRIVATE_EVENT_PAYLOAD_VERSION,
      eventEnvelope: EVENT_SCHEMA_VERSION,
    }).toEqual({
      privateTableStatePayload: 1,
      snapshotEnvelope: 1,
      privateEventPayload: 1,
      eventEnvelope: 1,
    })
  })

  test('round-trips the current snapshot row and envelope as a deep-frozen value', () => {
    const state = minimalPrivateTableState()
    const encoded = encodeSnapshotV1(state)

    expect(encoded).toEqual({
      payloadVersion: 1,
      payload: { snapshotSchemaVersion: 1, state },
    })
    expect(decodeCurrentSnapshotV1(structuredClone(encoded))).toEqual(encoded)
    expect(Object.isFrozen(encoded)).toBe(true)
    expect(Object.isFrozen(encoded.payload)).toBe(true)
    expect(Object.isFrozen(encoded.payload.state.poker.seats)).toBe(true)
  })

  test('classifies snapshot row version, envelope version, decode corruption and encode input separately', () => {
    const encoded = encodeSnapshotV1(minimalPrivateTableState())

    for (const [input, target] of [
      [{ ...encoded, payloadVersion: 2 }, 'snapshotRowVersion'],
      [
        {
          ...encoded,
          payload: { ...encoded.payload, snapshotSchemaVersion: 2 },
        },
        'snapshotEnvelopeVersion',
      ],
    ] as const) {
      try {
        decodeCurrentSnapshotV1(input)
        throw new Error('Expected snapshot version rejection.')
      } catch (error) {
        expect(error).toBeInstanceOf(CurrentPayloadVersionError)
        expect((error as CurrentPayloadVersionError).target).toBe(target)
        expect((error as Error).cause).toBeUndefined()
      }
    }

    expect(() =>
      decodeCurrentSnapshotV1({
        ...encoded,
        payload: { ...encoded.payload, state: {} },
      }),
    ).toThrow(CurrentPayloadValidationError)
    expect(() => encodeSnapshotV1({})).toThrow(
      AuthoritativeStateValidationError,
    )
  })

  test('classifies malformed snapshot version fields as payload corruption', () => {
    const encoded = encodeSnapshotV1(minimalPrivateTableState())
    const malformedInputs = [
      { ...encoded, payloadVersion: '1' },
      { ...encoded, payloadVersion: null },
      { ...encoded, payloadVersion: 1.5 },
      { payload: encoded.payload },
      {
        ...encoded,
        payload: { ...encoded.payload, snapshotSchemaVersion: '1' },
      },
      {
        ...encoded,
        payload: { ...encoded.payload, snapshotSchemaVersion: null },
      },
      {
        ...encoded,
        payload: { ...encoded.payload, snapshotSchemaVersion: 1.5 },
      },
      { ...encoded, payload: { state: encoded.payload.state } },
    ]

    for (const input of malformedInputs) {
      expect(() => decodeCurrentSnapshotV1(input)).toThrow(
        CurrentPayloadValidationError,
      )
    }
  })

  test('round-trips the handStarted private event through the current V1 row and envelope', () => {
    const event = createHandStartedEventDraft({
      handId: '10000000-0000-4000-8000-000000000001',
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
    const encoded = encodePrivateEventV1(event)

    expect(encoded).toEqual({
      payloadVersion: 1,
      payload: { eventSchemaVersion: 1, event },
    })
    expect(decodeCurrentPrivateEventV1(structuredClone(encoded))).toEqual(
      encoded,
    )
    expect(Object.isFrozen(encoded.payload.event)).toBe(true)
  })

  test('round-trips the actionCommitted private event through V1', () => {
    const event = createActionCommittedEventDraft({
      handId: '10000000-0000-4000-8000-000000000001',
      actorSeatNumber: 0,
      command: { actorSeatNumber: 0, action: { type: 'fold' } },
      legalActionsBefore: [{ type: 'fold' }],
      before: {
        street: 'preflop',
        board: [],
        currentActorSeatNumber: 0,
        pot: 30,
        seats: [
          {
            seatNumber: 0,
            status: 'active',
            stack: 2_000,
            streetContribution: 0,
            totalContribution: 0,
          },
        ],
      },
      after: {
        street: 'preflop',
        board: [],
        currentActorSeatNumber: 1,
        pot: 30,
        seats: [
          {
            seatNumber: 0,
            status: 'folded',
            stack: 2_000,
            streetContribution: 0,
            totalContribution: 0,
          },
        ],
      },
      progression: {
        streetTransitions: [],
        burnedCardsAdded: [],
        boardCardsAdded: [],
        terminationReason: null,
      },
      statistics: {
        isVoluntaryPreflopContribution: false,
        isPreflopRaise: false,
        isVoluntaryPreflopFullRaise: false,
        canMakeFullRaiseBeforeAction: true,
      },
    })

    expect(
      decodeCurrentPrivateEventV1(structuredClone(encodePrivateEventV1(event)))
        .payload.event,
    ).toEqual(event)
  })

  test('round-trips the uncalledBetReturned private event through V1', () => {
    const event = createUncalledBetReturnedEventDraft(
      '10000000-0000-4000-8000-000000000001',
      [
        { seatNumber: 5, amount: 10 },
        { seatNumber: 1, amount: 20 },
      ],
    )

    expect(
      decodeCurrentPrivateEventV1(structuredClone(encodePrivateEventV1(event)))
        .payload.event,
    ).toEqual(event)
  })

  test('round-trips the handCompleted private event through V1', () => {
    const completed = createTestCompletedPokerResult().completedHand
    const event = createHandCompletedEventDraft(completed)

    expect(
      decodeCurrentPrivateEventV1(structuredClone(encodePrivateEventV1(event)))
        .payload.event,
    ).toEqual(event)
  })

  test('classifies event versions and matching-version corruption without leaking nested errors', () => {
    const completed = createTestCompletedPokerResult().completedHand
    const encoded = encodePrivateEventV1(
      createHandCompletedEventDraft(completed),
    )

    for (const [input, target] of [
      [{ ...encoded, payloadVersion: 2 }, 'eventRowVersion'],
      [
        {
          ...encoded,
          payload: { ...encoded.payload, eventSchemaVersion: 2 },
        },
        'eventEnvelopeVersion',
      ],
    ] as const) {
      try {
        decodeCurrentPrivateEventV1(input)
        throw new Error('Expected event version rejection.')
      } catch (error) {
        expect(error).toBeInstanceOf(CurrentPayloadVersionError)
        expect((error as CurrentPayloadVersionError).target).toBe(target)
        expect((error as Error).cause).toBeUndefined()
      }
    }

    expect(() =>
      decodeCurrentPrivateEventV1({
        ...encoded,
        payload: {
          ...encoded.payload,
          event: { ...encoded.payload.event, extra: true },
        },
      }),
    ).toThrow(CurrentPayloadValidationError)
    expect(() => encodePrivateEventV1({ type: 'sessionCreated' })).toThrow(
      AuthoritativeStateValidationError,
    )
  })

  test('classifies malformed event version fields as payload corruption', () => {
    const completed = createTestCompletedPokerResult().completedHand
    const encoded = encodePrivateEventV1(
      createHandCompletedEventDraft(completed),
    )
    const malformedInputs = [
      { ...encoded, payloadVersion: '1' },
      { ...encoded, payloadVersion: null },
      { ...encoded, payloadVersion: 1.5 },
      { payload: encoded.payload },
      {
        ...encoded,
        payload: { ...encoded.payload, eventSchemaVersion: '1' },
      },
      {
        ...encoded,
        payload: { ...encoded.payload, eventSchemaVersion: null },
      },
      {
        ...encoded,
        payload: { ...encoded.payload, eventSchemaVersion: 1.5 },
      },
      { ...encoded, payload: { event: encoded.payload.event } },
    ]

    for (const input of malformedInputs) {
      expect(() => decodeCurrentPrivateEventV1(input)).toThrow(
        CurrentPayloadValidationError,
      )
    }
  })

  test('rejects deterministic nested corruption in every applicable V1 event shape', () => {
    const startedEvent = createHandStartedEventDraft({
      handId: '10000000-0000-4000-8000-000000000001',
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
    if (startedEvent.type !== 'handStarted') {
      throw new Error('Expected a handStarted event.')
    }
    const duplicatedButton = {
      ...startedEvent,
      startedHand: {
        ...startedEvent.startedHand,
        positions: startedEvent.startedHand.positions.map((position) =>
          position.seatNumber === 3
            ? { ...position, position: 'BTN' as const }
            : position,
        ),
      },
    }
    const actionEvent = createActionCommittedEventDraft({
      handId: '10000000-0000-4000-8000-000000000001',
      actorSeatNumber: 0,
      command: { actorSeatNumber: 0, action: { type: 'fold' } },
      legalActionsBefore: [{ type: 'fold' }],
      before: {
        street: 'preflop',
        board: [],
        currentActorSeatNumber: 0,
        pot: 30,
        seats: [
          {
            seatNumber: 0,
            status: 'active',
            stack: 2_000,
            streetContribution: 0,
            totalContribution: 0,
          },
        ],
      },
      after: {
        street: 'preflop',
        board: [],
        currentActorSeatNumber: 1,
        pot: 30,
        seats: [
          {
            seatNumber: 0,
            status: 'folded',
            stack: 2_000,
            streetContribution: 0,
            totalContribution: 0,
          },
        ],
      },
      progression: {
        streetTransitions: [],
        burnedCardsAdded: [],
        boardCardsAdded: [],
        terminationReason: null,
      },
      statistics: {
        isVoluntaryPreflopContribution: false,
        isPreflopRaise: false,
        isVoluntaryPreflopFullRaise: false,
        canMakeFullRaiseBeforeAction: true,
      },
    })
    if (actionEvent.type !== 'actionCommitted') {
      throw new Error('Expected an actionCommitted event.')
    }
    const repeatedCard = { rank: 'A' as const, suit: 'spades' as const }
    const oversizedRepeatedBoard = {
      ...actionEvent,
      before: {
        ...actionEvent.before,
        board: Array.from({ length: 6 }, () => repeatedCard),
      },
    }
    const zeroReturn = {
      type: 'uncalledBetReturned' as const,
      handId: '10000000-0000-4000-8000-000000000001',
      returns: [{ seatNumber: 1, amount: 0 }],
    }
    const unsafeHandNumber = {
      ...startedEvent,
      startedHand: {
        ...startedEvent.startedHand,
        handNumber: Number.MAX_SAFE_INTEGER + 1,
      },
    }

    for (const event of [
      duplicatedButton,
      oversizedRepeatedBoard,
      zeroReturn,
      unsafeHandNumber,
    ]) {
      expect(() => encodePrivateEventV1(event)).toThrow(
        AuthoritativeStateValidationError,
      )
    }
  })
})
