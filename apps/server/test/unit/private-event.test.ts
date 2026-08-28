import { describe, expect, test } from 'vitest'
import { AuthoritativeStateValidationError } from '../../src/sessions/authoritative-state/errors.js'
import {
  createPrivateEvent,
  getPrivateEventHandId,
} from '../../src/sessions/authoritative-state/private-event.js'
import {
  currentPrivateEventReader,
  decodeCurrentPrivateEvent,
  encodeCurrentPrivateEvent,
  PRIVATE_EVENT_PAYLOAD_VERSION,
} from '../../src/sessions/authoritative-state/private-event-codec.js'
import {
  createHandCompletedEventDraft,
  createHandStartedEventDraft,
  createUncalledBetReturnedEventDraft,
} from '../../src/poker/hand-result.js'
import { createTestCompletedPokerResult } from '../poker/create-test-completed-poker-result.js'

const handId = '10000000-0000-4000-8000-000000000001'
const agentRunId = '10000000-0000-4000-8000-000000000002'
const decisionRequestId = '10000000-0000-4000-8000-000000000003'
const attemptId = '10000000-0000-4000-8000-000000000004'

function sessionCreatedEvent() {
  return {
    type: 'sessionCreated' as const,
    initialBuyIns: Array.from({ length: 6 }, (_, seatNumber) => ({
      seatNumber,
      amount: 2_000 as const,
    })),
  }
}

function handAbortedEvent() {
  return {
    type: 'handAborted' as const,
    handId,
    beforeAbort: {
      buttonSeatNumber: 0,
      completedHandCount: 0,
      pot: 30,
      seats: Array.from({ length: 6 }, (_, seatNumber) => ({
        seatNumber,
        stack: seatNumber === 1 ? 1_990 : seatNumber === 2 ? 1_980 : 2_000,
        cumulativeBuyIn: 2_000,
      })),
    },
    restored: {
      buttonSeatNumber: 0,
      completedHandCount: 0,
      seats: Array.from({ length: 6 }, (_, seatNumber) => ({
        seatNumber,
        stack: 2_000,
        cumulativeBuyIn: 2_000,
      })),
    },
  }
}

function pokerEvents() {
  const completed = createTestCompletedPokerResult()
  const actionCommitted = completed.eventDrafts.find(
    (event) => event.type === 'actionCommitted',
  )
  if (actionCommitted === undefined) {
    throw new Error('Expected an actionCommitted event.')
  }
  return [
    createHandStartedEventDraft({
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
    }),
    actionCommitted,
    createUncalledBetReturnedEventDraft(handId, [
      { seatNumber: 1, amount: 10 },
    ]),
    createHandCompletedEventDraft(completed.completedHand),
  ] as const
}

const newEventCases = [
  sessionCreatedEvent(),
  {
    type: 'userRebuy' as const,
    seatNumber: 0 as const,
    amount: 500,
    stackBefore: 1_000,
    stackAfter: 1_500,
    cumulativeBuyInBefore: 2_000,
    cumulativeBuyInAfter: 2_500,
  },
  {
    type: 'aiAutoRebuy' as const,
    seatNumber: 1,
    amount: 2_000 as const,
    stackBefore: 0 as const,
    stackAfter: 2_000 as const,
    cumulativeBuyInBefore: 2_000,
    cumulativeBuyInAfter: 4_000,
  },
  handAbortedEvent(),
  { type: 'sessionEnded' as const, reason: 'userRequested' as const },
]

const playerCoordinationEvents = [
  {
    type: 'agentStarted' as const,
    handId,
    agentRunId,
    decisionRequestId,
    actorSeatNumber: 1,
    trigger: 'initial' as const,
    supersedesRunId: null,
  },
  {
    type: 'agentRepairAttempted' as const,
    handId,
    agentRunId,
    decisionRequestId,
    actorSeatNumber: 1,
    attemptId,
    repairOrdinal: 1 as const,
  },
  {
    type: 'agentPaused' as const,
    handId,
    failedAgentRunId: agentRunId,
    decisionRequestId,
    actorSeatNumber: 1,
    failureCode: 'provider_timeout' as const,
  },
] as const

