import type { Card, CardRank, CardSuit } from '@tx-holdem-coach/contracts'
import { describe, expect, test } from 'vitest'
import {
  handEvaluator,
  type HandCategory,
  type HandEvaluation,
} from '../../src/poker/hand-evaluator.js'

function card(rank: CardRank, suit: CardSuit): Card {
  return { rank, suit }
}

function compareGrades(
  left: HandEvaluation['comparisonGrade'],
  right: HandEvaluation['comparisonGrade'],
): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = (left[index] as number) - (right[index] as number)
    if (difference !== 0) {
      return difference
    }
  }

  return 0
}

describe('handEvaluator.evaluate', () => {
  test('selects the best five cards from a seven-card high-card hand', () => {
    const cards: readonly Card[] = [
      { rank: 'A', suit: 'spades' },
      { rank: 'K', suit: 'hearts' },
      { rank: 'Q', suit: 'diamonds' },
      { rank: 'J', suit: 'clubs' },
      { rank: '9', suit: 'spades' },
      { rank: '4', suit: 'hearts' },
      { rank: '2', suit: 'diamonds' },
    ]

    expect(handEvaluator.evaluate(cards)).toEqual({
      category: 'highCard',
      comparisonGrade: [0, 12, 11, 10, 9, 7],
      bestFive: cards.slice(0, 5),
      displayName: '高牌',
    })
  })

  test.each<{
    name: string
    cards: readonly Card[]
    category: HandCategory
    displayName: string
    comparisonGrade: readonly number[]
    bestFiveRanks: readonly CardRank[]
  }>([
    {
      name: 'one pair',
      cards: [
        card('A', 'spades'),
        card('A', 'hearts'),
        card('K', 'diamonds'),
        card('Q', 'clubs'),
        card('9', 'spades'),
        card('4', 'hearts'),
        card('2', 'diamonds'),
      ],
      category: 'onePair',
      displayName: '一对',
      comparisonGrade: [1, 12, 11, 10, 7, 0],
      bestFiveRanks: ['A', 'A', 'K', 'Q', '9'],
    },
    {
      name: 'two pair',
      cards: [
        card('A', 'spades'),
        card('A', 'hearts'),
        card('K', 'diamonds'),
        card('K', 'clubs'),
        card('Q', 'spades'),
        card('4', 'hearts'),
        card('2', 'diamonds'),
      ],
      category: 'twoPair',
      displayName: '两对',
      comparisonGrade: [2, 12, 11, 10, 0, 0],
      bestFiveRanks: ['A', 'A', 'K', 'K', 'Q'],
    },
    {
      name: 'three of a kind',
      cards: [
        card('A', 'spades'),
        card('A', 'hearts'),
        card('A', 'diamonds'),
        card('K', 'clubs'),
        card('Q', 'spades'),
        card('4', 'hearts'),
        card('2', 'diamonds'),
      ],
      category: 'threeOfAKind',
      displayName: '三条',
      comparisonGrade: [3, 12, 11, 10, 0, 0],
      bestFiveRanks: ['A', 'A', 'A', 'K', 'Q'],
    },
    {
      name: 'straight',
      cards: [
        card('A', 'spades'),
        card('K', 'hearts'),
        card('Q', 'diamonds'),
        card('J', 'clubs'),
        card('T', 'spades'),
        card('4', 'hearts'),
        card('2', 'diamonds'),
      ],
      category: 'straight',
      displayName: '顺子',
      comparisonGrade: [4, 12, 0, 0, 0, 0],
      bestFiveRanks: ['A', 'K', 'Q', 'J', 'T'],
    },
    {
      name: 'flush',
      cards: [
        card('A', 'hearts'),
        card('K', 'hearts'),
        card('Q', 'hearts'),
        card('J', 'hearts'),
        card('9', 'hearts'),
        card('5', 'hearts'),
        card('2', 'hearts'),
      ],
      category: 'flush',
      displayName: '同花',
      comparisonGrade: [5, 12, 11, 10, 9, 7],
      bestFiveRanks: ['A', 'K', 'Q', 'J', '9'],
    },
    {
      name: 'full house',
      cards: [
        card('A', 'spades'),
        card('A', 'hearts'),
        card('A', 'diamonds'),
        card('K', 'clubs'),
        card('K', 'spades'),
        card('K', 'hearts'),
        card('2', 'diamonds'),
      ],
      category: 'fullHouse',
      displayName: '葫芦',
      comparisonGrade: [6, 12, 11, 0, 0, 0],
      bestFiveRanks: ['A', 'A', 'A', 'K', 'K'],
    },
    {
      name: 'four of a kind',
      cards: [
        card('A', 'spades'),
        card('A', 'hearts'),
        card('A', 'diamonds'),
        card('A', 'clubs'),
        card('K', 'spades'),
        card('4', 'hearts'),
        card('2', 'diamonds'),
      ],
      category: 'fourOfAKind',
      displayName: '四条',
      comparisonGrade: [7, 12, 11, 0, 0, 0],
      bestFiveRanks: ['A', 'A', 'A', 'A', 'K'],
    },
    {
      name: 'straight flush',
      cards: [
        card('9', 'spades'),
        card('8', 'spades'),
        card('7', 'spades'),
        card('6', 'spades'),
        card('5', 'spades'),
        card('K', 'hearts'),
        card('2', 'diamonds'),
      ],
      category: 'straightFlush',
      displayName: '同花顺',
      comparisonGrade: [8, 7, 0, 0, 0, 0],
      bestFiveRanks: ['9', '8', '7', '6', '5'],
    },
  ])(
    'returns the stable category and grade for $name',
    ({ cards, category, displayName, comparisonGrade, bestFiveRanks }) => {
      const evaluation = handEvaluator.evaluate(cards)

      expect(evaluation).toMatchObject({
        category,
        displayName,
        comparisonGrade,
      })
      expect(evaluation.bestFive.map((bestCard) => bestCard.rank)).toEqual(
        bestFiveRanks,
      )
    },
  )

  test('keeps only the highest five cards from a seven-card flush', () => {
    const cards = [
      card('A', 'hearts'),
      card('K', 'hearts'),
      card('Q', 'hearts'),
      card('J', 'hearts'),
      card('9', 'hearts'),
      card('5', 'hearts'),
      card('2', 'hearts'),
    ]

    expect(handEvaluator.evaluate(cards).bestFive).toEqual(cards.slice(0, 5))
  })

  test('normalizes the wheel below a six-high straight', () => {
    const wheel = [
      card('A', 'spades'),
      card('2', 'hearts'),
      card('3', 'diamonds'),
      card('4', 'clubs'),
      card('5', 'spades'),
      card('9', 'hearts'),
      card('K', 'diamonds'),
    ]
    const sixHigh = [
      card('2', 'spades'),
      card('3', 'hearts'),
      card('4', 'diamonds'),
      card('5', 'clubs'),
      card('6', 'spades'),
      card('9', 'diamonds'),
      card('K', 'clubs'),
    ]
    const wheelEvaluation = handEvaluator.evaluate(wheel)
    const sixHighEvaluation = handEvaluator.evaluate(sixHigh)

    expect(wheelEvaluation.comparisonGrade).toEqual([4, 3, 0, 0, 0, 0])
    expect(wheelEvaluation.bestFive).toContainEqual(card('A', 'spades'))
    expect(
      compareGrades(
        wheelEvaluation.comparisonGrade,
        sixHighEvaluation.comparisonGrade,
      ),
    ).toBeLessThan(0)
    expect(handEvaluator.compare(wheel, sixHigh)).toBe('lose')
  })

  test('reports a royal flush as a straight flush with a specific Chinese name', () => {
    const evaluation = handEvaluator.evaluate([
      card('A', 'spades'),
      card('K', 'spades'),
      card('Q', 'spades'),
      card('J', 'spades'),
      card('T', 'spades'),
      card('4', 'hearts'),
      card('2', 'diamonds'),
    ])

    expect(evaluation).toMatchObject({
      category: 'straightFlush',
      comparisonGrade: [8, 12, 0, 0, 0, 0],
      displayName: '皇家同花顺',
    })
  })

  test.each([
    {
      count: 5,
      cards: [
        card('A', 'spades'),
        card('K', 'hearts'),
        card('Q', 'diamonds'),
        card('J', 'clubs'),
        card('9', 'spades'),
      ],
    },
    {
      count: 6,
      cards: [
        card('A', 'spades'),
        card('K', 'hearts'),
        card('Q', 'diamonds'),
        card('J', 'clubs'),
        card('9', 'spades'),
        card('2', 'hearts'),
      ],
    },
    {
      count: 7,
      cards: [
        card('A', 'spades'),
        card('K', 'hearts'),
        card('Q', 'diamonds'),
        card('J', 'clubs'),
        card('9', 'spades'),
        card('4', 'hearts'),
        card('2', 'diamonds'),
      ],
    },
  ])('evaluates an exact $count-card input', ({ cards }) => {
    expect(handEvaluator.evaluate(cards).bestFive).toHaveLength(5)
  })
})

