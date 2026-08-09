import { describe, expect, test } from 'vitest'
import { AuthoritativeStateValidationError } from '../../src/sessions/authoritative-state/errors.js'
import {
  createPrivateEventV2,
  getPrivateEventHandId,
} from '../../src/sessions/authoritative-state/private-event-v2.js'
import {
  decodeCurrentPrivateEventV2,
  encodePrivateEventV2,
  EVENT_V2_SCHEMA_VERSION,
  PRIVATE_EVENT_V2_PAYLOAD_VERSION,
} from '../../src/sessions/authoritative-state/private-event-codec-v2.js'
import { encodePrivateEventV1 } from '../../src/sessions/authoritative-state/private-event-codec-v1.js'
import { productionPrivateEventVersionRegistry } from '../../src/sessions/authoritative-state/private-event-version-registry.js'
import {
  createHandCompletedEventDraft,
  createHandStartedEventDraft,
  createUncalledBetReturnedEventDraft,
} from '../../src/poker/hand-result.js'
import { createTestCompletedPokerResult } from '../poker/create-test-completed-poker-result.js'

const handId = '10000000-0000-4000-8000-000000000001'

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

function v1Events() {
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

describe('private event V2', () => {
  test.each(newEventCases)('round-trips and freezes $type', (input) => {
    const event = createPrivateEventV2(input)
    const encoded = encodePrivateEventV2(input)
    expect(event).toEqual(input)
    expect(Object.isFrozen(event)).toBe(true)
    expect(decodeCurrentPrivateEventV2(structuredClone(encoded))).toEqual(
      encoded,
    )
    expect(Object.isFrozen(encoded.payload.event)).toBe(true)
  })

  test('rejects extra fields, invalid arithmetic and unsafe totals', () => {
    expect(() =>
      createPrivateEventV2({ ...sessionCreatedEvent(), extra: true }),
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
        createPrivateEventV2({ type: 'sessionCreated', initialBuyIns }),
      ).toThrow(AuthoritativeStateValidationError)
    }
    expect(() =>
      createPrivateEventV2({
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
      createPrivateEventV2({
        ...handAbortedEvent(),
        beforeAbort: {
          ...handAbortedEvent().beforeAbort,
          pot: Number.MAX_SAFE_INTEGER,
        },
      }),
    ).toThrow(AuthoritativeStateValidationError)
  })

  test('maps structured hand ids for all nine variants', () => {
    const events = [...v1Events(), ...newEventCases]
    expect(events).toHaveLength(9)
    expect(
      events.map((event) => getPrivateEventHandId(createPrivateEventV2(event))),
    ).toEqual([handId, handId, handId, handId, null, null, null, handId, null])
  })

  test('keeps all four V1 variants strict and semantically identical under V2', () => {
    for (const event of v1Events()) {
      const v1 = encodePrivateEventV1(event)
      const v2 = encodePrivateEventV2(event)
      expect(v2.payload.event).toEqual(v1.payload.event)
      expect(() =>
        encodePrivateEventV2({ ...event, extra: 'not allowed' }),
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
    expect(() => createPrivateEventV2(rollback)).not.toThrow()

    expect(() =>
      createPrivateEventV2({
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
      createPrivateEventV2({
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

  test('publishes V2 as current while reading V1 as legacy', () => {
    const current = encodePrivateEventV2(sessionCreatedEvent())
    const legacy = encodePrivateEventV1({
      type: 'uncalledBetReturned',
      handId,
      returns: [{ seatNumber: 1, amount: 10 }],
    })

    expect({
      payload: PRIVATE_EVENT_V2_PAYLOAD_VERSION,
      envelope: EVENT_V2_SCHEMA_VERSION,
      current,
    }).toEqual({
      payload: 2,
      envelope: 2,
      current: {
        payloadVersion: 2,
        payload: { eventSchemaVersion: 2, event: sessionCreatedEvent() },
      },
    })
    expect(decodeCurrentPrivateEventV2(structuredClone(current))).toEqual(
      current,
    )
    expect(
      productionPrivateEventVersionRegistry.read(
        current.payloadVersion,
        current.payload,
      ),
    ).toEqual({ kind: 'decoded', value: sessionCreatedEvent() })
    expect(
      productionPrivateEventVersionRegistry.read(
        legacy.payloadVersion,
        legacy.payload,
      ),
    ).toEqual({ kind: 'decoded', value: legacy.payload.event })
  })
})
