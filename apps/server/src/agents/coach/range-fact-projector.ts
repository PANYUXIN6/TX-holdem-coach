import {
  CoachPublicFactSchema,
  type CoachPublicFact,
  type CoachRangeAnalysis,
} from '@tx-holdem-coach/contracts'
import type { CertifiedCoachDecisionInput } from './frozen-analysis.js'
import type {
  CoachDecisionMetrics,
  CoachActionOutcomes,
} from './analysis-results.js'
import { assertCertifiedCoachRangeAnalysis } from './range-analysis.js'
import { freezeCoachData } from './review-case.js'

export const COACH_RANGE_FACT_ALGORITHM_VERSION =
  'coach.range-fact-projection:1'
export const COACH_RANGE_FACT_KINDS = [
  'opponentRangeAnalysis',
  'jointEquityAnalysis',
  'conditionalCallEv',
  'rangeSensitivity',
] as const
/** Every status is a projection of the same authenticated numeric result. */
export function projectCoachRangeFacts(
  input: CertifiedCoachDecisionInput,
  metrics: CoachDecisionMetrics,
  outcomes: CoachActionOutcomes,
  projection: CoachRangeAnalysis,
): readonly CoachPublicFact[] {
  assertCertifiedCoachRangeAnalysis(projection, input, metrics, outcomes)
  const range = projection.opponentRangeAnalysis
  const records =
    range.status === 'available'
      ? [
          ...new Set(
            range.scenarios.flatMap((s) =>
              s.opponents.map((o) => o.initialRangeId),
            ),
          ),
        ]
      : [null]
  const sourceRefs = [
    {
      kind: 'event',
      sessionId: input.binding.sessionId,
      handId: input.binding.handId,
      eventSeq: input.decision.opponentEvidenceCutoff.asOfEventSeq,
    },
    {
      kind: 'algorithm',
      algorithmId: 'coach.range-fact-projection',
      version: 1,
    },
    {
      kind: 'algorithm',
      algorithmId: input.binding.versions.rangeModel.id,
      version: range.provenance.rangeProjectionVersion,
    },
    {
      kind: 'algorithm',
      algorithmId: input.binding.versions.equityComputation.id,
      version: range.provenance.equityComputationPolicyVersion,
    },
    {
      kind: 'algorithm',
      algorithmId: input.binding.versions.settlement.id,
      version: range.provenance.settlementProjectionVersion,
    },
    ...records.map((recordId) => ({
      kind: 'rangeModel',
      datasetId: range.rangePackRef.datasetId,
      datasetVersion: String(range.rangePackRef.datasetVersion),
      recordId,
    })),
  ]
  const assumptions = [
    ...(range.status === 'available' ? range.limitations : []),
    ...(projection.jointEquityAnalysis.status === 'available'
      ? projection.jointEquityAnalysis.assumptions
      : []),
  ]
  return freezeCoachData(
    COACH_RANGE_FACT_KINDS.map((kind) => {
      const value = projection[kind]
      const base = {
        factId: `range.${kind}`,
        scope: 'decision',
        epistemicKind:
          kind === 'opponentRangeAnalysis' ? 'rangeAssumption' : 'formulaFact',
        sourceRefs,
        schemaVersion: 1,
        algorithmVersion: COACH_RANGE_FACT_ALGORITHM_VERSION,
        dataVersion: String(range.rangePackRef.datasetVersion),
        asOfEventSeq: input.decision.opponentEvidenceCutoff.asOfEventSeq,
        assumptions: [...new Set(assumptions)],
      }
      return CoachPublicFactSchema.parse(
        value.status === 'available'
          ? { ...base, status: 'available', value: { kind, [kind]: value } }
          : {
              ...base,
              status: 'unavailable',
              kind,
              reasonCode: value.reasonCode,
            },
      )
    }),
  )
}
