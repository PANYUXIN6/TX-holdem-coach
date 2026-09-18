import type { DecisionAnalysisInput } from '../poker/decision-analysis-input.js'
import { normalizeDecisionSpot } from '../poker/decision-spot.js'
import {
  expandRangeWeights,
  projectRangeChart,
  type RangeChartCell,
  type WeightedCombo,
} from './combo-expander.js'
import type {
  OpponentRangePack,
  OpponentRangePackReference,
} from './opponent-range-pack.js'
import { assertRepositoryOpponentRangePack } from './opponent-range-repository.js'
import {
  createRangeMatchContext,
  matchesRangeApplicability,
} from './range-scenario.js'
import { applyRangeUpdates, type RangeUpdateTrace } from './range-updater.js'

export interface OpponentRangeResult {
  readonly seatNumber: number
  readonly logicalPosition: string
  readonly initialRangeId: string
  readonly matchStatus: 'matched' | 'referenceOnly'
  readonly differences: readonly string[]
  readonly combos: readonly WeightedCombo[]
  readonly chart: readonly RangeChartCell[]
  readonly sourceRefs: readonly string[]
  readonly updateTrace: readonly RangeUpdateTrace[]
  readonly unmodeledActions: readonly number[]
  readonly limitations: readonly string[]
}
export interface RangeScenarioAnalysis {
  readonly scenarioId: string
  readonly name: string
  readonly sourceRefs: readonly string[]
  readonly limitations: readonly string[]
  readonly opponents: readonly OpponentRangeResult[]
}
interface RangeAnalysisBase {
  readonly packRef: OpponentRangePackReference
  readonly rangeProjectionVersion: 1
  readonly limitations: readonly string[]
}
export type RangeAnalysisResult = RangeAnalysisBase &
  (
    | {
        readonly status: 'matched' | 'referenceOnly'
        readonly scenarios: readonly RangeScenarioAnalysis[]
      }
    | {
        readonly status: 'unavailable'
        readonly reasonCode:
          'uncoveredScenario' | 'emptyRange' | 'unmodeledAction' | 'noOpponents'
      }
  )
export function buildRangeAnalysis(input: {
  readonly decision: DecisionAnalysisInput
  readonly pack: OpponentRangePack
}): RangeAnalysisResult {
  const { decision, pack } = input
  assertRepositoryOpponentRangePack(pack)
  if (pack.pokerRuleSetVersion !== decision.pokerRuleSetVersion)
    throw new TypeError('range_rule_version_mismatch')
  const spot = normalizeDecisionSpot(decision)
  const base: RangeAnalysisBase = {
    packRef: { datasetId: pack.datasetId, datasetVersion: pack.datasetVersion },
    rangeProjectionVersion: 1,
    limitations: [
      ...pack.limitations,
      'foldedUnknownCardsMarginalized',
      'opponentRangesIndependentConditionedOnNoCardOverlap',
    ],
  }
  const seats = decision.seats.filter(
    (seat) =>
      seat.seatNumber !== decision.heroSeatNumber &&
      (seat.status === 'active' || seat.status === 'allIn'),
  )
  if (!seats.length)
    return { ...base, status: 'unavailable', reasonCode: 'noOpponents' }
  const scenarios: RangeScenarioAnalysis[] = []
  let referenceOnly = false
  for (const scenario of pack.jointScenarios) {
    const opponents: OpponentRangeResult[] = []
    for (const seat of seats) {
      const context = createRangeMatchContext(decision, spot, seat.seatNumber)
      const candidates = pack.initialRanges.filter(
        (range) =>
          scenario.initialRangeIds.includes(range.rangeId) &&
          matchesRangeApplicability(range.applicability, context),
      )
      if (candidates.length > 1)
        throw new TypeError('range_ambiguous_initial_range')
      const range = candidates[0]
      if (!range)
        return {
          ...base,
          status: 'unavailable',
          reasonCode: 'uncoveredScenario',
        }
      const expanded = expandRangeWeights(range.weights, [
        ...decision.heroHoleCards,
        ...decision.board,
      ])
      if (!expanded.combos.length)
        return { ...base, status: 'unavailable', reasonCode: 'emptyRange' }
      const updated = applyRangeUpdates({
        combos: expanded.combos,
        actions: decision.publicActions.filter(
          (action) => action.actorSeatNumber === seat.seatNumber,
        ),
        board: decision.board,
        context,
        rules: pack.updateRules.filter((rule) =>
          scenario.updateRuleIds.includes(rule.ruleId),
        ),
      })
      if (!updated.combos.length)
        return { ...base, status: 'unavailable', reasonCode: 'emptyRange' }
      if (updated.unmodeledActions.length && !scenario.allowUnmodeledActions)
        return { ...base, status: 'unavailable', reasonCode: 'unmodeledAction' }
      referenceOnly ||= range.matchStatus === 'referenceOnly'
      opponents.push({
        seatNumber: seat.seatNumber,
        logicalPosition: context.opponentLogicalPosition,
        initialRangeId: range.rangeId,
        matchStatus: range.matchStatus,
        differences: range.differences,
        combos: updated.combos,
        chart: projectRangeChart(range.weights, updated.combos),
        sourceRefs: [
          ...new Set([
            ...range.sourceRefs,
            ...updated.updateTrace.flatMap((trace) => trace.sourceRefs),
          ]),
        ],
        updateTrace: updated.updateTrace,
        unmodeledActions: updated.unmodeledActions,
        limitations: [
          ...new Set([
            ...range.limitations,
            ...scenario.limitations,
            ...pack.coverageManifest.find(
              (entry) => entry.rangeId === range.rangeId,
            )!.limitations,
          ]),
        ],
      })
    }
    scenarios.push({
      scenarioId: scenario.scenarioId,
      name: scenario.name,
      sourceRefs: scenario.sourceRefs,
      limitations: scenario.limitations,
      opponents,
    })
  }
  if (!scenarios.length)
    return { ...base, status: 'unavailable', reasonCode: 'uncoveredScenario' }
  return {
    ...base,
    status: referenceOnly ? 'referenceOnly' : 'matched',
    scenarios,
  }
}
