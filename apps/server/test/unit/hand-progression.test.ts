import { describe, expect, test } from 'vitest'
import { STANDARD_DECK } from '../../src/poker/cards.js'
import type { PokerCommand } from '../../src/poker/commands.js'
import {
  dealFlop,
  dealPreflop,
  dealRiver,
  dealTurn,
  type DealtHand,
} from '../../src/poker/dealing.js'
import { applyPokerAction } from '../../src/poker/hand-progression.js'
import {
  createPokerState,
  type PokerState,
  type PokerStateInput,
} from '../../src/poker/state.js'

const PARTICIPANTS = [1, 2, 3, 4, 5, 0] as const

function deterministicPreflop(): DealtHand {
  return dealPreflop({
    buttonSeatNumber: 0,
    participantSeatNumbers: PARTICIPANTS,
    shuffledDeck: STANDARD_DECK.map(({ rank, suit }) => ({ rank, suit })),
  })
}

function dealtThrough(street: 'preflop' | 'flop' | 'turn' | 'river') {
  let dealt = deterministicPreflop()

  if (street === 'flop' || street === 'turn' || street === 'river') {
    dealt = dealFlop(dealt)
  }
  if (street === 'turn' || street === 'river') {
    dealt = dealTurn(dealt)
  }
  if (street === 'river') {
    dealt = dealRiver(dealt)
  }

  return dealt
}

function createProgressionState(
  street: 'preflop' | 'flop' | 'turn' | 'river',
  overrides: {
    readonly actorSeatNumber?: number
    readonly seats?: PokerStateInput['seats']
    readonly currentBet?: number
    readonly seatLevels?: Readonly<Record<number, number | null>>
  } = {},
): PokerState {
  const dealt = dealtThrough(street)
  const defaultContributions =
    street === 'preflop'
      ? new Map([
          [1, 10],
          [2, 20],
        ])
      : new Map<number, number>()
  const seats =
    overrides.seats ??
    PARTICIPANTS.map((seatNumber) => {
      const contribution = defaultContributions.get(seatNumber) ?? 0

      return {
        seatNumber,
        playerId: `00000000-0000-4000-8000-00000000000${seatNumber + 1}`,
        isUser: seatNumber === 0,
        stack: 2000 - contribution,
        status: 'active' as const,
        streetContribution: contribution,
        totalContribution: contribution,
      }
    })
  const currentBet = overrides.currentBet ?? (street === 'preflop' ? 20 : 0)

  return createPokerState({
    stateVersion: 4,
    pokerPhase: 'inHand',
    seats,
    buttonSeatNumber: 0,
    blinds: { smallBlind: 10, bigBlind: 20 },
    hand: {
      handId: '10000000-0000-4000-8000-000000000001',
      street,
      remainingDeck: dealt.remainingDeck,
      burnedCards: dealt.burnedCards,
      board: dealt.board,
      holeCards: dealt.holeCards,
      currentActorSeatNumber:
        overrides.actorSeatNumber ?? (street === 'preflop' ? 3 : 1),
      pot: seats.reduce((total, seat) => total + seat.totalContribution, 0),
      bettingRound: {
        currentBet,
        minimumFullRaiseIncrement: 20,
        seatStates: PARTICIPANTS.map((seatNumber) => ({
          seatNumber,
          betLevelAfterLastAction: overrides.seatLevels?.[seatNumber] ?? null,
        })),
      },
    },
  })
}

function expectStableSuccess(
  before: PokerState,
  command: PokerCommand,
): PokerState {
  const snapshot = structuredClone(before)
  const result = applyPokerAction(before, command)

  expect(before).toEqual(snapshot)
  expect(result.stateVersion).toBe(before.stateVersion + 1)
  expect(createPokerState(result)).toEqual(result)
  expect(Object.isFrozen(result)).toBe(true)
  expect(Object.isFrozen(result.seats)).toBe(true)
  expect(Object.isFrozen(result.hand)).toBe(true)

  return result
}

