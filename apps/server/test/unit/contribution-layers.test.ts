import { describe, expect, test } from 'vitest'
import { projectContributionLayers } from '../../src/poker/contribution-layers.js'

describe('projectContributionLayers', () => {
  test('keeps folded chips in conserved layers while excluding folded eligibility', () => {
    const projection = projectContributionLayers({
      pot: 270,
      seats: [
        { seatNumber: 0, status: 'active', totalContribution: 120 },
        { seatNumber: 1, status: 'allIn', totalContribution: 100 },
        { seatNumber: 2, status: 'folded', totalContribution: 50 },
      ],
    })

    expect(projection.layers).toEqual([
      {
        layerIndex: 0,
        lowerContributionExclusive: 0,
        upperContributionInclusive: 50,
        amount: 150,
        contributingSeatNumbers: [0, 1, 2],
        eligibleSeatNumbers: [0, 1],
      },
      {
        layerIndex: 1,
        lowerContributionExclusive: 50,
        upperContributionInclusive: 100,
        amount: 100,
        contributingSeatNumbers: [0, 1],
        eligibleSeatNumbers: [0, 1],
      },
      {
        layerIndex: 2,
        lowerContributionExclusive: 100,
        upperContributionInclusive: 120,
        amount: 20,
        contributingSeatNumbers: [0],
        eligibleSeatNumbers: [0],
      },
    ])
    expect(projection.totalContribution).toBe(270)
    expect(projection.uncalledContributionCandidate).toEqual({
      layerIndex: 2,
      seatNumber: 0,
      amount: 20,
      lowerContributionExclusive: 100,
      upperContributionInclusive: 120,
    })
    expect(Object.isFrozen(projection.layers)).toBe(true)
  })

  test('does not report an uncalled candidate when the highest level is shared', () => {
    const projection = projectContributionLayers({
      pot: 200,
      seats: [
        { seatNumber: 1, status: 'active', totalContribution: 100 },
        { seatNumber: 0, status: 'allIn', totalContribution: 100 },
      ],
    })

    expect(projection.layers[0]?.contributingSeatNumbers).toEqual([0, 1])
    expect(projection.uncalledContributionCandidate).toBeNull()
  })

  test('rejects a pot mismatch and a layer with no eligible seat', () => {
    expect(() =>
      projectContributionLayers({
        pot: 199,
        seats: [
          { seatNumber: 0, status: 'active', totalContribution: 100 },
          { seatNumber: 1, status: 'allIn', totalContribution: 100 },
        ],
      }),
    ).toThrow('贡献分层总额必须严格等于当前底池。')

    expect(() =>
      projectContributionLayers({
        pot: 20,
        seats: [
          { seatNumber: 0, status: 'active', totalContribution: 0 },
          { seatNumber: 1, status: 'folded', totalContribution: 20 },
        ],
      }),
    ).toThrow('每个贡献层必须有安全金额和至少一名获胜资格者。')
  })
})
