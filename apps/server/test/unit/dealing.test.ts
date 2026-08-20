import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { STANDARD_DECK } from '../../src/poker/cards.js'
import {
  dealFlop,
  dealPreflop,
  dealRiver,
  dealTurn,
  runoutRemainingBoard,
  shuffleStandardDeck,
} from '../../src/poker/dealing.js'
import { SECURE_RANDOM_SOURCE } from '../../src/poker/random-source.js'
import { createPokerTableState } from '../../src/poker/state.js'
import { createTestPokerState } from '../poker/create-test-poker-state.js'

function standardPureDeck() {
  return STANDARD_DECK.map((card) => ({
    rank: card.rank,
    suit: card.suit,
  }))
}

describe('shuffleStandardDeck', () => {
  test('uses the fixed Fisher–Yates contract without mutating the standard deck', () => {
    const requestedBounds: number[] = []
    const shuffled = shuffleStandardDeck({
      nextInt(maxExclusive) {
        requestedBounds.push(maxExclusive)
        return 0
      },
    })

    expect(requestedBounds).toEqual(
      Array.from({ length: 51 }, (_, index) => 52 - index),
    )
    expect(shuffled).toHaveLength(52)
    expect(shuffled[0]).toEqual({
      rank: STANDARD_DECK[1]?.rank,
      suit: STANDARD_DECK[1]?.suit,
    })
    expect(shuffled[51]).toEqual({
      rank: STANDARD_DECK[0]?.rank,
      suit: STANDARD_DECK[0]?.suit,
    })
    expect(shuffled.every((card) => !('code' in card))).toBe(true)
    expect(STANDARD_DECK[0]).toMatchObject({
      rank: '2',
      suit: 'clubs',
    })
  })
})

describe('dealPreflop', () => {
  test.each([
    {
      playerCount: 6,
      buttonSeatNumber: 8,
      participantSeatNumbers: [3, 8, 0, 6, 1, 5],
      expectedSeatOrder: [0, 1, 3, 5, 6, 8],
    },
    {
      playerCount: 7,
      buttonSeatNumber: 5,
      participantSeatNumbers: [7, 2, 0, 5, 8, 3, 6],
      expectedSeatOrder: [6, 7, 8, 0, 2, 3, 5],
    },
    {
      playerCount: 8,
      buttonSeatNumber: 7,
      participantSeatNumbers: [8, 5, 0, 7, 1, 2, 3, 6],
      expectedSeatOrder: [8, 0, 1, 2, 3, 5, 6, 7],
    },
    {
      playerCount: 9,
      buttonSeatNumber: 6,
      participantSeatNumbers: [4, 8, 1, 6, 0, 7, 2, 5, 3],
      expectedSeatOrder: [7, 8, 0, 1, 2, 3, 4, 5, 6],
    },
  ])(
    'deals a button-relative two-card sequence for a $playerCount-player table',
    ({ buttonSeatNumber, participantSeatNumbers, expectedSeatOrder }) => {
      const shuffledDeck = standardPureDeck()
      const dealt = dealPreflop({
        shuffledDeck,
        buttonSeatNumber,
        participantSeatNumbers,
      })

      expect(dealt.participantSeatNumbers).toEqual(expectedSeatOrder)
      expect(dealt.holeCards).toEqual(
        expectedSeatOrder.map((seatNumber, index) => ({
          seatNumber,
          cards: [
            shuffledDeck[index],
            shuffledDeck[index + expectedSeatOrder.length],
          ],
        })),
      )
      expect(dealt.burnedCards).toEqual([])
      expect(dealt.board).toEqual([])
      expect(dealt.remainingDeck).toEqual(
        shuffledDeck.slice(expectedSeatOrder.length * 2),
      )
      expect(dealt.shuffledDeck).toEqual(shuffledDeck)
      expect(shuffledDeck[0]).toEqual({ rank: '2', suit: 'clubs' })
    },
  )
})

