import { describe, expect, test } from 'vitest'
import { ZodError } from 'zod'
import { PokerCommandSchema } from '../../src/poker/commands.js'
import { createPokerTableState } from '../../src/poker/state.js'
import {
  createTestBettingPokerState,
  createTestPokerState,
} from '../poker/create-test-poker-state.js'

const REPRESENTATIVE_HAND = {
  handId: '10000000-0000-4000-8000-000000000001',
  street: 'preflop',
  remainingDeck: [],
  burnedCards: [],
  board: [],
  holeCards: [1, 2, 3, 4, 5, 0].map((seatNumber) => ({
    seatNumber,
    cards: [],
  })),
  currentActorSeatNumber: 0,
  pot: 0,
  bettingRound: {
    currentBet: 20,
    minimumFullRaiseIncrement: 20,
    seatStates: [1, 2, 3, 4, 5, 0].map((seatNumber) => ({
      seatNumber,
      betLevelAfterLastAction: null,
    })),
  },
} as const

function createSevenSeatBettingState() {
  const baseline = createTestBettingPokerState()
  const hand = baseline.hand

  if (hand === null || hand.bettingRound === null) {
    throw new Error('预期测试夹具包含稳定下注轮。')
  }

  return {
    ...baseline,
    seats: [
      ...baseline.seats,
      {
        seatNumber: 6,
        playerId: '00000000-0000-4000-8000-000000000007',
        isUser: false,
        stack: 2000,
        status: 'active' as const,
        streetContribution: 0,
        totalContribution: 0,
      },
    ],
    hand: {
      ...hand,
      holeCards: [
        ...hand.holeCards,
        {
          seatNumber: 6,
          cards: [
            { rank: '2' as const, suit: 'clubs' as const },
            { rank: '2' as const, suit: 'hearts' as const },
          ],
        },
      ],
      bettingRound: {
        ...hand.bettingRound,
        seatStates: [
          ...hand.bettingRound.seatStates,
          { seatNumber: 6, betLevelAfterLastAction: null },
        ],
      },
    },
  }
}

