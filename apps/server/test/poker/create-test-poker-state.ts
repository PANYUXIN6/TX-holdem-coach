import {
  createPokerTableState,
  type PokerTableState,
  type PokerTableStateInput,
} from '../../src/poker/state.js'

type DeepPartial<Value> = Value extends readonly (infer Item)[]
  ? readonly DeepPartial<Item>[]
  : Value extends object
    ? { [Key in keyof Value]?: DeepPartial<Value[Key]> }
    : Value

const SIX_PLAYER_BASELINE: PokerTableStateInput = {
  pokerPhase: 'betweenHands',
  seats: [
    {
      seatNumber: 0,
      playerId: '00000000-0000-4000-8000-000000000001',
      isUser: true,
      stack: 2000,
      status: 'active',
      streetContribution: 0,
      totalContribution: 0,
    },
    {
      seatNumber: 1,
      playerId: '00000000-0000-4000-8000-000000000002',
      isUser: false,
      stack: 2000,
      status: 'active',
      streetContribution: 0,
      totalContribution: 0,
    },
    {
      seatNumber: 2,
      playerId: '00000000-0000-4000-8000-000000000003',
      isUser: false,
      stack: 2000,
      status: 'active',
      streetContribution: 0,
      totalContribution: 0,
    },
    {
      seatNumber: 3,
      playerId: '00000000-0000-4000-8000-000000000004',
      isUser: false,
      stack: 2000,
      status: 'active',
      streetContribution: 0,
      totalContribution: 0,
    },
    {
      seatNumber: 4,
      playerId: '00000000-0000-4000-8000-000000000005',
      isUser: false,
      stack: 2000,
      status: 'active',
      streetContribution: 0,
      totalContribution: 0,
    },
    {
      seatNumber: 5,
      playerId: '00000000-0000-4000-8000-000000000006',
      isUser: false,
      stack: 2000,
      status: 'active',
      streetContribution: 0,
      totalContribution: 0,
    },
  ],
  buttonSeatNumber: 0,
  blinds: { smallBlind: 10, bigBlind: 20 },
  hand: null,
}

const SIX_PLAYER_BETTING_BASELINE = {
  pokerPhase: 'inHand',
  seats: SIX_PLAYER_BASELINE.seats.map((seat) => {
    if (seat.seatNumber === 1) {
      return {
        ...seat,
        stack: 1990,
        streetContribution: 10,
        totalContribution: 10,
      }
    }

    if (seat.seatNumber === 2) {
      return {
        ...seat,
        stack: 1980,
        streetContribution: 20,
        totalContribution: 20,
      }
    }

    return { ...seat }
  }),
  buttonSeatNumber: 0,
  blinds: { smallBlind: 10, bigBlind: 20 },
  hand: {
    handId: '10000000-0000-4000-8000-000000000001',
    street: 'preflop',
    remainingDeck: [],
    burnedCards: [],
    board: [],
    holeCards: [
      {
        seatNumber: 1,
        cards: [
          { rank: 'Q', suit: 'hearts' },
          { rank: 'J', suit: 'hearts' },
        ],
      },
      {
        seatNumber: 2,
        cards: [
          { rank: 'T', suit: 'clubs' },
          { rank: '9', suit: 'clubs' },
        ],
      },
      {
        seatNumber: 3,
        cards: [
          { rank: '8', suit: 'diamonds' },
          { rank: '7', suit: 'diamonds' },
        ],
      },
      {
        seatNumber: 4,
        cards: [
          { rank: '6', suit: 'spades' },
          { rank: '5', suit: 'spades' },
        ],
      },
      {
        seatNumber: 5,
        cards: [
          { rank: '4', suit: 'hearts' },
          { rank: '3', suit: 'hearts' },
        ],
      },
      {
        seatNumber: 0,
        cards: [
          { rank: 'A', suit: 'spades' },
          { rank: 'K', suit: 'spades' },
        ],
      },
    ],
    currentActorSeatNumber: 3,
    pot: 30,
    bettingRound: {
      currentBet: 20,
      minimumFullRaiseIncrement: 20,
      seatStates: [1, 2, 3, 4, 5, 0].map((seatNumber) => ({
        seatNumber,
        betLevelAfterLastAction: null,
      })),
    },
  },
} satisfies PokerTableStateInput

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function mergeTestState(base: unknown, overrides: unknown): unknown {
  if (overrides === undefined) {
    return structuredClone(base)
  }

  if (Array.isArray(overrides)) {
    return structuredClone(overrides)
  }

  if (isRecord(base) && isRecord(overrides)) {
    const merged: Record<string, unknown> = structuredClone(base)

    for (const [key, overrideValue] of Object.entries(overrides)) {
      merged[key] = mergeTestState(base[key], overrideValue)
    }

    return merged
  }

  return structuredClone(overrides)
}

export function createTestPokerState(
  overrides: DeepPartial<PokerTableStateInput> = {},
): PokerTableState {
  return createPokerTableState(mergeTestState(SIX_PLAYER_BASELINE, overrides))
}

export function createTestBettingPokerState(
  overrides: DeepPartial<PokerTableStateInput> = {},
): PokerTableState {
  return createPokerTableState(
    mergeTestState(SIX_PLAYER_BETTING_BASELINE, overrides),
  )
}