describe('community-card streets', () => {
  test('burns before each street and matches a full runout', () => {
    const shuffledDeck = standardPureDeck()
    const preflop = dealPreflop({
      shuffledDeck,
      buttonSeatNumber: 0,
      participantSeatNumbers: [0, 1, 2, 3, 4, 5],
    })
    const flop = dealFlop(preflop)
    const turn = dealTurn(flop)
    const river = dealRiver(turn)
    const runoutFromPreflop = runoutRemainingBoard(preflop)
    const runoutFromFlop = runoutRemainingBoard(flop)
    const runoutFromTurn = runoutRemainingBoard(turn)

    expect(flop.burnedCards).toEqual([shuffledDeck[12]])
    expect(flop.board).toEqual([
      shuffledDeck[13],
      shuffledDeck[14],
      shuffledDeck[15],
    ])
    expect(turn.burnedCards).toEqual([shuffledDeck[12], shuffledDeck[16]])
    expect(turn.board).toEqual([
      shuffledDeck[13],
      shuffledDeck[14],
      shuffledDeck[15],
      shuffledDeck[17],
    ])
    expect(river.burnedCards).toEqual([
      shuffledDeck[12],
      shuffledDeck[16],
      shuffledDeck[18],
    ])
    expect(river.board).toEqual([
      shuffledDeck[13],
      shuffledDeck[14],
      shuffledDeck[15],
      shuffledDeck[17],
      shuffledDeck[19],
    ])
    expect(river.remainingDeck).toEqual(shuffledDeck.slice(20))
    expect(runoutFromPreflop).toEqual(river)
    expect(runoutFromFlop).toEqual(river)
    expect(runoutFromFlop.burnedCards.slice(flop.burnedCards.length)).toEqual([
      shuffledDeck[16],
      shuffledDeck[18],
    ])
    expect(runoutFromTurn).toEqual(river)
    expect(runoutFromTurn.burnedCards.slice(turn.burnedCards.length)).toEqual([
      shuffledDeck[18],
    ])
    expect(preflop.board).toEqual([])
    expect(preflop.burnedCards).toEqual([])
  })

  test('rejects out-of-order streets, repeated streets, completed runouts, and broken traces', () => {
    const preflop = dealPreflop({
      shuffledDeck: standardPureDeck(),
      buttonSeatNumber: 0,
      participantSeatNumbers: [0, 1, 2, 3, 4, 5],
    })
    const flop = dealFlop(preflop)
    const river = runoutRemainingBoard(preflop)

    expect(() => dealTurn(preflop)).toThrow()
    expect(() => dealFlop(flop)).toThrow()
    expect(() => runoutRemainingBoard(river)).toThrow()
    expect(() =>
      dealTurn({
        ...flop,
        board: [...flop.board].reverse(),
      }),
    ).toThrow()
    expect(() =>
      dealFlop({
        ...preflop,
        remainingDeck: preflop.remainingDeck.slice(4),
      }),
    ).toThrow()
  })
})

