import { describe, expect, test } from 'vitest'
import {
  applyPokerAction,
  initializePokerTable,
  startPokerHand,
} from '../../src/poker/poker-engine.js'
import { createPokerTableState } from '../../src/poker/state.js'

const seats = Array.from({ length: 6 }, (_, seatNumber) => ({
  seatNumber,
  playerId: `00000000-0000-4000-8000-00000000000${seatNumber + 1}`,
  isUser: seatNumber === 0,
  stack: 1000,
  status: 'active' as const,
  streetContribution: 0,
  totalContribution: 0,
}))

function random(value = 0) {
  return { nextInt: (maximum: number) => value % maximum }
}

function countingRandom(value = 0) {
  let calls = 0
  return {
    source: {
      nextInt: (maximum: number) => {
        calls += 1
        return value % maximum
      },
    },
    calls: () => calls,
  }
}

describe('poker engine start boundary', () => {
  test('initializes a between-hands table with a deterministic button', () => {
    const state = initializePokerTable([...seats].reverse(), random(2))
    expect(state).toMatchObject({
      pokerPhase: 'betweenHands',
      buttonSeatNumber: 2,
      hand: null,
    })
    expect(Object.isFrozen(state)).toBe(true)
  })

  test('starts first hand without rotating then rotates exactly once later', () => {
    const table = initializePokerTable(seats, random(0))
    const first = startPokerHand(table, {
      handId: '10000000-0000-4000-8000-000000000001',
      completedHandCountBeforeStart: 0,
      randomSource: random(0),
    })
    expect(first.state.buttonSeatNumber).toBe(0)
    expect(first.startedHand).toMatchObject({
      handNumber: 1,
      smallBlindSeatNumber: 1,
      bigBlindSeatNumber: 2,
    })
    expect(first.eventDrafts).toHaveLength(1)
    expect(first.eventDrafts[0]?.type).toBe('handStarted')
    expect(first.state.hand?.currentActorSeatNumber).toBe(3)
    const laterTable = initializePokerTable(seats, random(0))
    const second = startPokerHand(laterTable, {
      handId: '20000000-0000-4000-8000-000000000001',
      completedHandCountBeforeStart: 1,
      randomSource: random(0),
    })
    expect(second.state.buttonSeatNumber).toBe(1)
  })

  test('rejects a table containing an out or zero-chip seat', () => {
    const invalid = initializePokerTable(
      seats.map((seat) =>
        seat.seatNumber === 5 ? { ...seat, stack: 0 } : seat,
      ),
      random(0),
    )
    expect(() =>
      startPokerHand(invalid, {
        handId: '10000000-0000-4000-8000-000000000001',
        completedHandCountBeforeStart: 0,
        randomSource: random(0),
      }),
    ).toThrow(RangeError)
  })

  test('does not consume randomness for invalid initialization or hand input', () => {
    const initializationRandom = countingRandom()
    expect(() =>
      initializePokerTable([...seats, seats[0]!], initializationRandom.source),
    ).toThrow()
    expect(initializationRandom.calls()).toBe(0)
    const table = initializePokerTable(seats, random(0))
    const handRandom = countingRandom()
    expect(() =>
      startPokerHand(table, {
        handId: 'not-a-uuid',
        completedHandCountBeforeStart: 0,
        randomSource: handRandom.source,
      }),
    ).toThrow()
    expect(handRandom.calls()).toBe(0)
  })

  test('reproduces the complete deal and facts with the same random source', () => {
    const input = {
      handId: '10000000-0000-4000-8000-000000000001',
      completedHandCountBeforeStart: 0,
    }
    const left = startPokerHand(initializePokerTable(seats, random(0)), {
      ...input,
      randomSource: random(0),
    })
    const right = startPokerHand(initializePokerTable(seats, random(0)), {
      ...input,
      randomSource: random(0),
    })
    expect(left.state).toEqual(right.state)
    expect(left.startedHand).toEqual(right.startedHand)
    expect(
      left.state.hand?.holeCards
        .map((item) => item.seatNumber)
        .sort((a, b) => a - b),
    ).toEqual(left.startedHand.participantSeatNumbers)
    expect(left.startedHand.buttonSeatNumber).toBe(left.state.buttonSeatNumber)
    expect(left.startedHand.startingStacks).toEqual(
      seats.map((seat) => ({ seatNumber: seat.seatNumber, stack: seat.stack })),
    )
    expect(left.startedHand.positions).toHaveLength(6)
  })
})

