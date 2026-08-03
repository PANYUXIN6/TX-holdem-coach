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
  applyPokerAction,
  initializePokerTable,
  startPokerHand,
} from '../../src/poker/poker-engine.js'
import { createPokerTableState } from '../../src/poker/state.js'
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

function actionSnapshotSeats(seatZeroStatus: 'active' | 'folded' = 'active') {
  return Array.from({ length: 6 }, (_, seatNumber) => {
    const contribution = seatNumber === 1 ? 10 : seatNumber === 2 ? 20 : 0
    return {
      seatNumber,
      status: seatNumber === 0 ? seatZeroStatus : ('active' as const),
      stack: 2_000 - contribution,
      streetContribution: contribution,
      totalContribution: contribution,
    }
  })
}

function actionCommittedEvent() {
  return createActionCommittedEventDraft({
    handId: '10000000-0000-4000-8000-000000000001',
    actorSeatNumber: 0,
    command: { actorSeatNumber: 0, action: { type: 'fold' } },
    legalActionsBefore: [{ type: 'fold' }],
    before: {
      street: 'preflop',
      board: [],
      currentActorSeatNumber: 0,
      pot: 30,
      seats: actionSnapshotSeats(),
    },
    after: {
      street: 'preflop',
      board: [],
      currentActorSeatNumber: 1,
      pot: 30,
      seats: actionSnapshotSeats('folded'),
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
}

function preflopRunoutEvent() {
  const seats = Array.from({ length: 6 }, (_, seatNumber) => ({
    seatNumber,
    playerId: `00000000-0000-4000-8000-00000000000${seatNumber + 1}`,
    isUser: seatNumber === 0,
    stack: 1_000,
    status: 'active' as const,
    streetContribution: 0,
    totalContribution: 0,
  }))
  const randomSource = { nextInt: () => 0 }
  const started = startPokerHand(initializePokerTable(seats, randomSource), {
    handId: '10000000-0000-4000-8000-000000000001',
    completedHandCountBeforeStart: 0,
    randomSource,
  }).state
  const state = createPokerTableState({
    ...started,
    seats: started.seats.map((seat) => {
      if (seat.seatNumber === 2) {
        return { ...seat, status: 'allIn' as const, stack: 0 }
      }
      if (seat.seatNumber === 3) {
        return seat
      }
      return { ...seat, status: 'folded' as const }
    }),
  })
  const event = applyPokerAction(state, {
    actorSeatNumber: 3,
    action: { type: 'call' },
  }).eventDrafts[0]
  if (event?.type !== 'actionCommitted') {
    throw new Error('Expected a preflop runout actionCommitted event.')
  }
  return event
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

  test('rejects a handStarted event with a zero starting stack', () => {
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
        stack: seatNumber === 0 ? 0 : 2_000,
      })),
    })

    expect(() => encodePrivateEventV1(event)).toThrow(
      AuthoritativeStateValidationError,
    )
  })

  test('round-trips the actionCommitted private event through V1', () => {
    const event = actionCommittedEvent()

    expect(
      decodeCurrentPrivateEventV1(structuredClone(encodePrivateEventV1(event)))
        .payload.event,
    ).toEqual(event)
  })

  test('rejects action snapshots with fewer than six table seats', () => {
    const event = actionCommittedEvent()
    if (event.type !== 'actionCommitted') {
      throw new Error('Expected an actionCommitted event.')
    }
    const invalidEvent = {
      ...event,
      before: { ...event.before, seats: event.before.seats.slice(0, 1) },
      after: { ...event.after, seats: event.after.seats.slice(0, 1) },
    }

    expect(() => encodePrivateEventV1(invalidEvent)).toThrow(
      AuthoritativeStateValidationError,
    )
  })

  test('rejects action snapshots with different before and after seat sets', () => {
    const event = actionCommittedEvent()
    if (event.type !== 'actionCommitted') {
      throw new Error('Expected an actionCommitted event.')
    }
    const invalidEvent = {
      ...event,
      after: {
        ...event.after,
        seats: event.after.seats.map((seat) =>
          seat.seatNumber === 5 ? { ...seat, seatNumber: 6 } : seat,
        ),
      },
    }

    expect(() => encodePrivateEventV1(invalidEvent)).toThrow(
      AuthoritativeStateValidationError,
    )
  })

  test('rejects action snapshots that do not conserve stacks plus pot', () => {
    const event = actionCommittedEvent()
    if (event.type !== 'actionCommitted') {
      throw new Error('Expected an actionCommitted event.')
    }
    const invalidEvent = {
      ...event,
      after: {
        ...event.after,
        seats: event.after.seats.map((seat) =>
          seat.seatNumber === 0 ? { ...seat, stack: seat.stack - 1 } : seat,
        ),
      },
    }

    expect(() => encodePrivateEventV1(invalidEvent)).toThrow(
      AuthoritativeStateValidationError,
    )
  })

  test('rejects boardCardsAdded that is not the exact new board suffix', () => {
    const event = actionCommittedEvent()
    if (event.type !== 'actionCommitted') {
      throw new Error('Expected an actionCommitted event.')
    }
    const invalidEvent = {
      ...event,
      progression: {
        ...event.progression,
        boardCardsAdded: [{ rank: 'A' as const, suit: 'spades' as const }],
      },
    }

    expect(() => encodePrivateEventV1(invalidEvent)).toThrow(
      AuthoritativeStateValidationError,
    )
  })

  test('rejects missing burned cards for runout street transitions', () => {
    const event = preflopRunoutEvent()
    const invalidEvent = {
      ...event,
      progression: { ...event.progression, burnedCardsAdded: [] },
    }

    expect(() => encodePrivateEventV1(invalidEvent)).toThrow(
      AuthoritativeStateValidationError,
    )
  })

  test('rejects streetTransitions that do not mirror snapshot streets', () => {
    const event = actionCommittedEvent()
    if (event.type !== 'actionCommitted') {
      throw new Error('Expected an actionCommitted event.')
    }
    const invalidEvent = {
      ...event,
      progression: {
        ...event.progression,
        streetTransitions: ['flop' as const],
      },
    }

    expect(() => encodePrivateEventV1(invalidEvent)).toThrow(
      AuthoritativeStateValidationError,
    )
  })

  test('rejects a terminationReason that does not mirror the after street', () => {
    const event = actionCommittedEvent()
    if (event.type !== 'actionCommitted') {
      throw new Error('Expected an actionCommitted event.')
    }
    const invalidEvent = {
      ...event,
      progression: {
        ...event.progression,
        terminationReason: 'complete' as const,
      },
    }

    expect(() => encodePrivateEventV1(invalidEvent)).toThrow(
      AuthoritativeStateValidationError,
    )
  })

  test('rejects an action actor that is absent from the before snapshot', () => {
    const event = actionCommittedEvent()
    if (event.type !== 'actionCommitted') {
      throw new Error('Expected an actionCommitted event.')
    }
    const invalidEvent = {
      ...event,
      actorSeatNumber: 8,
      command: { ...event.command, actorSeatNumber: 8 },
      before: { ...event.before, currentActorSeatNumber: 8 },
    }

    expect(() => encodePrivateEventV1(invalidEvent)).toThrow(
      AuthoritativeStateValidationError,
    )
  })

  test('rejects a snapshot current actor that is absent from its seats', () => {
    const event = actionCommittedEvent()
    if (event.type !== 'actionCommitted') {
      throw new Error('Expected an actionCommitted event.')
    }
    const invalidEvent = {
      ...event,
      after: { ...event.after, currentActorSeatNumber: 8 },
    }

    expect(() => encodePrivateEventV1(invalidEvent)).toThrow(
      AuthoritativeStateValidationError,
    )
  })

  test('rejects a snapshot whose pot does not equal total contributions', () => {
    const event = actionCommittedEvent()
    if (event.type !== 'actionCommitted') {
      throw new Error('Expected an actionCommitted event.')
    }
    const invalidEvent = {
      ...event,
      after: { ...event.after, pot: 31 },
    }

    expect(() => encodePrivateEventV1(invalidEvent)).toThrow(
      AuthoritativeStateValidationError,
    )
  })

  test('rejects a snapshot whose street contribution exceeds its hand contribution', () => {
    const event = actionCommittedEvent()
    if (event.type !== 'actionCommitted') {
      throw new Error('Expected an actionCommitted event.')
    }
    const invalidEvent = {
      ...event,
      after: {
        ...event.after,
        seats: event.after.seats.map((seat) =>
          seat.seatNumber === 0 ? { ...seat, streetContribution: 1 } : seat,
        ),
      },
    }

    expect(() => encodePrivateEventV1(invalidEvent)).toThrow(
      AuthoritativeStateValidationError,
    )
  })

  test('rejects a snapshot whose current actor cannot act', () => {
    const event = actionCommittedEvent()
    if (event.type !== 'actionCommitted') {
      throw new Error('Expected an actionCommitted event.')
    }
    const invalidEvents = [
      {
        ...event,
        after: {
          ...event.after,
          seats: event.after.seats.map((seat) =>
            seat.seatNumber === 1
              ? { ...seat, status: 'folded' as const }
              : seat,
          ),
        },
      },
      {
        ...event,
        after: {
          ...event.after,
          seats: event.after.seats.map((seat) =>
            seat.seatNumber === 1 ? { ...seat, stack: 0 } : seat,
          ),
        },
      },
    ]

    for (const invalidEvent of invalidEvents) {
      expect(() => encodePrivateEventV1(invalidEvent)).toThrow(
        AuthoritativeStateValidationError,
      )
    }
  })

  test('rejects snapshot actor presence that contradicts its street', () => {
    const event = actionCommittedEvent()
    if (event.type !== 'actionCommitted') {
      throw new Error('Expected an actionCommitted event.')
    }
    const invalidEvents = [
      {
        ...event,
        after: { ...event.after, currentActorSeatNumber: null },
      },
      {
        ...event,
        after: { ...event.after, street: 'complete' as const },
      },
    ]

    for (const invalidEvent of invalidEvents) {
      expect(() => encodePrivateEventV1(invalidEvent)).toThrow(
        AuthoritativeStateValidationError,
      )
    }
  })

  test('round-trips the uncalledBetReturned private event through V1', () => {
    const event = createUncalledBetReturnedEventDraft(
      '10000000-0000-4000-8000-000000000001',
      [{ seatNumber: 5, amount: 10 }],
    )

    expect(
      decodeCurrentPrivateEventV1(structuredClone(encodePrivateEventV1(event)))
        .payload.event,
    ).toEqual(event)
  })

  test('rejects more than one uncalled-bet return in a V1 private event', () => {
    expect(() =>
      encodePrivateEventV1({
        type: 'uncalledBetReturned',
        handId: '10000000-0000-4000-8000-000000000001',
        returns: [
          { seatNumber: 1, amount: 10 },
          { seatNumber: 5, amount: 20 },
        ],
      }),
    ).toThrow(AuthoritativeStateValidationError)
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
    const actionEvent = actionCommittedEvent()
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