describe('private event', () => {
  test.each(newEventCases)('round-trips and freezes $type', (input) => {
    const event = createPrivateEvent(input)
    const encoded = encodeCurrentPrivateEvent(input)
    expect(event).toEqual(input)
    expect(Object.isFrozen(event)).toBe(true)
    expect(decodeCurrentPrivateEvent(structuredClone(encoded))).toEqual(encoded)
    expect(Object.isFrozen(encoded.payload.event)).toBe(true)
  })

  test('rejects extra fields, invalid arithmetic and unsafe totals', () => {
    expect(() =>
      createPrivateEvent({ ...sessionCreatedEvent(), extra: true }),
    ).toThrow(AuthoritativeStateValidationError)
    for (const initialBuyIns of [
      sessionCreatedEvent().initialBuyIns.slice().reverse(),
      sessionCreatedEvent().initialBuyIns.map((buyIn, index) =>
        index === 5 ? { ...buyIn, seatNumber: 4 } : buyIn,
      ),
      sessionCreatedEvent().initialBuyIns.map((buyIn) => ({
        ...buyIn,
        seatNumber: buyIn.seatNumber + 1,
      })),
    ]) {
      expect(() =>
        createPrivateEvent({ type: 'sessionCreated', initialBuyIns }),
      ).toThrow(AuthoritativeStateValidationError)
    }
    expect(() =>
      createPrivateEvent({
        type: 'userRebuy',
        seatNumber: 0,
        amount: 500,
        stackBefore: 1_000,
        stackAfter: 1_499,
        cumulativeBuyInBefore: 2_000,
        cumulativeBuyInAfter: 2_500,
      }),
    ).toThrow(AuthoritativeStateValidationError)
    expect(() =>
      createPrivateEvent({
        ...handAbortedEvent(),
        beforeAbort: {
          ...handAbortedEvent().beforeAbort,
          pot: Number.MAX_SAFE_INTEGER,
        },
      }),
    ).toThrow(AuthoritativeStateValidationError)
  })

  test('maps structured hand ids for all twelve current variants', () => {
    const events = [
      ...pokerEvents(),
      ...newEventCases,
      ...playerCoordinationEvents,
    ]
    expect(events).toHaveLength(12)
    expect(
      events.map((event) => getPrivateEventHandId(createPrivateEvent(event))),
    ).toEqual([
      handId,
      handId,
      handId,
      handId,
      null,
      null,
      null,
      handId,
      null,
      handId,
      handId,
      handId,
    ])
  })

  test('keeps all four poker variants strict in the current codec', () => {
    for (const event of pokerEvents()) {
      expect(encodeCurrentPrivateEvent(event).payload.event).toEqual(event)
      expect(() =>
        encodeCurrentPrivateEvent({ ...event, extra: 'not allowed' }),
      ).toThrow(AuthoritativeStateValidationError)
    }
  })

  test('enforces both directions of the handAborted AI rollback condition', () => {
    const rollback = {
      ...handAbortedEvent(),
      beforeAbort: {
        ...handAbortedEvent().beforeAbort,
        pot: 0,
        seats: handAbortedEvent().beforeAbort.seats.map((seat) =>
          seat.seatNumber === 1
            ? { ...seat, stack: 2_000, cumulativeBuyIn: 4_000 }
            : seat.seatNumber === 2
              ? { ...seat, stack: 4_000 }
              : { ...seat, stack: 2_000 },
        ),
      },
      restored: {
        ...handAbortedEvent().restored,
        seats: handAbortedEvent().restored.seats.map((seat) =>
          seat.seatNumber === 1
            ? { ...seat, stack: 0 }
            : seat.seatNumber === 2
              ? { ...seat, stack: 4_000 }
              : seat,
        ),
      },
    }
    expect(() => createPrivateEvent(rollback)).not.toThrow()

    expect(() =>
      createPrivateEvent({
        ...rollback,
        restored: {
          ...rollback.restored,
          seats: rollback.restored.seats.map((seat) =>
            seat.seatNumber === 1
              ? { ...seat, stack: 1 }
              : seat.seatNumber === 2
                ? { ...seat, stack: 3_999 }
                : seat,
          ),
        },
      }),
    ).toThrow(AuthoritativeStateValidationError)

    expect(() =>
      createPrivateEvent({
        ...rollback,
        beforeAbort: {
          ...rollback.beforeAbort,
          seats: rollback.beforeAbort.seats.map((seat) =>
            seat.seatNumber === 1
              ? { ...seat, stack: 0, cumulativeBuyIn: 2_000 }
              : seat.seatNumber === 2
                ? { ...seat, stack: 4_000 }
                : seat,
          ),
        },
      }),
    ).toThrow(AuthoritativeStateValidationError)
  })

  test('writes row payload version 2 while strictly reading published v1 rows', () => {
    const current = encodeCurrentPrivateEvent(sessionCreatedEvent())
    const legacy = {
      payloadVersion: 1,
      payload: { event: sessionCreatedEvent() },
    }

    expect({
      payload: PRIVATE_EVENT_PAYLOAD_VERSION,
      current,
    }).toEqual({
      payload: 2,
      current: {
        payloadVersion: 2,
        payload: { event: sessionCreatedEvent() },
      },
    })
    expect(decodeCurrentPrivateEvent(structuredClone(current))).toEqual(current)
    expect(
      currentPrivateEventReader.read(current.payloadVersion, current.payload),
    ).toEqual({ kind: 'decoded', value: sessionCreatedEvent() })
    expect(
      currentPrivateEventReader.read(legacy.payloadVersion, legacy.payload),
    ).toEqual({ kind: 'decoded', value: sessionCreatedEvent() })
    expect(
      currentPrivateEventReader.read(3, { event: pokerEvents()[0] }),
    ).toEqual({ kind: 'unknownVersion' })
  })

  test('strictly validates Player coordination events without accepting hidden payloads', () => {
    for (const event of playerCoordinationEvents) {
      expect(encodeCurrentPrivateEvent(event).payload.event).toEqual(event)
    }
    expect(() =>
      createPrivateEvent({
        ...playerCoordinationEvents[0],
        trigger: 'initial',
        supersedesRunId: agentRunId,
      }),
    ).toThrow(AuthoritativeStateValidationError)
    expect(() =>
      createPrivateEvent({
        ...playerCoordinationEvents[1],
        repairOrdinal: 3,
      }),
    ).toThrow(AuthoritativeStateValidationError)
    expect(() =>
      createPrivateEvent({
        ...playerCoordinationEvents[2],
        failureCode: 'provider error details',
      }),
    ).toThrow(AuthoritativeStateValidationError)
  })
})
