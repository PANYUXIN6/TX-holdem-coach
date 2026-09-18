import type {
  JointEquityAvailable,
  JointEquityResult,
  EquityInterval,
} from './joint-equity.js'
export interface TerminalCallOutcome {
  readonly showdownForced: boolean
  readonly furtherBettingPossible: boolean
  readonly responders: readonly number[]
  readonly canRaiseSeats: readonly number[]
  readonly amountActuallyAtRisk: number
}
export type ConditionalEvResult =
  | {
      readonly status: 'available'
      readonly expectedHeroReturn: number
      readonly amountActuallyAtRisk: number
      readonly callEvVersusFold: number
      readonly confidenceInterval: EquityInterval | null
    }
  | { readonly status: 'unavailable'; readonly reasonCode: string }
export function computeConditionalCallEv(input: {
  readonly actionType: 'call' | 'allIn'
  readonly outcome: TerminalCallOutcome
  readonly equity: JointEquityResult
}): ConditionalEvResult {
  const { outcome, equity } = input
  if (
    !Number.isSafeInteger(outcome.amountActuallyAtRisk) ||
    outcome.amountActuallyAtRisk < 0
  )
    throw new TypeError('invalid_call_risk')
  if (
    !outcome.showdownForced ||
    outcome.furtherBettingPossible ||
    outcome.responders.length > 0 ||
    outcome.canRaiseSeats.length > 0
  )
    return { status: 'unavailable', reasonCode: 'futureActionsUnmodeled' }
  if (equity.status === 'unavailable') return equity
  return {
    status: 'available',
    expectedHeroReturn: equity.expectedHeroReturn,
    amountActuallyAtRisk: outcome.amountActuallyAtRisk,
    callEvVersusFold: equity.expectedHeroReturn - outcome.amountActuallyAtRisk,
    confidenceInterval:
      equity.totalConfidenceInterval === null
        ? null
        : {
            lower:
              equity.totalConfidenceInterval.lower -
              outcome.amountActuallyAtRisk,
            upper:
              equity.totalConfidenceInterval.upper -
              outcome.amountActuallyAtRisk,
          },
  }
}
export type RangeSensitivityResult =
  | { readonly status: 'unavailable'; readonly reasonCode: string }
  | {
      readonly status: 'available'
      readonly scenarioIds: string[]
      readonly equityMin: number
      readonly equityMax: number
      readonly callEvMin: number | null
      readonly callEvMax: number | null
      readonly signStable: boolean | null
    }
export function computeRangeSensitivity(
  scenarios: readonly {
    readonly scenarioId: string
    readonly equity: JointEquityAvailable
    readonly callEv: ConditionalEvResult
  }[],
): RangeSensitivityResult {
  if (scenarios.length < 2)
    return { status: 'unavailable', reasonCode: 'noAlternativeScenarios' }
  if (
    scenarios.length > 3 ||
    new Set(scenarios.map((s) => s.scenarioId)).size !== scenarios.length
  )
    throw new TypeError('invalid_sensitivity_scenarios')
  const equities = scenarios.map(
    (s) =>
      s.equity.expectedHeroReturn /
      s.equity.pots.reduce((sum, p) => sum + p.amount, 0),
  )
  const evs = scenarios
    .map((s) => s.callEv)
    .filter(
      (s): s is Extract<ConditionalEvResult, { status: 'available' }> =>
        s.status === 'available',
    )
  const complete = evs.length === scenarios.length
  return {
    status: 'available',
    scenarioIds: scenarios.map((s) => s.scenarioId),
    equityMin: Math.min(...equities),
    equityMax: Math.max(...equities),
    callEvMin: complete
      ? Math.min(...evs.map((e) => e.callEvVersusFold))
      : null,
    callEvMax: complete
      ? Math.max(...evs.map((e) => e.callEvVersusFold))
      : null,
    signStable: complete
      ? evs.every(
          (e) => (e.confidenceInterval?.lower ?? e.callEvVersusFold) > 0,
        ) ||
        evs.every(
          (e) => (e.confidenceInterval?.upper ?? e.callEvVersusFold) < 0,
        )
      : null,
  }
}
