import {
  createProjectedLegalCandidates,
  getProjectedLegalActions,
} from './betting-projection.js'
import type { LegalCandidateCatalogEntry } from './candidate-outcomes.js'
import {
  projectContestablePot,
  type ContestablePotProjectionData,
} from './contestable-pot.js'
import {
  toBettingProjectionState,
  type DecisionAnalysisInput,
} from './decision-analysis-input.js'
import type { CoreFactSourceRef } from './decision-analysis-types.js'
import {
  computeDecisionMetrics,
  type DecisionMetricsData,
} from './decision-metrics.js'
import {
  analyzeHandFeatures,
  type HandFeatureAnalysis,
} from './hand-features.js'
import {
  normalizeDecisionSpot,
  type NormalizedDecisionSpotData,
} from './decision-spot.js'

export interface DecisionAnalysisCoreData {
  readonly normalizedSpot: NormalizedDecisionSpotData<CoreFactSourceRef>
  readonly handFeatures: HandFeatureAnalysis
  readonly contestablePot: ContestablePotProjectionData<CoreFactSourceRef>
  readonly currentMetrics: DecisionMetricsData<CoreFactSourceRef>
  readonly legalCandidates: readonly LegalCandidateCatalogEntry[]
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

export function buildDecisionAnalysisCore(
  input: DecisionAnalysisInput,
): DecisionAnalysisCoreData {
  const state = toBettingProjectionState(input)
  if (
    JSON.stringify(input.legalActions) !==
    JSON.stringify(getProjectedLegalActions(state))
  ) {
    throw new RangeError('决策分析合法动作与共享下注内核不一致。')
  }
  const sourceRefs: readonly CoreFactSourceRef[] = [
    { kind: 'analysisInputField', path: 'table.seats', eventSeq: null },
    { kind: 'analysisInputField', path: 'hand.pot', eventSeq: null },
    {
      kind: 'ruleSet',
      pokerRuleSetVersion: input.pokerRuleSetVersion,
      factId: 'contributionLayering',
    },
    {
      kind: 'algorithm',
      algorithmId: 'contestablePotProjector',
      version: 1,
    },
  ]
  const legalCandidates = createProjectedLegalCandidates(state).map(
    (candidate): LegalCandidateCatalogEntry => ({
      candidateSchemaVersion: candidate.candidateSchemaVersion,
      candidateId: candidate.candidateId,
      action: { ...candidate.action },
      targetStreetCommitment: candidate.targetStreetCommitment,
      targetKind: candidate.targetKind,
    }),
  )
  return deepFreeze({
    normalizedSpot: normalizeDecisionSpot(input),
    handFeatures: analyzeHandFeatures({
      pokerRuleSetVersion: input.pokerRuleSetVersion,
      street: input.street,
      heroHoleCards: input.heroHoleCards,
      board: input.board,
    }),
    contestablePot: projectContestablePot({
      heroSeatNumber: input.heroSeatNumber,
      pot: input.pot,
      seats: input.seats,
      sourceRefs,
    }),
    currentMetrics: computeDecisionMetrics(input),
    legalCandidates,
  })
}
