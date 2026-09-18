import { isDeepStrictEqual } from 'node:util'
import {
  CoachRangeAnalysisSchema,
  type CoachRangeAnalysis,
} from '@tx-holdem-coach/contracts'
import type { AuditVersionReference } from '../audit/audit-primitives.js'
import {
  buildRangeAnalysis,
  type RangeAnalysisResult,
} from '../../poker-range/range-analysis.js'
import {
  RANGE_RANKS,
  type OpponentRangePack,
} from '../../poker-range/opponent-range-pack.js'
import { assertRepositoryOpponentRangePack } from '../../poker-range/opponent-range-repository.js'
import {
  computeJointEquity,
  type JointEquityAvailable,
} from '../../poker-range/joint-equity.js'
import {
  computeConditionalCallEv,
  computeRangeSensitivity,
  type ConditionalEvResult,
} from '../../poker-range/conditional-ev.js'
import {
  assertCertifiedCoachDecisionInput,
  type CertifiedCoachDecisionInput,
} from './frozen-analysis.js'
import { assertComputedCoachMetrics } from './decision-metrics.js'
import { assertComputedCoachActionOutcomes } from './action-outcomes.js'
import type {
  CoachActionOutcomes,
  CoachDecisionMetrics,
} from './analysis-results.js'
import { freezeCoachData } from './review-case.js'

