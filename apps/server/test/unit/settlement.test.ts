import type { Card } from '@tx-holdem-coach/contracts'
import { describe, expect, test } from 'vitest'
import { STANDARD_DECK } from '../../src/poker/cards.js'
import {
  dealFlop,
  dealPreflop,
  dealRiver,
  dealTurn,
  reconstructDealtHand,
} from '../../src/poker/dealing.js'
import { settleTerminalHand } from '../../src/poker/settlement.js'
import {
  createPokerTableState,
  type PokerTableState,
} from '../../src/poker/state.js'

const HOLE_CARDS: readonly (readonly [Card, Card])[] = [
  [
    { rank: 'A', suit: 'spades' },
    { rank: 'A', suit: 'hearts' },
  ],
  [
    { rank: 'K', suit: 'spades' },
    { rank: 'K', suit: 'hearts' },
  ],
  [
    { rank: 'Q', suit: 'spades' },
    { rank: 'Q', suit: 'hearts' },
  ],
  [
    { rank: 'J', suit: 'spades' },
    { rank: 'J', suit: 'hearts' },
  ],
  [
    { rank: 'T', suit: 'spades' },
    { rank: 'T', suit: 'hearts' },
  ],
  [
    { rank: '9', suit: 'spades' },
    { rank: '9', suit: 'hearts' },
  ],
]

const BOARD: readonly Card[] = [
  { rank: '2', suit: 'clubs' },
  { rank: '3', suit: 'diamonds' },
  { rank: '4', suit: 'clubs' },
  { rank: '6', suit: 'diamonds' },
  { rank: '8', suit: 'clubs' },
]

const TIE_BOARD: readonly Card[] = [
  { rank: 'A', suit: 'clubs' },
  { rank: 'K', suit: 'clubs' },
  { rank: 'Q', suit: 'clubs' },
  { rank: 'J', suit: 'clubs' },
  { rank: 'T', suit: 'clubs' },
]

function createTerminalState({
  contributions,
  statuses = ['active', 'active', 'active', 'active', 'active', 'active'],
  street = 'showdown',
  board,
  holeCards = HOLE_CARDS,
  burnedCards = [],
  remainingDeck = [],
  streetContributions = contributions,
}: {
  readonly contributions: readonly number[]
  readonly statuses?: readonly ('active' | 'folded' | 'allIn')[]
  readonly street?: 'showdown' | 'complete'
  readonly board?: readonly Card[]
  readonly holeCards?: readonly (readonly [Card, Card])[]
  readonly burnedCards?: readonly Card[]
  readonly remainingDeck?: readonly Card[]
  readonly streetContributions?: readonly number[]
}): PokerTableState {
  const seats = contributions.map((contribution, seatNumber) => ({
    seatNumber,
    playerId: `00000000-0000-4000-8000-00000000000${seatNumber + 1}`,
    isUser: seatNumber === 0,
    stack: 1000 - contribution,
    status: statuses[seatNumber] as 'active' | 'folded' | 'allIn',
    streetContribution: streetContributions[seatNumber] ?? contribution,
    totalContribution: contribution,
  }))

  return createPokerTableState({
    pokerPhase: 'inHand',
    seats,
    buttonSeatNumber: 0,
    blinds: { smallBlind: 10, bigBlind: 20 },
    hand: {
      handId: '10000000-0000-4000-8000-000000000001',
      street,
      remainingDeck,
      burnedCards,
      board: street === 'showdown' ? (board ?? BOARD) : [],
      holeCards: holeCards.map((cards, seatNumber) => ({
        seatNumber,
        cards,
      })),
      currentActorSeatNumber: null,
      pot: contributions.reduce(
        (total, contribution) => total + contribution,
        0,
      ),
      bettingRound: null,
    },
  })
}

