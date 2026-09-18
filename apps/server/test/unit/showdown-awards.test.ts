import { describe, expect, test } from 'vitest'
import { projectShowdownAwards } from '../../src/poker/showdown-awards.js'
import { projectContributionLayers } from '../../src/poker/contribution-layers.js'
import { handEvaluator } from '../../src/poker/hand-evaluator.js'

const tied = handEvaluator.evaluate([
  { rank: 'A', suit: 'spades' },
  { rank: 'K', suit: 'spades' },
  { rank: 'Q', suit: 'spades' },
  { rank: 'J', suit: 'spades' },
  { rank: 'T', suit: 'spades' },
])

describe('projectShowdownAwards', () => {
  test('splits each eligible pot and assigns odd chips clockwise after the button', () => {
    const { layers } = projectContributionLayers({
      pot: 13,
      seats: [
        { seatNumber: 0, status: 'folded', totalContribution: 3 },
        { seatNumber: 2, status: 'allIn', totalContribution: 5 },
        { seatNumber: 4, status: 'allIn', totalContribution: 5 },
      ],
    })
    const pots = projectShowdownAwards({
      layers,
      evaluations: new Map([
        [2, tied],
        [4, tied],
      ]),
      buttonSeatNumber: 3,
    })
    expect(pots.map((p) => p.awards)).toEqual([
      [
        { seatNumber: 4, baseAmount: 4, oddChipAmount: 1, amount: 5 },
        { seatNumber: 2, baseAmount: 4, oddChipAmount: 0, amount: 4 },
      ],
      [
        { seatNumber: 4, baseAmount: 2, oddChipAmount: 0, amount: 2 },
        { seatNumber: 2, baseAmount: 2, oddChipAmount: 0, amount: 2 },
      ],
    ])
    expect(() =>
      projectShowdownAwards({
        layers,
        evaluations: new Map(),
        buttonSeatNumber: 3,
      }),
    ).toThrow(/评估/)
  })
})