describe('dealing input boundaries', () => {
  test('rejects invalid random source values and invalid participant sets', () => {
    expect(() => shuffleStandardDeck({ nextInt: () => 52 })).toThrow()
    expect(() => shuffleStandardDeck({ nextInt: () => 0.5 })).toThrow()
    expect(() => SECURE_RANDOM_SOURCE.nextInt(0)).toThrow()

    const shuffledDeck = standardPureDeck()
    const invalidInputs = [
      { buttonSeatNumber: 0, participantSeatNumbers: [0, 1, 2, 3, 4] },
      {
        buttonSeatNumber: 0,
        participantSeatNumbers: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      },
      { buttonSeatNumber: 6, participantSeatNumbers: [0, 1, 2, 3, 4, 5] },
      { buttonSeatNumber: 0, participantSeatNumbers: [0, 1, 2, 3, 4, 4] },
      { buttonSeatNumber: 0, participantSeatNumbers: [0, 1, 2, 3, 4, 9] },
    ]

    for (const input of invalidInputs) {
      expect(() => dealPreflop({ shuffledDeck, ...input })).toThrow()
    }
  })

  test('rejects malformed and duplicate decks without mutating caller input', () => {
    const shuffledDeck = standardPureDeck()
    const beforeDealing = structuredClone(shuffledDeck)

    expect(() =>
      dealPreflop({
        shuffledDeck: [
          { rank: '1', suit: 'clubs' },
          ...shuffledDeck.slice(1),
        ] as typeof shuffledDeck,
        buttonSeatNumber: 0,
        participantSeatNumbers: [0, 1, 2, 3, 4, 5],
      }),
    ).toThrow()
    expect(() =>
      dealPreflop({
        shuffledDeck: [
          shuffledDeck[0]!,
          shuffledDeck[0]!,
          ...shuffledDeck.slice(2),
        ],
        buttonSeatNumber: 0,
        participantSeatNumbers: [0, 1, 2, 3, 4, 5],
      }),
    ).toThrow()

    const preflop = dealPreflop({
      shuffledDeck,
      buttonSeatNumber: 0,
      participantSeatNumbers: [0, 1, 2, 3, 4, 5],
    })
    dealFlop(preflop)

    expect(shuffledDeck).toEqual(beforeDealing)
    expect(preflop.board).toEqual([])
    expect(preflop.burnedCards).toEqual([])
  })

  test('keeps all dealing output compatible with the private state constructor', () => {
    const dealt = runoutRemainingBoard(
      dealPreflop({
        shuffledDeck: shuffleStandardDeck({ nextInt: () => 0 }),
        buttonSeatNumber: 0,
        participantSeatNumbers: [0, 1, 2, 3, 4, 5],
      }),
    )
    const baseState = createTestPokerState()

    expect(() =>
      createPokerTableState({
        ...baseState,
        pokerPhase: 'inHand',
        hand: {
          handId: '10000000-0000-4000-8000-000000000002',
          street: 'river',
          remainingDeck: dealt.remainingDeck,
          burnedCards: dealt.burnedCards,
          board: dealt.board,
          holeCards: dealt.holeCards,
          currentActorSeatNumber: 0,
          pot: 0,
          bettingRound: {
            currentBet: 0,
            minimumFullRaiseIncrement: 20,
            seatStates: dealt.holeCards.map(({ seatNumber }) => ({
              seatNumber,
              betLevelAfterLastAction: null,
            })),
          },
        },
      }),
    ).not.toThrow()
  })
})

describe('dealing invariants', () => {
  test('keeps every pure card exactly once across dealt, burned, board, and remaining areas', () => {
    const participantSet = fc
      .uniqueArray(fc.integer({ min: 0, max: 8 }), {
        minLength: 6,
        maxLength: 9,
      })
      .chain((participantSeatNumbers) =>
        fc
          .integer({ min: 0, max: participantSeatNumbers.length - 1 })
          .map((buttonIndex) => ({
            buttonSeatNumber: participantSeatNumbers[buttonIndex]!,
            participantSeatNumbers,
          })),
      )

    fc.assert(
      fc.property(
        participantSet,
        ({ buttonSeatNumber, participantSeatNumbers }) => {
          const shuffledDeck = standardPureDeck()
          const finalHand = runoutRemainingBoard(
            dealPreflop({
              shuffledDeck,
              buttonSeatNumber,
              participantSeatNumbers,
            }),
          )
          const deckConsumption = [
            ...finalHand.holeCards.map((holeCards) => holeCards.cards[0]),
            ...finalHand.holeCards.map((holeCards) => holeCards.cards[1]),
            finalHand.burnedCards[0],
            ...finalHand.board.slice(0, 3),
            finalHand.burnedCards[1],
            finalHand.board[3],
            finalHand.burnedCards[2],
            finalHand.board[4],
            ...finalHand.remainingDeck,
          ]

          expect(finalHand.holeCards).toHaveLength(
            participantSeatNumbers.length,
          )
          expect(finalHand.burnedCards).toHaveLength(3)
          expect(finalHand.board).toHaveLength(5)
          expect(deckConsumption).toEqual(finalHand.shuffledDeck)
          expect(finalHand.shuffledDeck).toEqual(shuffledDeck)
        },
      ),
      { numRuns: 100, verbose: true },
    )
  })
})