export const COACH_RANGE_MODEL_VERSION = Object.freeze({
  id: 'coach.review.range-model',
  version: 1,
})
export const COACH_EQUITY_COMPUTATION_VERSION = Object.freeze({
  id: 'coach.review.equity-computation',
  version: 1,
})
export const COACH_SETTLEMENT_PROJECTION_VERSION = Object.freeze({
  id: 'coach.review.settlement-projection',
  version: 1,
})
export interface CoachRangeAnalysisInput {
  readonly input: CertifiedCoachDecisionInput
  readonly metrics: CoachDecisionMetrics
  readonly actionOutcomes: CoachActionOutcomes
  readonly pack: OpponentRangePack
  readonly dataDependencies: readonly AuditVersionReference[]
  readonly signal?: AbortSignal
}
const certified = new WeakMap<object, CoachRangeAnalysisInput>()
export function assertCertifiedCoachRangeAnalysis(
  value: CoachRangeAnalysis,
  input: CertifiedCoachDecisionInput,
  metrics: CoachDecisionMetrics,
  actionOutcomes: CoachActionOutcomes,
): void {
  const origin = certified.get(value)
  if (
    !origin ||
    origin.input !== input ||
    origin.metrics !== metrics ||
    origin.actionOutcomes !== actionOutcomes
  )
    throw new TypeError('coach_untrusted_range_analysis')
  assertRepositoryOpponentRangePack(origin.pack)
}
function prepare(request: CoachRangeAnalysisInput): RangeAnalysisResult {
  const { input, metrics, actionOutcomes, pack } = request
  assertCertifiedCoachDecisionInput(input)
  assertComputedCoachMetrics(metrics)
  assertComputedCoachActionOutcomes(actionOutcomes)
  assertRepositoryOpponentRangePack(pack)
  const versions = input.binding.versions
  if (
    !isDeepStrictEqual(versions.rangeModel, COACH_RANGE_MODEL_VERSION) ||
    !isDeepStrictEqual(
      versions.equityComputation,
      COACH_EQUITY_COMPUTATION_VERSION,
    ) ||
    !isDeepStrictEqual(versions.settlement, COACH_SETTLEMENT_PROJECTION_VERSION)
  )
    throw new TypeError('coach_range_version_unsupported')
  for (const value of [metrics, actionOutcomes]) {
    if (
      !isDeepStrictEqual(value.binding, input.binding) ||
      value.decisionId !== input.decision.decisionId ||
      value.stateVersion !== input.decision.stateVersion ||
      value.asOfEventSeq !== input.decision.opponentEvidenceCutoff.asOfEventSeq
    )
      throw new TypeError('coach_range_metrics_binding')
  }
  const refs = request.dataDependencies.filter((r) =>
    r.id.startsWith('opponent-range-pack/'),
  )
  if (
    refs.length !== 1 ||
    refs[0]!.id !== `opponent-range-pack/${pack.datasetId}` ||
    refs[0]!.version !== pack.datasetVersion ||
    pack.pokerRuleSetVersion !== input.binding.pokerRuleSetVersion
  )
    throw new TypeError('coach_range_pack_binding')
  return buildRangeAnalysis({ decision: input.decision.analysisInput, pack })
}
function common(request: CoachRangeAnalysisInput) {
  return {
    decisionId: request.input.decision.decisionId,
    rangePackRef: {
      datasetId: request.pack.datasetId,
      datasetVersion: request.pack.datasetVersion,
    },
    provenance: {
      rangeProjectionVersion: 1,
      equityComputationPolicyVersion: 1,
      settlementProjectionVersion: 1,
    },
  }
}
function unavailable(request: CoachRangeAnalysisInput, reasonCode: string) {
  return { ...common(request), status: 'unavailable' as const, reasonCode }
}
function certify(
  request: CoachRangeAnalysisInput,
  value: unknown,
): CoachRangeAnalysis {
  const result = freezeCoachData(CoachRangeAnalysisSchema.parse(value))
  certified.set(result, {
    ...request,
    dataDependencies: freezeCoachData(
      structuredClone(request.dataDependencies),
    ),
  })
  return result
}
function uncovered(
  request: CoachRangeAnalysisInput,
  range: Extract<RangeAnalysisResult, { status: 'unavailable' }>,
): CoachRangeAnalysis {
  const result = unavailable(request, range.reasonCode)
  return certify(request, {
    opponentRangeAnalysis: result,
    jointEquityAnalysis: result,
    conditionalCallEv: result,
    rangeSensitivity: result,
    rangeCharts: [],
  })
}
/** Synchronous uncovered path for a real pinned pack; never signs caller-supplied numbers. */
export function analyzeUncoveredCoachRanges(
  request: CoachRangeAnalysisInput,
): CoachRangeAnalysis {
  const range = prepare(request)
  if (range.status !== 'unavailable')
    throw new TypeError('coach_requires_runtime_computation')
  return uncovered(request, range)
}
/** Compute before calling the synchronous freeze boundary; derive then returns this certified value. */
export async function analyzeCoachOpponentRanges(
  request: CoachRangeAnalysisInput,
): Promise<CoachRangeAnalysis> {
  request.signal?.throwIfAborted()
  const range = prepare(request)
  if (range.status === 'unavailable') return uncovered(request, range)
  const shared = common(request)
  const opponentRangeAnalysis = {
    ...shared,
    status: 'available',
    matchStatus: range.status,
    sources: request.pack.sources,
    limitations: range.limitations,
    scenarios: range.scenarios.map((scenario) => ({
      scenarioId: scenario.scenarioId,
      name: scenario.name,
      sourceRefs: scenario.sourceRefs,
      opponents: scenario.opponents.map((opponent) => {
        const initial = request.pack.initialRanges.find(
          (r) => r.rangeId === opponent.initialRangeId,
        )!
        const seqs = [
          ...new Set([
            ...opponent.updateTrace.map((t) => t.eventSeq),
            ...opponent.unmodeledActions,
          ]),
        ].sort((a, b) => a - b)
        return {
          seatNumber: opponent.seatNumber,
          logicalPosition: opponent.logicalPosition,
          matchStatus: opponent.matchStatus,
          initialRangeId: opponent.initialRangeId,
          applicability: initial.applicability,
          appliedRuleIds: [
            ...new Set(opponent.updateTrace.map((t) => t.ruleId)),
          ],
          sourceRefs: opponent.sourceRefs,
          limitations: opponent.limitations,
          differenceCodes: opponent.differences,
          availableComboCount: opponent.combos.length,
          updateTrace: seqs.map((eventSeq) => ({
            eventSeq,
            ruleIds: opponent.updateTrace
              .filter((t) => t.eventSeq === eventSeq)
              .map((t) => t.ruleId),
            sourceRefs: [
              ...new Set(
                opponent.updateTrace
                  .filter((t) => t.eventSeq === eventSeq)
                  .flatMap((t) => t.sourceRefs),
              ),
            ],
            unmodeled: opponent.unmodeledActions.includes(eventSeq),
            adjustments: opponent.updateTrace
              .filter((trace) => trace.eventSeq === eventSeq)
              .map((trace) => ({
                ruleId: trace.ruleId,
                weightMultiplierBasisPoints: trace.weightMultiplierBasisPoints,
                affectedComboCount: trace.affectedComboCount,
                massBefore: trace.massBefore,
                massAfter: trace.massAfter,
                explanation: trace.explanation,
              })),
          })),
        }
      }),
    })),
  }
  const rangeCharts = range.scenarios.flatMap((scenario) =>
    scenario.opponents.map((opponent) => ({
      ...shared,
      schemaVersion: 1,
      chartId: `range:${request.input.decision.eventSeq}:${scenario.scenarioId}:${opponent.seatNumber}`,
      scenarioId: scenario.scenarioId,
      seatNumber: opponent.seatNumber,
      logicalPosition: opponent.logicalPosition,
      matchStatus: opponent.matchStatus,
      rankOrder: RANGE_RANKS,
      cells: opponent.chart,
    })),
  )
  const call = request.actionOutcomes.outcomes.find((o) =>
    o.references.some((r) => r.kind === 'callComparison'),
  )
  const pots =
    call?.result.pots ??
    request.metrics.contestablePot.potBreakdown.map((p, index) => ({
      potIndex: index,
      amount: p.amount,
      eligibleSeatNumbers: p.eligibleSeatNumbers,
    }))
  const rows: {
    scenarioId: string
    equity: JointEquityAvailable
    callEv: ConditionalEvResult
  }[] = []
  for (const scenario of range.scenarios) {
    const equity = await computeJointEquity({
      tableSize: request.input.tableSize,
      heroSeatNumber: request.input.decision.visibleState.heroSeat,
      heroHoleCards: request.input.decision.visibleState.heroHoleCards,
      board: request.input.decision.visibleState.board,
      opponents: scenario.opponents.map((o) => ({
        seatNumber: o.seatNumber,
        combos: o.combos,
      })),
      pots,
      buttonSeatNumber: request.input.decision.visibleState.buttonSeat,
      decisionId: shared.decisionId,
      rangePackRef: `opponent-range-pack/${request.pack.datasetId}@${request.pack.datasetVersion}`,
      jointScenarioId: scenario.scenarioId,
      policyVersion: 1,
      ...(request.signal ? { signal: request.signal } : {}),
    })
    if (equity.status === 'unavailable')
      return certify(request, {
        opponentRangeAnalysis,
        rangeCharts,
        jointEquityAnalysis: unavailable(request, equity.reasonCode),
        conditionalCallEv: unavailable(request, equity.reasonCode),
        rangeSensitivity: unavailable(request, equity.reasonCode),
      })
    const callEv =
      call && (call.action.type === 'call' || call.action.type === 'allIn')
        ? computeConditionalCallEv({
            actionType: call.action.type,
            outcome: call.result,
            equity,
          })
        : { status: 'unavailable' as const, reasonCode: 'noLegalCall' }
    rows.push({ scenarioId: scenario.scenarioId, equity, callEv })
  }
  const jointEquityAnalysis = {
    ...shared,
    status: 'available',
    evaluationContext: call ? 'afterCall' : 'currentShowdown',
    assumptions: ['assumesImmediateShowdown', ...range.limitations],
    scenarios: rows.map(({ scenarioId, equity }) => ({
      scenarioId,
      method: equity.method,
      seed: equity.seed,
      exactStates: equity.exactStates,
      proposedSamples:
        equity.method === 'exactEnumeration' ? null : equity.proposedSamples,
      acceptedSamples:
        equity.method === 'exactEnumeration' ? null : equity.acceptedSamples,
      pots: equity.pots,
      expectedHeroReturn: equity.expectedHeroReturn,
      totalStandardError: equity.totalStandardError,
      totalConfidenceInterval: equity.totalConfidenceInterval,
    })),
  }
  const unavailableEv = rows.find(
    (r) => r.callEv.status === 'unavailable',
  )?.callEv
  const conditionalCallEv =
    unavailableEv?.status === 'unavailable'
      ? unavailable(request, unavailableEv.reasonCode)
      : {
          ...shared,
          status: 'available',
          callAction: call!.action,
          scenarios: rows.map(({ scenarioId, callEv }) => {
            if (callEv.status !== 'available')
              throw new TypeError('coach_ev_scenario_incomplete')
            const { status: _, ...result } = callEv
            return { scenarioId, ...result }
          }),
        }
  const sensitivity = computeRangeSensitivity(rows)
  const rangeSensitivity =
    sensitivity.status === 'unavailable'
      ? unavailable(request, sensitivity.reasonCode)
      : { ...shared, ...sensitivity }
  request.signal?.throwIfAborted()
  return certify(request, {
    opponentRangeAnalysis,
    jointEquityAnalysis,
    conditionalCallEv,
    rangeSensitivity,
    rangeCharts,
  })
}