describe('private poker table state', () => {
  test('constructs a representative state that can be JSON serialized', () => {
    const state = createPokerTableState(createTestPokerState())

    const serialized = JSON.parse(JSON.stringify(state)) as {
      pokerPhase: string
      buttonSeatNumber: number
      blinds: { smallBlind: number; bigBlind: number }
      hand: null
      seats: Array<{
        seatNumber: number
        isUser: boolean
        stack: number
      }>
    }

    expect(serialized).toMatchObject({
      pokerPhase: 'betweenHands',
      buttonSeatNumber: 0,
      blinds: { smallBlind: 10, bigBlind: 20 },
      hand: null,
    })
    expect(serialized).not.toHaveProperty('stateVersion')
    expect(serialized.seats[0]).toMatchObject({
      seatNumber: 0,
      isUser: true,
      stack: 2000,
    })
  })

  test('rejects duplicate seat numbers at the domain entry point', () => {
    const baseline = createTestPokerState()
    const duplicateSeatState = {
      ...baseline,
      seats: baseline.seats.map((seat, index) =>
        index === 1 ? { ...seat, seatNumber: 0 } : { ...seat },
      ),
    }

    expect(() => createPokerTableState(duplicateSeatState)).toThrow()
  })

  test('rejects duplicate player identities at the domain entry point', () => {
    const baseline = createTestPokerState()
    const duplicatePlayerState = {
      ...baseline,
      seats: baseline.seats.map((seat, index) =>
        index === 1 ? { ...seat, playerId: baseline.seats[0]?.playerId } : seat,
      ),
    }

    expect(() => createPokerTableState(duplicatePlayerState)).toThrow()
  })

  test('requires exactly one local user seat', () => {
    const baseline = createTestPokerState()
    const noUserState = {
      ...baseline,
      seats: baseline.seats.map((seat) => ({ ...seat, isUser: false })),
    }

    expect(() => createPokerTableState(noUserState)).toThrow()
  })

  test('requires the user at seat zero and rejects an AI occupying that seat', () => {
    const baseline = createTestPokerState()
    const swappedUserAndAiSeats = {
      ...baseline,
      seats: baseline.seats.map((seat) => ({
        ...seat,
        isUser: seat.seatNumber === 1,
      })),
    }

    expect(() => createPokerTableState(swappedUserAndAiSeats)).toThrow()
  })

  test('requires the button to reference an existing seat', () => {
    const baseline = createTestPokerState()

    expect(() =>
      createPokerTableState({ ...baseline, buttonSeatNumber: 8 }),
    ).toThrow()
  })

  test('rejects invalid chip amounts and a total below its street contribution', () => {
    const baseline = createTestPokerState()
    const fractionalStackState = {
      ...baseline,
      seats: baseline.seats.map((seat, index) =>
        index === 0 ? { ...seat, stack: 1999.5 } : seat,
      ),
    }
    const unmatchedContributionState = {
      ...baseline,
      seats: baseline.seats.map((seat, index) =>
        index === 0
          ? { ...seat, streetContribution: 30, totalContribution: 20 }
          : seat,
      ),
    }

    expect(() => createPokerTableState(fractionalStackState)).toThrow()
    expect(() => createPokerTableState(unmatchedContributionState)).toThrow()
  })

  test('rejects poker phases that do not agree with whether a hand exists', () => {
    const baseline = createTestPokerState()

    expect(() =>
      createPokerTableState({ ...baseline, hand: REPRESENTATIVE_HAND }),
    ).toThrow()
    expect(() =>
      createPokerTableState({ ...baseline, pokerPhase: 'inHand', hand: null }),
    ).toThrow()
  })

  test('requires zero contributions outside an active hand', () => {
    const baseline = createTestPokerState()
    const contributionBetweenHands = {
      ...baseline,
      seats: baseline.seats.map((seat, index) =>
        index === 0
          ? { ...seat, streetContribution: 10, totalContribution: 10 }
          : seat,
      ),
    }

    expect(() => createPokerTableState(contributionBetweenHands)).toThrow()
  })

  test('rejects a card repeated across private hand areas', () => {
    const baseline = createTestPokerState()
    const duplicateCard = { rank: 'A', suit: 'spades' } as const
    const duplicateCardHand = {
      ...baseline,
      pokerPhase: 'inHand' as const,
      hand: {
        ...REPRESENTATIVE_HAND,
        remainingDeck: [duplicateCard],
        board: [duplicateCard],
      },
    }

    expect(() => createPokerTableState(duplicateCardHand)).toThrow()
  })

  test('requires private hole cards to reference an existing seat', () => {
    const baseline = createTestPokerState()
    const unknownHoleCardsSeat = {
      ...baseline,
      pokerPhase: 'inHand' as const,
      hand: {
        ...REPRESENTATIVE_HAND,
        holeCards: [{ seatNumber: 8, cards: [] }],
      },
    }

    expect(() => createPokerTableState(unknownHoleCardsSeat)).toThrow()
  })

  test('rejects duplicate private hole-card seat records', () => {
    const baseline = createTestPokerState()
    const duplicateHoleCardsSeat = {
      ...baseline,
      pokerPhase: 'inHand' as const,
      hand: {
        ...REPRESENTATIVE_HAND,
        holeCards: [
          { seatNumber: 0, cards: [] },
          { seatNumber: 0, cards: [] },
        ],
      },
    }

    expect(() => createPokerTableState(duplicateHoleCardsSeat)).toThrow()
  })

  test('requires the current actor to reference an existing seat', () => {
    const baseline = createTestPokerState()
    const unknownActorState = {
      ...baseline,
      pokerPhase: 'inHand' as const,
      hand: { ...REPRESENTATIVE_HAND, currentActorSeatNumber: 8 },
    }

    expect(() => createPokerTableState(unknownActorState)).toThrow()
  })

  test('requires the current actor to be an active seat', () => {
    const baseline = createTestPokerState()
    const foldedActorState = {
      ...baseline,
      pokerPhase: 'inHand' as const,
      seats: baseline.seats.map((seat, index) =>
        index === 0 ? { ...seat, status: 'folded' as const } : seat,
      ),
      hand: REPRESENTATIVE_HAND,
    }

    expect(() => createPokerTableState(foldedActorState)).toThrow()
  })

  test('constructs a stable betting round from the dedicated test fixture', () => {
    const state = createTestBettingPokerState()

    expect(state.hand?.bettingRound).toEqual({
      currentBet: 20,
      minimumFullRaiseIncrement: 20,
      seatStates: [1, 2, 3, 4, 5, 0].map((seatNumber) => ({
        seatNumber,
        betLevelAfterLastAction: null,
      })),
    })
    expect(state.hand?.pot).toBe(30)
  })

  test('allows no current actor only while posting blinds or resolving a hand', () => {
    const baseline = createTestBettingPokerState()

    for (const street of ['postingBlinds', 'showdown', 'complete'] as const) {
      expect(() =>
        createPokerTableState({
          ...baseline,
          pokerPhase: 'inHand',
          hand: {
            ...baseline.hand,
            street,
            currentActorSeatNumber: null,
            bettingRound: null,
          },
        }),
      ).not.toThrow()
    }

    for (const street of ['preflop', 'flop', 'turn', 'river'] as const) {
      expect(() =>
        createPokerTableState({
          ...baseline,
          pokerPhase: 'inHand',
          hand: {
            ...baseline.hand,
            street,
            currentActorSeatNumber: null,
          },
        }),
      ).toThrow()
    }

    for (const street of ['postingBlinds', 'showdown', 'complete'] as const) {
      expect(() =>
        createPokerTableState({
          ...baseline,
          pokerPhase: 'inHand',
          hand: { ...baseline.hand, street },
        }),
      ).toThrow()
    }
  })

  test('requires betting-round presence to agree with the hand street', () => {
    const baseline = createTestBettingPokerState()

    for (const street of ['preflop', 'flop', 'turn', 'river'] as const) {
      expect(() =>
        createPokerTableState({
          ...baseline,
          hand: { ...baseline.hand, street, bettingRound: null },
        }),
      ).toThrow()
    }

    for (const street of ['postingBlinds', 'showdown', 'complete'] as const) {
      expect(() =>
        createPokerTableState({
          ...baseline,
          hand: {
            ...baseline.hand,
            street,
            currentActorSeatNumber: null,
          },
        }),
      ).toThrow()
    }
  })

  test('requires betting seat records to match hole-card seats and order', () => {
    const baseline = createTestBettingPokerState()
    const seatStates = baseline.hand?.bettingRound?.seatStates

    if (seatStates === undefined) {
      throw new Error('预期下注状态夹具包含下注轮记录。')
    }

    const invalidSeatStates = [
      seatStates.slice(0, 5),
      [...seatStates, { seatNumber: 8, betLevelAfterLastAction: null }],
      [...seatStates].reverse(),
      seatStates.map((seatState, index) =>
        index === 1 ? { ...seatState, seatNumber: 1 } : seatState,
      ),
    ]

    for (const invalid of invalidSeatStates) {
      expect(() =>
        createPokerTableState({
          ...baseline,
          hand: {
            ...baseline.hand,
            bettingRound: {
              ...baseline.hand?.bettingRound,
              seatStates: invalid,
            },
          },
        }),
      ).toThrow()
    }
  })

  test('enforces betting-round numeric and pot invariants', () => {
    const baseline = createTestBettingPokerState()
    const invalidBettingRounds = [
      { ...baseline.hand?.bettingRound, currentBet: -1 },
      { ...baseline.hand?.bettingRound, currentBet: 20.5 },
      { ...baseline.hand?.bettingRound, minimumFullRaiseIncrement: 19 },
      {
        ...baseline.hand?.bettingRound,
        minimumFullRaiseIncrement: 20.5,
      },
      {
        ...baseline.hand?.bettingRound,
        seatStates: baseline.hand?.bettingRound?.seatStates.map(
          (seatState, index) =>
            index === 0
              ? { ...seatState, betLevelAfterLastAction: -1 }
              : seatState,
        ),
      },
      {
        ...baseline.hand?.bettingRound,
        seatStates: baseline.hand?.bettingRound?.seatStates.map(
          (seatState, index) =>
            index === 0
              ? { ...seatState, betLevelAfterLastAction: 1.5 }
              : seatState,
        ),
      },
      {
        ...baseline.hand?.bettingRound,
        seatStates: baseline.hand?.bettingRound?.seatStates.map(
          (seatState, index) =>
            index === 0
              ? { ...seatState, betLevelAfterLastAction: 21 }
              : seatState,
        ),
      },
      { ...baseline.hand?.bettingRound, currentBet: 19 },
    ]

    for (const bettingRound of invalidBettingRounds) {
      expect(() =>
        createPokerTableState({
          ...baseline,
          hand: { ...baseline.hand, bettingRound },
        }),
      ).toThrow()
    }

    expect(() =>
      createPokerTableState({
        ...baseline,
        hand: { ...baseline.hand, pot: 31 },
      }),
    ).toThrow()
  })

  test('requires every non-out seat to have hole cards', () => {
    const baseline = createSevenSeatBettingState()
    const missingParticipantHoleCards = {
      ...baseline,
      hand: {
        ...baseline.hand,
        holeCards: baseline.hand?.holeCards.filter(
          ({ seatNumber }) => seatNumber !== 5,
        ),
        bettingRound: {
          ...baseline.hand?.bettingRound,
          seatStates: baseline.hand?.bettingRound?.seatStates.filter(
            ({ seatNumber }) => seatNumber !== 5,
          ),
        },
      },
    }

    expect(() => createPokerTableState(missingParticipantHoleCards)).toThrow(
      '参与座位必须与底牌座位集合一一对应。',
    )
  })

  test('allows out seats without hole cards or contributions', () => {
    const baseline = createSevenSeatBettingState()
    const stateWithOutSeat = {
      ...baseline,
      seats: baseline.seats.map((seat) =>
        seat.seatNumber === 6
          ? { ...seat, status: 'out' as const }
          : { ...seat },
      ),
      hand: {
        ...baseline.hand,
        holeCards: baseline.hand?.holeCards.filter(
          ({ seatNumber }) => seatNumber !== 6,
        ),
        bettingRound: {
          ...baseline.hand?.bettingRound,
          seatStates: baseline.hand?.bettingRound?.seatStates.filter(
            ({ seatNumber }) => seatNumber !== 6,
          ),
        },
      },
    }

    expect(() => createPokerTableState(stateWithOutSeat)).not.toThrow()
  })

  test('reports non-participant contributions at the matching seat index', () => {
    const baseline = createSevenSeatBettingState()
    const stateWithOutContribution = {
      ...baseline,
      seats: baseline.seats.map((seat) =>
        seat.seatNumber === 6
          ? {
              ...seat,
              status: 'out' as const,
              streetContribution: 10,
              totalContribution: 10,
            }
          : { ...seat },
      ),
      hand: {
        ...baseline.hand,
        holeCards: baseline.hand?.holeCards.filter(
          ({ seatNumber }) => seatNumber !== 6,
        ),
        pot: (baseline.hand?.pot ?? 0) + 10,
        bettingRound: {
          ...baseline.hand?.bettingRound,
          seatStates: baseline.hand?.bettingRound?.seatStates.filter(
            ({ seatNumber }) => seatNumber !== 6,
          ),
        },
      },
    }

    try {
      createPokerTableState(stateWithOutContribution)
      throw new Error('预期非参与座位投入会被拒绝。')
    } catch (error) {
      if (!(error instanceof ZodError)) {
        throw error
      }

      expect(error.issues).toContainEqual(
        expect.objectContaining({
          message: '非参与座位必须为 out 且本手投入为零。',
          path: ['seats', 6],
        }),
      )
    }
  })

  test('keeps the pot conserved on terminal streets', () => {
    const baseline = createTestBettingPokerState()
    const terminalWithWrongPot = {
      ...baseline,
      hand: {
        ...baseline.hand,
        street: 'showdown' as const,
        currentActorSeatNumber: null,
        bettingRound: null,
        pot: 31,
      },
    }

    expect(() => createPokerTableState(terminalWithWrongPot)).toThrow()
  })

  test('requires an in-hand button to belong to a participant', () => {
    const baseline = createSevenSeatBettingState()
    const stateWithOutButton = {
      ...baseline,
      seats: baseline.seats.map((seat) =>
        seat.seatNumber === 0
          ? { ...seat, status: 'out' as const }
          : { ...seat },
      ),
      hand: {
        ...baseline.hand,
        holeCards: baseline.hand?.holeCards.filter(
          ({ seatNumber }) => seatNumber !== 0,
        ),
        bettingRound: {
          ...baseline.hand?.bettingRound,
          seatStates: baseline.hand?.bettingRound?.seatStates.filter(
            ({ seatNumber }) => seatNumber !== 0,
          ),
        },
      },
    }

    expect(() => createPokerTableState(stateWithOutButton)).toThrow(
      '进行中的牌局按钮必须属于参与座位。',
    )
  })

  test('requires the current actor to participate in the current hand', () => {
    const baseline = createTestBettingPokerState()
    const holeCards = baseline.hand?.holeCards.filter(
      ({ seatNumber }) => seatNumber !== 3,
    )
    const seatStates = baseline.hand?.bettingRound?.seatStates.filter(
      ({ seatNumber }) => seatNumber !== 3,
    )

    expect(() =>
      createPokerTableState({
        ...baseline,
        hand: {
          ...baseline.hand,
          holeCards,
          bettingRound: {
            ...baseline.hand?.bettingRound,
            seatStates,
          },
        },
      }),
    ).toThrow()
  })

  test('requires the nominal preflop current bet above short blind posts', () => {
    const baseline = createTestBettingPokerState()
    const shortBlindState = {
      ...baseline,
      seats: baseline.seats.map((seat) => {
        if (seat.seatNumber === 1) {
          return {
            ...seat,
            stack: 0,
            status: 'allIn' as const,
            streetContribution: 5,
            totalContribution: 5,
          }
        }
        if (seat.seatNumber === 2) {
          return {
            ...seat,
            stack: 0,
            status: 'allIn' as const,
            streetContribution: 7,
            totalContribution: 7,
          }
        }

        return seat
      }),
      hand: {
        ...baseline.hand,
        pot: 12,
      },
    }

    expect(() => createPokerTableState(shortBlindState)).not.toThrow()
    expect(() =>
      createPokerTableState({
        ...shortBlindState,
        hand: {
          ...shortBlindState.hand,
          bettingRound: {
            ...shortBlindState.hand.bettingRound,
            currentBet: 7,
          },
        },
      }),
    ).toThrow()
  })

  test('rejects folded, all-in, and out seats as the current actor', () => {
    const baseline = createTestPokerState()

    for (const status of ['folded', 'allIn', 'out'] as const) {
      expect(() =>
        createPokerTableState({
          ...baseline,
          pokerPhase: 'inHand',
          seats: baseline.seats.map((seat, index) =>
            index === 0
              ? {
                  ...seat,
                  status,
                  ...(status === 'allIn' ? { stack: 0 } : {}),
                }
              : seat,
          ),
          hand: REPRESENTATIVE_HAND,
        }),
      ).toThrow()
    }
  })

  test('requires the current actor to retain chips to act', () => {
    const baseline = createTestPokerState()
    const emptyStackActorState = {
      ...baseline,
      pokerPhase: 'inHand' as const,
      seats: baseline.seats.map((seat, index) =>
        index === 0 ? { ...seat, stack: 0 } : seat,
      ),
      hand: REPRESENTATIVE_HAND,
    }

    expect(() => createPokerTableState(emptyStackActorState)).toThrow()
  })

  test('returns a deeply frozen state without retaining mutable nested data', () => {
    const input = JSON.parse(JSON.stringify(createTestPokerState())) as {
      pokerPhase: string
      seats: Array<{ stack: number }>
      hand: null | {
        remainingDeck: Array<{ rank: string; suit: string }>
        board: Array<{ rank: string; suit: string }>
        holeCards: Array<{
          seatNumber: number
          cards: Array<{ rank: string; suit: string }>
        }>
      }
    }
    input.pokerPhase = 'inHand'
    const mutableHand = {
      ...REPRESENTATIVE_HAND,
      remainingDeck: [{ rank: 'A', suit: 'spades' }],
      board: [{ rank: 'K', suit: 'hearts' }],
      holeCards: REPRESENTATIVE_HAND.holeCards.map((holeCards, index) => ({
        ...holeCards,
        cards: index === 0 ? [{ rank: 'Q', suit: 'clubs' }] : [],
      })),
    }
    input.hand = mutableHand

    const state = createPokerTableState(input)

    input.seats[0]!.stack = 1
    mutableHand.remainingDeck[0]!.rank = '2'
    mutableHand.board[0]!.suit = 'clubs'
    mutableHand.holeCards[0]!.cards[0]!.rank = 'J'

    if (state.hand === null) {
      throw new Error('预期合法进行中状态包含当前手牌。')
    }

    const remainingCard = state.hand.remainingDeck[0]
    const boardCard = state.hand.board[0]
    const holeCardRecord = state.hand.holeCards[0]
    const holeCard = holeCardRecord?.cards[0]

    if (
      remainingCard === undefined ||
      boardCard === undefined ||
      holeCardRecord === undefined ||
      holeCard === undefined
    ) {
      throw new Error('预期合法进行中状态包含测试牌张。')
    }

    expect(Object.isFrozen(state)).toBe(true)
    expect(Object.isFrozen(state.seats)).toBe(true)
    expect(Object.isFrozen(state.seats[0])).toBe(true)
    expect(Object.isFrozen(state.blinds)).toBe(true)
    expect(Object.isFrozen(state.hand)).toBe(true)
    expect(Object.isFrozen(state.hand.remainingDeck)).toBe(true)
    expect(Object.isFrozen(state.hand.board)).toBe(true)
    expect(Object.isFrozen(state.hand.holeCards)).toBe(true)
    expect(Object.isFrozen(state.hand.holeCards[0])).toBe(true)
    expect(Object.isFrozen(state.hand.holeCards[0]?.cards)).toBe(true)
    expect(Object.isFrozen(remainingCard)).toBe(true)
    expect(Object.isFrozen(boardCard)).toBe(true)
    expect(Object.isFrozen(holeCard)).toBe(true)
    expect(state.seats[0]?.stack).toBe(2000)
    expect(remainingCard).toEqual({ rank: 'A', suit: 'spades' })
    expect(boardCard).toEqual({ rank: 'K', suit: 'hearts' })
    expect(holeCard).toEqual({ rank: 'Q', suit: 'clubs' })
  })

  test('deeply merges fixture overrides and routes invalid overrides to the domain entry', () => {
    const state = createTestPokerState({ blinds: { smallBlind: 10 } })

    expect(state.blinds).toEqual({ smallBlind: 10, bigBlind: 20 })
    expect(() => createTestPokerState({ buttonSeatNumber: 8 })).toThrow()
  })

  test('rejects invalid card words and tables outside six to nine seats', () => {
    const baseline = createTestPokerState()
    const invalidCardState = {
      ...baseline,
      pokerPhase: 'inHand' as const,
      hand: {
        ...REPRESENTATIVE_HAND,
        board: [{ rank: '1', suit: 'spades' }],
      },
    }

    expect(() => createPokerTableState(invalidCardState)).toThrow()
    expect(() =>
      createTestPokerState({ seats: baseline.seats.slice(0, 5) }),
    ).toThrow()
  })
})