describe('settleTerminalHand', () => {
  test('returns the unique unmatched highest contribution before constructing pots', () => {
    const state = createTerminalState({
      contributions: [120, 100, 50, 50, 50, 50],
    })
    const snapshot = structuredClone(state)

    const result = settleTerminalHand(state)

    expect(state).toEqual(snapshot)
    expect(result.facts.uncalledBetReturns).toEqual([
      { seatNumber: 0, amount: 20 },
    ])
    expect(result.facts.pots.map((pot) => pot.amount)).toEqual([300, 100])
    expect(
      result.facts.pots.reduce((total, pot) => total + pot.amount, 0),
    ).toBe(400)
    expect(
      result.facts.uncalledBetReturns.reduce(
        (total, returned) => total + returned.amount,
        0,
      ) + result.facts.pots.reduce((total, pot) => total + pot.amount, 0),
    ).toBe(state.hand?.pot)
    expect(result.state.seats[0]?.stack).toBe(1300)
    expect(
      result.state.seats.every((seat) => seat.totalContribution === 0),
    ).toBe(true)
  })

  test('keeps folded contributions in pots while excluding folded seats from awards', () => {
    const result = settleTerminalHand(
      createTerminalState({
        contributions: [100, 100, 50, 50, 50, 50],
        statuses: ['active', 'active', 'active', 'folded', 'folded', 'folded'],
      }),
    )

    expect(result.facts.pots[0]).toMatchObject({
      amount: 300,
      contributingSeatNumbers: [0, 1, 2, 3, 4, 5],
      eligibleSeatNumbers: [0, 1, 2],
      winningSeatNumbers: [0],
    })
    expect(result.facts.pots[1]).toMatchObject({
      amount: 100,
      contributingSeatNumbers: [0, 1],
      eligibleSeatNumbers: [0, 1],
      winningSeatNumbers: [0],
    })
  })

  test('allows the main pot and two side pots to have different winners', () => {
    const result = settleTerminalHand(
      createTerminalState({
        contributions: [300, 300, 200, 100, 100, 100],
        holeCards: [
          [
            { rank: 'Q', suit: 'spades' },
            { rank: 'Q', suit: 'hearts' },
          ],
          [
            { rank: 'J', suit: 'spades' },
            { rank: 'J', suit: 'hearts' },
          ],
          [
            { rank: 'K', suit: 'spades' },
            { rank: 'K', suit: 'hearts' },
          ],
          [
            { rank: 'A', suit: 'spades' },
            { rank: 'A', suit: 'hearts' },
          ],
          HOLE_CARDS[4] as readonly [Card, Card],
          HOLE_CARDS[5] as readonly [Card, Card],
        ],
      }),
    )

    expect(result.facts.uncalledBetReturns).toEqual([])
    expect(
      result.facts.pots.map((pot) => [pot.amount, pot.winningSeatNumbers]),
    ).toEqual([
      [600, [3]],
      [300, [2]],
      [200, [0]],
    ])
  })

  test('awards direct wins without evaluating cards', () => {
    const result = settleTerminalHand(
      createTerminalState({
        contributions: [100, 100, 100, 100, 100, 100],
        statuses: ['folded', 'active', 'folded', 'folded', 'folded', 'folded'],
        street: 'complete',
      }),
    )

    expect(result.facts.handEvaluations).toEqual([])
    expect(result.facts.pots[0]).toMatchObject({
      amount: 600,
      winningSeatNumbers: [1],
      awards: [
        { seatNumber: 1, baseAmount: 600, oddChipAmount: 0, amount: 600 },
      ],
    })
    expect(result.state.seats[1]?.stack).toBe(1500)
  })

  test('splits odd chips from the button left in clockwise participant order', () => {
    const result = settleTerminalHand(
      createTerminalState({
        contributions: [101, 101, 101, 101, 101, 0],
        statuses: ['active', 'active', 'folded', 'active', 'folded', 'folded'],
        board: TIE_BOARD,
      }),
    )

    expect(result.facts.pots).toHaveLength(1)
    expect(result.facts.pots[0]).toMatchObject({
      amount: 505,
      winningSeatNumbers: [0, 1, 3],
      awards: [
        { seatNumber: 1, baseAmount: 168, oddChipAmount: 1, amount: 169 },
        { seatNumber: 3, baseAmount: 168, oddChipAmount: 0, amount: 168 },
        { seatNumber: 0, baseAmount: 168, oddChipAmount: 0, amount: 168 },
      ],
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.facts.pots)).toBe(true)
  })

  test('assigns odd chips independently for the main pot and a side pot', () => {
    const result = settleTerminalHand(
      createTerminalState({
        contributions: [102, 102, 102, 101, 101, 0],
        statuses: ['active', 'active', 'folded', 'active', 'folded', 'folded'],
        board: TIE_BOARD,
      }),
    )

    expect(result.facts.pots.map((pot) => pot.awards)).toEqual([
      [
        { seatNumber: 1, baseAmount: 168, oddChipAmount: 1, amount: 169 },
        { seatNumber: 3, baseAmount: 168, oddChipAmount: 0, amount: 168 },
        { seatNumber: 0, baseAmount: 168, oddChipAmount: 0, amount: 168 },
      ],
      [
        { seatNumber: 1, baseAmount: 1, oddChipAmount: 1, amount: 2 },
        { seatNumber: 0, baseAmount: 1, oddChipAmount: 0, amount: 1 },
      ],
    ])
  })

  test('evaluates only seats that remain eligible for at least one pot', () => {
    const result = settleTerminalHand(
      createTerminalState({
        contributions: [100, 100, 100, 100, 100, 0],
      }),
    )

    expect(
      result.facts.handEvaluations.map((evaluation) => evaluation.seatNumber),
    ).toEqual([0, 1, 2, 3, 4])
  })

  test('preserves a complete deck audit trail and recursively freezes facts', () => {
    const shuffledDeck = STANDARD_DECK.map(({ rank, suit }) => ({ rank, suit }))
    const preflop = dealPreflop({
      shuffledDeck,
      buttonSeatNumber: 0,
      participantSeatNumbers: [0, 1, 2, 3, 4, 5],
    })
    const dealt = dealRiver(dealTurn(dealFlop(preflop)))
    const result = settleTerminalHand(
      createTerminalState({
        contributions: [100, 100, 100, 100, 100, 100],
        holeCards: [0, 1, 2, 3, 4, 5].map((seatNumber) => {
          const holeCards = dealt.holeCards.find(
            (candidate) => candidate.seatNumber === seatNumber,
          )

          if (holeCards === undefined) {
            throw new Error('发牌结果缺少参与座位底牌。')
          }

          return holeCards.cards
        }),
        board: dealt.board,
        burnedCards: dealt.burnedCards,
        remainingDeck: dealt.remainingDeck,
      }),
    )
    const holeCardsBySeatNumber = new Map(
      result.facts.hand.participants.map((participant) => [
        participant.seatNumber,
        participant.holeCards,
      ]),
    )
    const reconstructed = reconstructDealtHand({
      buttonSeatNumber: result.facts.hand.buttonSeatNumber,
      holeCards: dealt.participantSeatNumbers.map((seatNumber) => {
        const cards = holeCardsBySeatNumber.get(seatNumber)

        if (cards === undefined) {
          throw new Error('结算事实缺少参与座位底牌。')
        }

        return { seatNumber, cards }
      }),
      burnedCards: result.facts.hand.burnedCards,
      board: result.facts.hand.board,
      remainingDeck: result.facts.hand.remainingDeck,
    })

    expect(result.facts.hand.burnedCards).toHaveLength(3)
    expect(reconstructed.shuffledDeck).toEqual(shuffledDeck)
    expect(Object.isFrozen(result.facts.hand.board)).toBe(true)
    expect(Object.isFrozen(result.facts.hand.participants[0]?.holeCards)).toBe(
      true,
    )
    expect(createPokerTableState(result.state)).toEqual(result.state)
  })

  test.each([
    {
      name: 'showdown has fewer than five board cards',
      state: createTerminalState({
        contributions: [100, 100, 100, 100, 100, 100],
        board: BOARD.slice(0, 4),
      }),
    },
    {
      name: 'complete has more than one contender',
      state: createTerminalState({
        contributions: [100, 100, 100, 100, 100, 100],
        street: 'complete',
      }),
    },
  ])('rejects an invalid terminal state when $name', ({ state }) => {
    expect(() => settleTerminalHand(state)).toThrow(RangeError)
  })

  test('rejects a non-terminal street', () => {
    const state = structuredClone(
      createTerminalState({ contributions: [100, 100, 100, 100, 100, 100] }),
    ) as unknown as { hand: { street: string } }
    state.hand.street = 'river'

    expect(() =>
      settleTerminalHand(state as unknown as PokerTableState),
    ).toThrow(RangeError)
  })

  test('rejects a showdown with fewer than two contenders', () => {
    expect(() =>
      settleTerminalHand(
        createTerminalState({
          contributions: [100, 100, 100, 100, 100, 100],
          statuses: [
            'active',
            'folded',
            'folded',
            'folded',
            'folded',
            'folded',
          ],
        }),
      ),
    ).toThrow(RangeError)
  })

  test('rejects a complete state with no contenders', () => {
    expect(() =>
      settleTerminalHand(
        createTerminalState({
          contributions: [100, 100, 100, 100, 100, 100],
          statuses: [
            'folded',
            'folded',
            'folded',
            'folded',
            'folded',
            'folded',
          ],
          street: 'complete',
        }),
      ),
    ).toThrow(RangeError)
  })

  test('rejects a terminal state whose pot differs from total contributions', () => {
    const state = structuredClone(
      createTerminalState({ contributions: [100, 100, 100, 100, 100, 100] }),
    ) as unknown as { hand: { pot: number } }
    state.hand.pot = 599

    expect(() =>
      settleTerminalHand(state as unknown as PokerTableState),
    ).toThrow(RangeError)
  })

  test('rejects an unmatched highest contribution from a folded seat', () => {
    expect(() =>
      settleTerminalHand(
        createTerminalState({
          contributions: [120, 100, 50, 50, 50, 50],
          statuses: [
            'folded',
            'active',
            'active',
            'active',
            'active',
            'active',
          ],
        }),
      ),
    ).toThrow(RangeError)
  })

  test('rejects an unmatched return that exceeds the final street contribution', () => {
    expect(() =>
      settleTerminalHand(
        createTerminalState({
          contributions: [120, 100, 50, 50, 50, 50],
          streetContributions: [10, 100, 50, 50, 50, 50],
        }),
      ),
    ).toThrow(RangeError)
  })
})