describe('handEvaluator.compare', () => {
  test('uses multiple kicker levels to compare the same pair', () => {
    const stronger = [
      card('A', 'spades'),
      card('A', 'hearts'),
      card('K', 'diamonds'),
      card('Q', 'clubs'),
      card('J', 'spades'),
      card('4', 'hearts'),
      card('2', 'diamonds'),
    ]
    const weaker = [
      card('A', 'diamonds'),
      card('A', 'clubs'),
      card('K', 'spades'),
      card('Q', 'hearts'),
      card('T', 'diamonds'),
      card('4', 'clubs'),
      card('2', 'spades'),
    ]
    const strongerEvaluation = handEvaluator.evaluate(stronger)
    const weakerEvaluation = handEvaluator.evaluate(weaker)

    expect(handEvaluator.compare(stronger, weaker)).toBe('win')
    expect(handEvaluator.compare(weaker, stronger)).toBe('lose')
    expect(
      compareGrades(
        strongerEvaluation.comparisonGrade,
        weakerEvaluation.comparisonGrade,
      ),
    ).toBeGreaterThan(0)
  })

  test('returns a tie when both players use the five-card board', () => {
    const board = [
      card('A', 'spades'),
      card('K', 'hearts'),
      card('Q', 'diamonds'),
      card('J', 'clubs'),
      card('T', 'spades'),
    ]
    const left = [card('2', 'clubs'), card('3', 'clubs'), ...board]
    const right = [card('8', 'hearts'), card('9', 'hearts'), ...board]

    expect(handEvaluator.compare(left, right)).toBe('tie')
    expect(handEvaluator.evaluate(left).comparisonGrade).toEqual(
      handEvaluator.evaluate(right).comparisonGrade,
    )
  })

  test('uses the single kicker to compare four of a kind', () => {
    const sharedQuads = [
      card('A', 'spades'),
      card('A', 'hearts'),
      card('A', 'diamonds'),
      card('A', 'clubs'),
    ]
    const stronger = [
      ...sharedQuads,
      card('K', 'spades'),
      card('4', 'hearts'),
      card('2', 'diamonds'),
    ]
    const weaker = [
      ...sharedQuads,
      card('Q', 'spades'),
      card('4', 'diamonds'),
      card('2', 'clubs'),
    ]

    expect(handEvaluator.compare(stronger, weaker)).toBe('win')
    expect(
      compareGrades(
        handEvaluator.evaluate(stronger).comparisonGrade,
        handEvaluator.evaluate(weaker).comparisonGrade,
      ),
    ).toBeGreaterThan(0)
  })
})