describe('applyPokerAction', () => {
  test('selects the next clockwise participant who still owes action', () => {
    const baseline = createProgressionState('preflop')
    const state = createProgressionState('preflop', {
      actorSeatNumber: 3,
      seats: baseline.seats.map((seat) => {
        if (seat.seatNumber === 1) {
          return { ...seat, status: 'folded' as const }
        }
        if (seat.seatNumber === 2) {
          return {
            ...seat,
            status: 'allIn' as const,
            stack: 0,
            streetContribution: 20,
            totalContribution: 20,
          }
        }
        if (seat.seatNumber === 4) {
          return {
            ...seat,
            streetContribution: 20,
            totalContribution: 20,
            stack: 1980,
          }
        }

        return seat
      }),
      seatLevels: { 1: 20, 2: 20, 3: null, 4: 0, 5: null, 0: 20 },
    })

    const result = expectStableSuccess(state, {
      actorSeatNumber: 3,
      action: { type: 'call' },
    })

    expect(result.hand?.street).toBe('preflop')
    expect(result.hand?.currentActorSeatNumber).toBe(5)
  })

  test('advances preflop to the literal deterministic flop and resets betting', () => {
    const baseline = createProgressionState('preflop')
    const matchedSeats = baseline.seats.map((seat) => ({
      ...seat,
      stack: 1980,
      streetContribution: 20,
      totalContribution: 20,
    }))
    const state = createProgressionState('preflop', {
      actorSeatNumber: 2,
      seats: matchedSeats,
      seatLevels: { 1: 20, 2: null, 3: 20, 4: 20, 5: 20, 0: 20 },
    })
    const totalContributionsBefore = state.seats.map(
      (seat) => seat.totalContribution,
    )

    const result = expectStableSuccess(state, {
      actorSeatNumber: 2,
      action: { type: 'check' },
    })

    expect(result.hand).toMatchObject({
      street: 'flop',
      board: [
        { rank: '2', suit: 'diamonds' },
        { rank: '3', suit: 'diamonds' },
        { rank: '4', suit: 'diamonds' },
      ],
      burnedCards: [{ rank: 'A', suit: 'clubs' }],
      currentActorSeatNumber: 1,
      bettingRound: {
        currentBet: 0,
        minimumFullRaiseIncrement: 20,
      },
    })
    expect(result.seats.every((seat) => seat.streetContribution === 0)).toBe(
      true,
    )
    expect(
      result.hand?.bettingRound?.seatStates.every(
        (seatState) => seatState.betLevelAfterLastAction === null,
      ),
    ).toBe(true)
    expect(result.seats.map((seat) => seat.totalContribution)).toEqual(
      totalContributionsBefore,
    )
    expect(result.hand?.pot).toBe(120)
  })

  test.each([
    {
      street: 'flop' as const,
      expectedStreet: 'turn',
      expectedBoard: [
        { rank: '2', suit: 'diamonds' },
        { rank: '3', suit: 'diamonds' },
        { rank: '4', suit: 'diamonds' },
        { rank: '6', suit: 'diamonds' },
      ],
      expectedBurnedCards: [
        { rank: 'A', suit: 'clubs' },
        { rank: '5', suit: 'diamonds' },
      ],
    },
    {
      street: 'turn' as const,
      expectedStreet: 'river',
      expectedBoard: [
        { rank: '2', suit: 'diamonds' },
        { rank: '3', suit: 'diamonds' },
        { rank: '4', suit: 'diamonds' },
        { rank: '6', suit: 'diamonds' },
        { rank: '8', suit: 'diamonds' },
      ],
      expectedBurnedCards: [
        { rank: 'A', suit: 'clubs' },
        { rank: '5', suit: 'diamonds' },
        { rank: '7', suit: 'diamonds' },
      ],
    },
  ])(
    'advances $street to $expectedStreet',
    ({ street, expectedStreet, expectedBoard, expectedBurnedCards }) => {
      const baseline = createProgressionState(street)
      const seatsWithHistoricalContributions = baseline.seats.map((seat) => ({
        ...seat,
        stack: 1950,
        streetContribution: 20,
        totalContribution: 50,
      }))
      const state = createProgressionState(street, {
        actorSeatNumber: 0,
        seats: seatsWithHistoricalContributions,
        currentBet: 20,
        seatLevels: { 1: 20, 2: 20, 3: 20, 4: 20, 5: 20, 0: null },
      })
      const potBefore = state.hand?.pot
      const totalContributionsBefore = state.seats.map(
        (seat) => seat.totalContribution,
      )

      const result = expectStableSuccess(state, {
        actorSeatNumber: 0,
        action: { type: 'check' },
      })

      expect(result.hand?.street).toBe(expectedStreet)
      expect(result.hand?.board).toEqual(expectedBoard)
      expect(result.hand?.burnedCards).toEqual(expectedBurnedCards)
      expect(result.hand?.currentActorSeatNumber).toBe(1)
      expect(result.hand?.pot).toBe(potBefore)
      expect(result.seats.every((seat) => seat.streetContribution === 0)).toBe(
        true,
      )
      expect(result.seats.map((seat) => seat.totalContribution)).toEqual(
        totalContributionsBefore,
      )
      expect(result.hand?.bettingRound).toEqual({
        currentBet: 0,
        minimumFullRaiseIncrement: 20,
        seatStates: PARTICIPANTS.map((seatNumber) => ({
          seatNumber,
          betLevelAfterLastAction: null,
        })),
      })
    },
  )

  test('ends a completed river betting round at showdown without another runout', () => {
    const state = createProgressionState('river', {
      actorSeatNumber: 0,
      seatLevels: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 0: null },
    })
    const boardBefore = state.hand?.board
    const remainingDeckBefore = state.hand?.remainingDeck

    const result = expectStableSuccess(state, {
      actorSeatNumber: 0,
      action: { type: 'check' },
    })

    expect(result.hand).toMatchObject({
      street: 'showdown',
      currentActorSeatNumber: null,
      bettingRound: null,
      board: boardBefore,
      remainingDeck: remainingDeckBefore,
    })
  })

  test('enters complete without consuming cards when one contender remains', () => {
    const baseline = createProgressionState('preflop')
    const state = createProgressionState('preflop', {
      actorSeatNumber: 3,
      seats: baseline.seats.map((seat) =>
        seat.seatNumber === 2
          ? seat
          : {
              ...seat,
              status:
                seat.seatNumber === 3
                  ? ('active' as const)
                  : ('folded' as const),
            },
      ),
    })
    const remainingDeckBefore = state.hand?.remainingDeck
    const burnedCardsBefore = state.hand?.burnedCards
    const potBefore = state.hand?.pot
    const chipStateBefore = state.seats.map(
      ({ seatNumber, stack, streetContribution, totalContribution }) => ({
        seatNumber,
        stack,
        streetContribution,
        totalContribution,
      }),
    )

    const result = expectStableSuccess(state, {
      actorSeatNumber: 3,
      action: { type: 'fold' },
    })

    expect(result.hand).toMatchObject({
      street: 'complete',
      currentActorSeatNumber: null,
      bettingRound: null,
      board: [],
      remainingDeck: remainingDeckBefore,
    })
    expect(result.hand?.pot).toBe(potBefore)
    expect(result.hand?.burnedCards).toEqual(burnedCardsBefore)
    expect(
      result.seats.map(
        ({ seatNumber, stack, streetContribution, totalContribution }) => ({
          seatNumber,
          stack,
          streetContribution,
          totalContribution,
        }),
      ),
    ).toEqual(chipStateBefore)
  })

  test('uses the matchable call amount then runs out from preflop', () => {
    const baseline = createProgressionState('preflop')
    const state = createProgressionState('preflop', {
      actorSeatNumber: 3,
      seats: baseline.seats.map((seat) => {
        if (seat.seatNumber === 2) {
          return {
            ...seat,
            stack: 0,
            status: 'allIn' as const,
            streetContribution: 7,
            totalContribution: 7,
          }
        }
        if (seat.seatNumber === 3) {
          return {
            ...seat,
            stack: 100,
            streetContribution: 0,
            totalContribution: 0,
          }
        }

        return {
          ...seat,
          status: 'folded' as const,
          streetContribution: 0,
          totalContribution: 0,
        }
      }),
      currentBet: 20,
    })

    const result = expectStableSuccess(state, {
      actorSeatNumber: 3,
      action: { type: 'call' },
    })
    const actor = result.seats.find((seat) => seat.seatNumber === 3)

    expect(actor).toMatchObject({
      stack: 93,
      streetContribution: 7,
      totalContribution: 7,
    })
    expect(result.hand).toMatchObject({
      street: 'showdown',
      pot: 14,
      currentActorSeatNumber: null,
      bettingRound: null,
      board: [
        { rank: '2', suit: 'diamonds' },
        { rank: '3', suit: 'diamonds' },
        { rank: '4', suit: 'diamonds' },
        { rank: '6', suit: 'diamonds' },
        { rank: '8', suit: 'diamonds' },
      ],
    })
  })

  test.each(['flop', 'turn'] as const)(
    'runs out from %s after the last actionable player makes an all-in call',
    (street) => {
      const baseline = createProgressionState(street)
      const state = createProgressionState(street, {
        actorSeatNumber: 3,
        seats: baseline.seats.map((seat) => {
          if (seat.seatNumber === 2) {
            return {
              ...seat,
              stack: 0,
              status: 'allIn' as const,
              streetContribution: 10,
              totalContribution: 10,
            }
          }
          if (seat.seatNumber === 3) {
            return {
              ...seat,
              stack: 5,
              streetContribution: 0,
              totalContribution: 0,
            }
          }

          return {
            ...seat,
            status: 'folded' as const,
            streetContribution: 0,
            totalContribution: 0,
          }
        }),
        currentBet: 10,
      })

      const result = expectStableSuccess(state, {
        actorSeatNumber: 3,
        action: { type: 'allIn' },
      })

      expect(result.seats.find((seat) => seat.seatNumber === 3)).toMatchObject({
        status: 'allIn',
        stack: 0,
        streetContribution: 5,
        totalContribution: 5,
      })
      expect(result.hand).toMatchObject({
        street: 'showdown',
        pot: 15,
        currentActorSeatNumber: null,
        bettingRound: null,
        board: [
          { rank: '2', suit: 'diamonds' },
          { rank: '3', suit: 'diamonds' },
          { rank: '4', suit: 'diamonds' },
          { rank: '6', suit: 'diamonds' },
          { rank: '8', suit: 'diamonds' },
        ],
      })
    },
  )

  test('rejects a command when only one contender already remains', () => {
    const baseline = createProgressionState('preflop')
    const state = createProgressionState('preflop', {
      actorSeatNumber: 3,
      seats: baseline.seats.map((seat) => ({
        ...seat,
        status:
          seat.seatNumber === 3 ? ('active' as const) : ('folded' as const),
      })),
    })

    expect(() =>
      applyPokerAction(state, {
        actorSeatNumber: 3,
        action: { type: 'fold' },
      }),
    ).toThrow(/无需继续行动/)
  })

  test('rejects a command when the only actionable player has no matchable call', () => {
    const baseline = createProgressionState('preflop')
    const state = createProgressionState('preflop', {
      actorSeatNumber: 3,
      seats: baseline.seats.map((seat) => {
        if (seat.seatNumber === 2) {
          return {
            ...seat,
            stack: 0,
            status: 'allIn' as const,
            streetContribution: 7,
            totalContribution: 7,
          }
        }
        if (seat.seatNumber === 3) {
          return {
            ...seat,
            stack: 90,
            streetContribution: 10,
            totalContribution: 10,
          }
        }

        return {
          ...seat,
          status: 'folded' as const,
          streetContribution: 0,
          totalContribution: 0,
        }
      }),
    })

    expect(() =>
      applyPokerAction(state, {
        actorSeatNumber: 3,
        action: { type: 'fold' },
      }),
    ).toThrow(/无需继续行动/)
  })

  test('rejects commands on terminal streets', () => {
    const river = createProgressionState('river')
    const terminal = createPokerState({
      ...river,
      hand: {
        ...river.hand,
        street: 'showdown',
        currentActorSeatNumber: null,
        bettingRound: null,
      },
    })

    expect(() =>
      applyPokerAction(terminal, {
        actorSeatNumber: 1,
        action: { type: 'check' },
      }),
    ).toThrow(/下注街道/)
  })
})