describe('pure poker commands', () => {
  test('accepts the same action structure for user and AI seats', () => {
    expect(
      PokerCommandSchema.parse({
        actorSeatNumber: 0,
        action: { type: 'check' },
      }),
    ).toEqual({
      actorSeatNumber: 0,
      action: { type: 'check' },
    })
    expect(
      PokerCommandSchema.parse({
        actorSeatNumber: 1,
        action: { type: 'raise', targetStreetCommitment: 120 },
      }),
    ).toEqual({
      actorSeatNumber: 1,
      action: { type: 'raise', targetStreetCommitment: 120 },
    })
  })

  test('shares the exact target-street-commitment action contract', () => {
    for (const action of [
      { type: 'bet', target: 40 },
      { type: 'raise', target: 120 },
      { type: 'raise', amount: 120 },
      { type: 'call', targetStreetCommitment: 20 },
    ]) {
      expect(
        PokerCommandSchema.safeParse({ actorSeatNumber: 0, action }).success,
      ).toBe(false)
    }
  })

  test('rejects session-envelope fields and seats outside the table', () => {
    expect(
      PokerCommandSchema.safeParse({
        actorSeatNumber: 0,
        action: { type: 'fold' },
        sessionId: '10000000-0000-4000-8000-000000000001',
      }).success,
    ).toBe(false)
    expect(
      PokerCommandSchema.safeParse({
        actorSeatNumber: 9,
        action: { type: 'fold' },
      }).success,
    ).toBe(false)
  })
})
