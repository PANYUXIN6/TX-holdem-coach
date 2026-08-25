import { describe, expect, test } from 'vitest'
import { projectContestablePot } from '../../src/poker/contestable-pot.js'

describe('projectContestablePot', () => {
  test('projects layered eligibility and maximum future contestable chips', () => {
    const sourceRefs = [{ path: 'hand.pot', hash: 'abc' }]
    const projection = projectContestablePot({
      heroSeatNumber: 0,
      pot: 300,
      seats: [
        {
          seatNumber: 0,
          status: 'active',
          stack: 900,
          totalContribution: 100,
        },
        {
          seatNumber: 1,
          status: 'active',
          stack: 400,
          totalContribution: 100,
        },
        {
          seatNumber: 2,
          status: 'allIn',
          stack: 0,
          totalContribution: 50,
        },
        {
          seatNumber: 3,
          status: 'folded',
          stack: 950,
          totalContribution: 50,
        },
      ],
      sourceRefs,
    })

    expect(projection).toMatchObject({
      contestablePotSchemaVersion: 1,
      projectorVersion: 1,
      potBreakdown: [
        {
          potId: 'main',
          amount: 200,
          lowerContributionExclusive: 0,
          upperContributionInclusive: 50,
          contributingSeatNumbers: [0, 1, 2, 3],
          eligibleSeatNumbers: [0, 1, 2],
        },
        {
          potId: 'side-1',
          amount: 100,
          lowerContributionExclusive: 50,
          upperContributionInclusive: 100,
          contributingSeatNumbers: [0, 1],
          eligibleSeatNumbers: [0, 1],
        },
      ],
      effectiveStacksByOpponent: [
        {
          opponentSeatNumber: 1,
          currentEffectiveStack: 400,
          maximumAdditionalMatchedContribution: 400,
        },
        {
          opponentSeatNumber: 2,
          currentEffectiveStack: 0,
          maximumAdditionalMatchedContribution: 0,
        },
      ],
      heroContestablePotBefore: 300,
      heroMaximumContestableAmount: 1_100,
    })
    sourceRefs[0]!.hash = 'changed'
    expect(projection.sourceRefs).toEqual([{ path: 'hand.pot', hash: 'abc' }])
    expect(Object.isFrozen(projection.potBreakdown)).toBe(true)
    expect(Object.isFrozen(projection.sourceRefs[0])).toBe(true)
  })

  test('excludes a side pot for which Hero has not reached the layer', () => {
    const projection = projectContestablePot({
      heroSeatNumber: 0,
      pot: 300,
      seats: [
        {
          seatNumber: 0,
          status: 'active',
          stack: 100,
          totalContribution: 50,
        },
        {
          seatNumber: 1,
          status: 'active',
          stack: 100,
          totalContribution: 100,
        },
        {
          seatNumber: 2,
          status: 'allIn',
          stack: 0,
          totalContribution: 100,
        },
        {
          seatNumber: 3,
          status: 'folded',
          stack: 0,
          totalContribution: 50,
        },
      ],
      sourceRefs: ['table.seats', 'hand.pot'],
    })

    expect(projection.potBreakdown.map((pot) => pot.amount)).toEqual([200, 100])
    expect(projection.potBreakdown[1]?.eligibleSeatNumbers).toEqual([1, 2])
    expect(projection.heroContestablePotBefore).toBe(200)
    expect(projection.heroMaximumContestableAmount).toBe(450)
    expect(
      projection.effectiveStacksByOpponent.map(
        (opponent) => opponent.opponentSeatNumber,
      ),
    ).toEqual([1, 2])
  })

  test('excludes heads-up chips above the opponent maximum matching level', () => {
    const projection = projectContestablePot({
      heroSeatNumber: 0,
      pot: 200,
      seats: [
        {
          seatNumber: 0,
          status: 'active',
          stack: 900,
          totalContribution: 100,
        },
        {
          seatNumber: 1,
          status: 'active',
          stack: 200,
          totalContribution: 100,
        },
      ],
      sourceRefs: [],
    })

    expect(projection.heroMaximumContestableAmount).toBe(600)
  })

  test('caps each future multiway side-pot layer at the highest opponent capacity', () => {
    const projection = projectContestablePot({
      heroSeatNumber: 0,
      pot: 400,
      seats: [
        {
          seatNumber: 0,
          status: 'active',
          stack: 900,
          totalContribution: 100,
        },
        {
          seatNumber: 1,
          status: 'active',
          stack: 400,
          totalContribution: 100,
        },
        {
          seatNumber: 2,
          status: 'active',
          stack: 200,
          totalContribution: 100,
        },
        {
          seatNumber: 3,
          status: 'allIn',
          stack: 0,
          totalContribution: 50,
        },
        {
          seatNumber: 4,
          status: 'folded',
          stack: 950,
          totalContribution: 50,
        },
      ],
      sourceRefs: [],
    })

    expect(projection.heroMaximumContestableAmount).toBe(1_400)
  })

  test('rejects inconsistent pots and an ineligible Hero', () => {
    const seats = [
      {
        seatNumber: 0,
        status: 'folded' as const,
        stack: 100,
        totalContribution: 50,
      },
      {
        seatNumber: 1,
        status: 'active' as const,
        stack: 100,
        totalContribution: 50,
      },
    ]

    expect(() =>
      projectContestablePot({
        heroSeatNumber: 0,
        pot: 100,
        seats,
        sourceRefs: [],
      }),
    ).toThrow('Hero 必须是仍有获胜资格的参与座位。')
    expect(() =>
      projectContestablePot({
        heroSeatNumber: 1,
        pot: 99,
        seats,
        sourceRefs: [],
      }),
    ).toThrow('贡献分层总额必须严格等于当前底池。')
  })
})
