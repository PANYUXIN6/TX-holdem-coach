import {
  CoachDecisionMetricsSchema,
  CoachActionOutcomesSchema,
} from './analysis-results.js'
import { z } from 'zod'
import {
  CoachAssessmentFieldsSchema,
  CoachDecisionIdSchema,
  CoachExplanationSchema,
  CoachStrategyBaselineSchema,
  CoachOpponentEvidenceSchema,
  CoachPublicFactSchema,
  CoachRangeChartSpecSchema,
  CoachBetSizeSchema,
  PokerActionSchema,
} from '@tx-holdem-coach/contracts'
import {
  CoachHeroDecisionSchema,
  CoachVersionsSchema,
  CoachSequence,
  CoachHindsightFactsSchema,
} from './review-case.js'

const reference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/)
export const CoachDecisionExplanationSchema = z.strictObject({
  decisionId: CoachDecisionIdSchema,
  baselineExplanation: CoachExplanationSchema,
  situationExplanation: CoachExplanationSchema,
  exploitExplanation: CoachExplanationSchema,
  alternatives: z.array(
    z.strictObject({
      candidateId: reference,
      explanation: z.string().trim().min(1).max(2000),
      factRefs: z.array(reference).min(1),
    }),
  ),
  keyLessons: z.array(z.string().trim().min(1).max(500)).max(3),
  practiceSuggestions: z.array(z.string().trim().min(1).max(500)).max(3),
})
export const CoachHindsightExplanationSchema = z.strictObject({
  decisionId: CoachDecisionIdSchema,
  hindsightExplanation: CoachExplanationSchema,
})
// These deterministic hypothetical results stay private even after teaching projection.
export const CoachCandidateSchema = z.strictObject({
  candidateId: reference,
  action: PokerActionSchema,
  raisesCurrentBet: z.boolean(),
  betSize: CoachBetSizeSchema,
  evidenceRefs: z.array(reference).min(1),
  result: z.strictObject({
    targetStreetCommitment: CoachSequence,
    incrementalChips: CoachSequence,
    potAfter: CoachSequence,
    remainingStack: CoachSequence,
  }),
})
export const CoachDerivedFactsSchema = z.strictObject({
  metrics: CoachDecisionMetricsSchema,
  actionOutcomes: CoachActionOutcomesSchema,
  versions: CoachVersionsSchema,
  asOfEventSeq: CoachSequence,
  facts: z.array(CoachPublicFactSchema),
  baseline: CoachStrategyBaselineSchema,
  opponentEvidence: z.array(CoachOpponentEvidenceSchema),
  candidates: z.array(CoachCandidateSchema),
  rangeChart: CoachRangeChartSpecSchema.nullable(),
})
const CoachModelDerivedFactsSchema = z.strictObject({
  versions: CoachVersionsSchema,
  asOfEventSeq: CoachSequence,
  facts: z.array(CoachPublicFactSchema),
  baseline: CoachStrategyBaselineSchema,
  opponentEvidence: z.array(CoachOpponentEvidenceSchema),
  candidates: z.array(CoachCandidateSchema),
})
export const CoachDecisionContextSchema = z.strictObject({
  contextKind: z.literal('decisionAnalysis'),
  schemaVersion: z.literal(1),
  decisionId: CoachDecisionIdSchema,
  decision: z.strictObject({
    decisionId: CoachHeroDecisionSchema.shape.decisionId,
    eventSeq: CoachSequence,
    street: CoachHeroDecisionSchema.shape.street,
    logicalPosition: CoachHeroDecisionSchema.shape.logicalPosition,
    visibleState: CoachHeroDecisionSchema.shape.visibleState,
    legalActions: CoachHeroDecisionSchema.shape.legalActions,
    actualAction: PokerActionSchema,
    stacksAndContributions:
      CoachHeroDecisionSchema.shape.stacksAndContributions,
    asOfEventSeq: CoachSequence,
  }),
  derived: CoachModelDerivedFactsSchema,
  assessment: CoachAssessmentFieldsSchema,
})
export const CoachHindsightContextSchema = z.strictObject({
  contextKind: z.literal('hindsight'),
  schemaVersion: z.literal(1),
  decisionId: CoachDecisionIdSchema,
  process: z.strictObject({
    assessment: CoachAssessmentFieldsSchema,
    explanation: CoachDecisionExplanationSchema,
    facts: z.array(CoachPublicFactSchema),
  }),
  facts: CoachHindsightFactsSchema,
})
export type CoachDecisionExplanation = z.infer<
  typeof CoachDecisionExplanationSchema
>
export type CoachHindsightExplanation = z.infer<
  typeof CoachHindsightExplanationSchema
>
export type CoachDerivedFacts = z.infer<typeof CoachDerivedFactsSchema>
export type CoachAssessment = z.infer<typeof CoachAssessmentFieldsSchema>
export type CoachDecisionContext = z.infer<typeof CoachDecisionContextSchema>
export type CoachHindsightContext = z.infer<typeof CoachHindsightContextSchema>
export type CoachModelContext = CoachDecisionContext | CoachHindsightContext

export function validateDecisionExplanation(
  context: CoachDecisionContext,
  value: unknown,
): CoachDecisionExplanation {
  const parsed = CoachDecisionExplanationSchema.parse(value)
  if (parsed.decisionId !== context.decisionId)
    throw new TypeError('coach_decision_mismatch')
  const facts = new Set(context.derived.facts.map((f) => f.factId))
  const candidates = new Map(
    context.derived.candidates.map((c) => [c.candidateId, c]),
  )
  const check = (refs: string[]) => {
    if (refs.some((r) => !facts.has(r)))
      throw new TypeError('coach_fact_reference')
  }
  for (const e of [
    parsed.baselineExplanation,
    parsed.situationExplanation,
    parsed.exploitExplanation,
  ])
    check(e.factRefs)
  if (
    new Set(parsed.alternatives.map((a) => a.candidateId)).size !==
    parsed.alternatives.length
  )
    throw new TypeError('coach_candidate_reference')
  for (const a of parsed.alternatives) {
    const c = candidates.get(a.candidateId)
    if (!c || a.factRefs.some((ref) => !c.evidenceRefs.includes(ref)))
      throw new TypeError('coach_candidate_reference')
    check(a.factRefs)
  }
  return parsed
}
export function validateHindsightExplanation(
  context: CoachHindsightContext,
  value: unknown,
): CoachHindsightExplanation {
  const parsed = CoachHindsightExplanationSchema.parse(value)
  const ids = new Set([
    ...context.process.facts.map((f) => f.factId),
    ...context.facts.revealedHandRanks.map((f) => f.factId),
    ...context.facts.runoutTransitions.map((f) => f.factId),
    ...context.facts.potAwards.map((f) => f.factId),
    ...context.facts.uncalledReturns.map((f) => f.factId),
    ...context.facts.showdownComparisonsByPot.map((f) => f.factId),
  ])
  if (
    parsed.decisionId !== context.decisionId ||
    parsed.hindsightExplanation.factRefs.some((ref) => !ids.has(ref))
  )
    throw new TypeError('coach_hindsight_reference')
  return parsed
}
