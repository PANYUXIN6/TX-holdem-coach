import { describe, expect, it } from 'vitest'
import {
  computeConditionalCallEv,
  computeRangeSensitivity,
} from '../../src/poker-range/conditional-ev.js'
import type { JointEquityAvailable } from '../../src/poker-range/joint-equity.js'
const equity = (returned: number): JointEquityAvailable => ({
  status: 'available',
  method: 'exactEnumeration',
  seed: 'fixture',
  policyVersion: 1,
  exactStates: 1,
  proposedSamples: 0,
  acceptedSamples: 0,
  pots: [
    {
      potIndex: 0,
      amount: 100,
      eligibleSeatNumbers: [0, 1, 2],
      winProbability: returned / 100,
      tieProbability: 0,
      lossProbability: 1 - returned / 100,
      expectedAllocationShare: returned / 100,
      expectedReturn: returned,
      standardError: null,
      confidenceInterval: null,
    },
  ],
  expectedHeroReturn: returned,
  totalStandardError: null,
  totalConfidenceInterval: null,
})
const outcome = {
  showdownForced: true,
  furtherBettingPossible: false,
  responders: [] as number[],
  canRaiseSeats: [] as number[],
  amountActuallyAtRisk: 20,
}
describe('conditional call EV and range uncertainty', () => {
  it('deducts only new risk across multiway terminal scenarios', () => {
    expect(
      computeConditionalCallEv({
        actionType: 'call',
        outcome,
        equity: equity(40),
      }),
    ).toEqual({
      status: 'available',
      expectedHeroReturn: 40,
      amountActuallyAtRisk: 20,
      callEvVersusFold: 20,
      confidenceInterval: null,
    })
    expect(
      computeConditionalCallEv({
        actionType: 'allIn',
        outcome,
        equity: equity(10),
      }),
    ).toMatchObject({ status: 'available', callEvVersusFold: -10 })
  })
  it('rejects an unresolved responder even when hero is all-in', () => {
    expect(
      computeConditionalCallEv({
        actionType: 'allIn',
        outcome: { ...outcome, responders: [2] },
        equity: equity(40),
      }),
    ).toEqual({ status: 'unavailable', reasonCode: 'futureActionsUnmodeled' })
  })
  it('keeps single-range, changing-sign and sampling precision limitations distinct', () => {
    const row = (id: string, returned: number) => ({
      scenarioId: id,
      equity: equity(returned),
      callEv: computeConditionalCallEv({
        actionType: 'call',
        outcome,
        equity: equity(returned),
      }),
    })
    expect(computeRangeSensitivity([row('base', 40)])).toEqual({
      status: 'unavailable',
      reasonCode: 'noAlternativeScenarios',
    })
    expect(
      computeRangeSensitivity([row('base', 40), row('tight', 10)]),
    ).toMatchObject({
      status: 'available',
      signStable: false,
      callEvMin: -10,
      callEvMax: 20,
    })
    expect(
      computeRangeSensitivity([row('base', 40), row('wide', 60)]),
    ).toMatchObject({ status: 'available', signStable: true })
    const uncertain = row('uncertain', 21)
    uncertain.callEv = {
      status: 'available',
      expectedHeroReturn: 21,
      amountActuallyAtRisk: 20,
      callEvVersusFold: 1,
      confidenceInterval: { lower: -2, upper: 4 },
    }
    expect(computeRangeSensitivity([row('base', 40), uncertain])).toMatchObject(
      { status: 'available', signStable: false },
    )
  })
})