describe('handEvaluator input boundaries', () => {
  const validCards = [
    card('A', 'spades'),
    card('K', 'hearts'),
    card('Q', 'diamonds'),
    card('J', 'clubs'),
    card('9', 'spades'),
  ]

  test('rejects non-arrays and card counts outside five to seven', () => {
    expect(() =>
      handEvaluator.evaluate(null as unknown as readonly Card[]),
    ).toThrow('牌型输入必须是数组。')
    expect(() => handEvaluator.evaluate(validCards.slice(0, 4))).toThrow(
      '牌型输入必须包含 5、6 或 7 张牌。',
    )
    expect(() =>
      handEvaluator.evaluate([
        ...validCards,
        card('8', 'hearts'),
        card('7', 'diamonds'),
        card('6', 'clubs'),
      ]),
    ).toThrow('牌型输入必须包含 5、6 或 7 张牌。')
  })

  test('rejects duplicate and non-strict cards before calling the solver', () => {
    expect(() =>
      handEvaluator.evaluate([...validCards.slice(0, 4), card('A', 'spades')]),
    ).toThrow('牌型输入不得包含重复牌。')
    expect(() =>
      handEvaluator.evaluate([
        ...validCards.slice(0, 4),
        {
          rank: '2',
          suit: 'clubs',
          code: 'club_2',
        } as unknown as Card,
      ]),
    ).toThrow()
    expect(() =>
      handEvaluator.evaluate([
        ...validCards.slice(0, 4),
        { rank: '1', suit: 'clubs' } as unknown as Card,
      ]),
    ).toThrow()
    expect(() =>
      handEvaluator.compare(validCards, [
        ...validCards.slice(0, 4),
        card('A', 'spades'),
      ]),
    ).toThrow('牌型输入不得包含重复牌。')
  })

  test('does not mutate evaluate or compare inputs', () => {
    const left = [...validCards, card('4', 'hearts'), card('2', 'diamonds')]
    const right = [
      card('A', 'hearts'),
      card('K', 'diamonds'),
      card('Q', 'clubs'),
      card('J', 'spades'),
      card('8', 'hearts'),
      card('4', 'diamonds'),
      card('2', 'clubs'),
    ]
    const leftBefore = structuredClone(left)
    const rightBefore = structuredClone(right)

    handEvaluator.evaluate(left)
    handEvaluator.compare(left, right)

    expect(left).toEqual(leftBefore)
    expect(right).toEqual(rightBefore)
  })
})
