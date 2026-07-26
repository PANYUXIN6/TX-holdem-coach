import { describe, expect, test } from 'vitest'
import { PokerCommandSchema } from '../../src/poker/commands.js'
import { createPokerState } from '../../src/poker/state.js'
import { createTestPokerState } from '../poker/create-test-poker-state.js'

const REPRESENTATIVE_HAND = {
  handId: '10000000-0000-4000-8000-000000000001',
  street: 'preflop',
  remainingDeck: [],
  burnedCards: [],
  board: [],
  holeCards: [],
  currentActorSeatNumber: 0,
  pot: 0,
} as const

describe('private poker state', () => {
  test('constructs a representative state that can be JSON serialized', () => {
    const baseline = createTestPokerState({ stateVersion: 3 })
    const state = createPokerState({ ...baseline, stateVersion: 4 })

    const serialized = JSON.parse(JSON.stringify(state)) as {
      stateVersion: number
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
      stateVersion: 4,
      pokerPhase: 'betweenHands',
      buttonSeatNumber: 0,
      blinds: { smallBlind: 10, bigBlind: 20 },
      hand: null,
    })
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

    expect(() => createPokerState(duplicateSeatState)).toThrow()
  })

  test('rejects duplicate player identities at the domain entry point', () => {
    const baseline = createTestPokerState()
    const duplicatePlayerState = {
      ...baseline,
      seats: baseline.seats.map((seat, index) =>
        index === 1 ? { ...seat, playerId: baseline.seats[0]?.playerId } : seat,
      ),
    }

    expect(() => createPokerState(duplicatePlayerState)).toThrow()
  })

  test('requires exactly one local user seat', () => {
    const baseline = createTestPokerState()
    const noUserState = {
      ...baseline,
      seats: baseline.seats.map((seat) => ({ ...seat, isUser: false })),
    }

    expect(() => createPokerState(noUserState)).toThrow()
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

    expect(() => createPokerState(swappedUserAndAiSeats)).toThrow()
  })

  test('requires the button to reference an existing seat', () => {
    const baseline = createTestPokerState()

    expect(() =>
      createPokerState({ ...baseline, buttonSeatNumber: 8 }),
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

    expect(() => createPokerState(fractionalStackState)).toThrow()
    expect(() => createPokerState(unmatchedContributionState)).toThrow()
  })

  test('rejects poker phases that do not agree with whether a hand exists', () => {
    const baseline = createTestPokerState()

    expect(() =>
      createPokerState({ ...baseline, hand: REPRESENTATIVE_HAND }),
    ).toThrow()
    expect(() =>
      createPokerState({ ...baseline, pokerPhase: 'inHand', hand: null }),
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

    expect(() => createPokerState(contributionBetweenHands)).toThrow()
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

    expect(() => createPokerState(duplicateCardHand)).toThrow()
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

    expect(() => createPokerState(unknownHoleCardsSeat)).toThrow()
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

    expect(() => createPokerState(duplicateHoleCardsSeat)).toThrow()
  })

  test('requires the current actor to reference an existing seat', () => {
    const baseline = createTestPokerState()
    const unknownActorState = {
      ...baseline,
      pokerPhase: 'inHand' as const,
      hand: { ...REPRESENTATIVE_HAND, currentActorSeatNumber: 8 },
    }

    expect(() => createPokerState(unknownActorState)).toThrow()
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

    expect(() => createPokerState(foldedActorState)).toThrow()
  })

  test('allows no current actor only while posting blinds or resolving a hand', () => {
    const baseline = createTestPokerState()

    for (const street of ['postingBlinds', 'showdown', 'complete'] as const) {
      expect(() =>
        createPokerState({
          ...baseline,
          pokerPhase: 'inHand',
          hand: {
            ...REPRESENTATIVE_HAND,
            street,
            currentActorSeatNumber: null,
          },
        }),
      ).not.toThrow()
    }

    for (const street of ['preflop', 'flop', 'turn', 'river'] as const) {
      expect(() =>
        createPokerState({
          ...baseline,
          pokerPhase: 'inHand',
          hand: {
            ...REPRESENTATIVE_HAND,
            street,
            currentActorSeatNumber: null,
          },
        }),
      ).toThrow()
    }

    for (const street of ['postingBlinds', 'showdown', 'complete'] as const) {
      expect(() =>
        createPokerState({
          ...baseline,
          pokerPhase: 'inHand',
          hand: { ...REPRESENTATIVE_HAND, street },
        }),
      ).toThrow()
    }
  })

  test('rejects folded, all-in, and out seats as the current actor', () => {
    const baseline = createTestPokerState()

    for (const status of ['folded', 'allIn', 'out'] as const) {
      expect(() =>
        createPokerState({
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

    expect(() => createPokerState(emptyStackActorState)).toThrow()
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
      holeCards: [
        {
          seatNumber: 0,
          cards: [{ rank: 'Q', suit: 'clubs' }],
        },
      ],
    }
    input.hand = mutableHand

    const state = createPokerState(input)

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

    expect(() => createPokerState(invalidCardState)).toThrow()
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