describe('poker engine action boundary', () => {
  function startedTable() {
    return startPokerHand(initializePokerTable(seats, random(0)), {
      handId: '10000000-0000-4000-8000-000000000001',
      completedHandCountBeforeStart: 0,
      randomSource: random(0),
    }).state
  }

  test('commits a normal action without exposing a completed hand', () => {
    const state = startedTable()
    const result = applyPokerAction(state, {
      actorSeatNumber: 3,
      action: { type: 'call' },
    })

    expect(result.completedHand).toBeNull()
    expect(result.state.pokerPhase).toBe('inHand')
    expect(result.state.hand?.street).toBe('preflop')
    expect(result.eventDrafts).toHaveLength(1)
    expect(result.eventDrafts[0]).toMatchObject({
      type: 'actionCommitted',
      actorSeatNumber: 3,
      command: { actorSeatNumber: 3, action: { type: 'call' } },
      before: { street: 'preflop', currentActorSeatNumber: 3, pot: 30 },
      after: { street: 'preflop', currentActorSeatNumber: 4, pot: 50 },
      progression: {
        streetTransitions: [],
        burnedCardsAdded: [],
        boardCardsAdded: [],
        terminationReason: null,
      },
      statistics: {
        isVoluntaryPreflopContribution: true,
        isPreflopRaise: false,
        isVoluntaryPreflopFullRaise: false,
        canMakeFullRaiseBeforeAction: true,
      },
    })
    expect(Object.isFrozen(result)).toBe(true)
  })

  test('settles a terminal action atomically and emits canonical events', () => {
    const initial = startedTable()
    const state = createPokerTableState({
      ...initial,
      seats: initial.seats.map((seat) => ({
        ...seat,
        status:
          seat.seatNumber === 2 || seat.seatNumber === 3
            ? ('active' as const)
            : ('folded' as const),
      })),
    })
    const before = structuredClone(state)

    const result = applyPokerAction(state, {
      actorSeatNumber: 3,
      action: { type: 'fold' },
    })

    expect(state).toEqual(before)
    expect(result.state).toMatchObject({
      pokerPhase: 'betweenHands',
      hand: null,
    })
    expect(result.completedHand).toMatchObject({
      handId: '10000000-0000-4000-8000-000000000001',
      terminationReason: 'complete',
      smallBlindSeatNumber: 1,
      bigBlindSeatNumber: 2,
    })
    expect(result.eventDrafts.map((event) => event.type)).toEqual([
      'actionCommitted',
      'uncalledBetReturned',
      'handCompleted',
    ])
    expect(result.eventDrafts[0]).toMatchObject({
      type: 'actionCommitted',
      after: { street: 'complete', currentActorSeatNumber: null, pot: 30 },
      progression: {
        streetTransitions: ['complete'],
        burnedCardsAdded: [],
        boardCardsAdded: [],
        terminationReason: 'complete',
      },
    })
    expect(result.eventDrafts[1]).toMatchObject({
      type: 'uncalledBetReturned',
      returns: [{ seatNumber: 2, amount: 10 }],
    })
    expect(
      result.state.seats.reduce((total, seat) => total + seat.stack, 0),
    ).toBe(6000)
    expect(Object.isFrozen(result.completedHand)).toBe(true)
  })

  test('settles showdown without an uncalled-bet event or terminal state leak', () => {
    const initial = startedTable()
    const state = createPokerTableState({
      ...initial,
      seats: initial.seats.map((seat) => {
        if (seat.seatNumber === 2) {
          return { ...seat, status: 'allIn' as const, stack: 0 }
        }
        if (seat.seatNumber === 3) {
          return seat
        }
        return { ...seat, status: 'folded' as const }
      }),
    })

    const result = applyPokerAction(state, {
      actorSeatNumber: 3,
      action: { type: 'call' },
    })

    expect(result.state).toMatchObject({
      pokerPhase: 'betweenHands',
      hand: null,
    })
    expect(result.completedHand?.terminationReason).toBe('showdown')
    expect(result.eventDrafts.map((event) => event.type)).toEqual([
      'actionCommitted',
      'handCompleted',
    ])
    expect(result.eventDrafts[0]).toMatchObject({
      type: 'actionCommitted',
      after: { street: 'showdown', currentActorSeatNumber: null },
      progression: {
        streetTransitions: ['flop', 'turn', 'river', 'showdown'],
        terminationReason: 'showdown',
      },
    })
    expect(result.eventDrafts[0]).not.toHaveProperty('state')
  })

  test('rejects illegal phases and commands without observable side effects', () => {
    const betweenHands = initializePokerTable(seats, random(0))
    const inHand = startedTable()
    const snapshot = structuredClone(inHand)

    expect(() =>
      applyPokerAction(betweenHands, {
        actorSeatNumber: 0,
        action: { type: 'fold' },
      }),
    ).toThrow(RangeError)
    expect(() =>
      applyPokerAction(inHand, {
        actorSeatNumber: 4,
        action: { type: 'fold' },
      }),
    ).toThrow(RangeError)
    expect(inHand).toEqual(snapshot)
  })
})
