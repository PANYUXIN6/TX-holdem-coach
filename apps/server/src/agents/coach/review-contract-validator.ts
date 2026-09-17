import { isDeepStrictEqual } from 'node:util'
import {
  CoachReviewSchema,
  type CoachPublicFact,
  type CoachReview,
  type CoachDecisionReview,
  type CoachReviewId,
  type Card,
} from '@tx-holdem-coach/contracts'
import {
  assertCertifiedCoachContext,
  coachContextBinding,
  type CoachReviewBoundary,
  type FrozenProcessAnalysis,
} from './frozen-analysis.js'
import {
  validateHindsightExplanation,
  type CoachHindsightContext,
} from './decision-context.js'
import { freezeCoachData } from './review-case.js'

type Presentation = Pick<
  CoachReview,
  | 'overview'
  | 'decisionPrioritySummary'
  | 'teachingProjection'
  | 'keyLessons'
  | 'practiceSuggestions'
>
export interface CoachCompletedDecision {
  readonly process: FrozenProcessAnalysis
  readonly hindsightContext: CoachHindsightContext
  readonly hindsightOutput: unknown
}
function handClass(cards: readonly Card[]): string {
  const order = 'AKQJT98765432',
    [a, b] = [...cards].sort(
      (a, b) => order.indexOf(a.rank) - order.indexOf(b.rank),
    )
  return a!.rank === b!.rank
    ? a!.rank + b!.rank
    : a!.rank + b!.rank + (a!.suit === b!.suit ? 's' : 'o')
}
function publicHindsight(
  context: CoachHindsightContext,
  completedEventSeq: number,
  process: FrozenProcessAnalysis,
): { facts: CoachPublicFact[]; map: Map<string, string> } {
  const binding = process.analysis.input.binding
  const facts: CoachPublicFact[] = [],
    map = new Map<string, string>()
  const add = (
    privateId: string | null,
    value: Extract<CoachPublicFact, { status: 'available' }>['value'],
  ) => {
    const factId = `hindsight.${facts.length}`
    if (process.analysis.derived.facts.some((f) => f.factId === factId))
      throw new TypeError('coach_public_fact_collision')
    if (privateId !== null) {
      if (map.has(privateId)) throw new TypeError('coach_public_fact_collision')
      map.set(privateId, factId)
    }
    facts.push({
      factId,
      scope: 'hindsight',
      status: 'available',
      epistemicKind: 'ruleFact',
      sourceRefs: [
        {
          kind: 'event',
          sessionId: binding.sessionId,
          handId: binding.handId,
          eventSeq: completedEventSeq,
        },
      ],
      schemaVersion: 1,
      algorithmVersion: null,
      dataVersion: null,
      asOfEventSeq: completedEventSeq,
      assumptions: [],
      value,
    })
  }
  for (const r of context.facts.revealedHandRanks)
    add(r.factId, {
      kind: 'handCategory',
      seatNumber: r.seatNumber,
      category: r.category,
      description: r.category,
    })
  for (const r of context.facts.runoutTransitions)
    add(r.factId, { kind: 'cards', metric: 'actualRunout', cards: r.board })
  for (const p of context.facts.potAwards)
    add(p.factId, {
      kind: 'potAward',
      potId: p.potId,
      eligibleSeats: p.eligibleSeats,
      winnerSeats: p.winnerSeats,
      awards: p.awards,
    })
  for (const r of context.facts.uncalledReturns)
    add(r.factId, {
      kind: 'uncalledReturn',
      seatNumber: r.seatNumber,
      chips: r.chips,
    })
  // Comparison references resolve to public actual pot facts, never to a renamed tuple.
  for (const c of context.facts.showdownComparisonsByPot) {
    const pot = context.facts.potAwards.find((p) => p.potId === c.potId),
      publicId = pot && map.get(pot.factId)
    if (!publicId) throw new TypeError('coach_unprojectable_reference')
    if (map.has(c.factId)) throw new TypeError('coach_public_fact_collision')
    map.set(c.factId, publicId)
  }
  // Synthetic facts have no private identity and must not overwrite source references.
  add(null, { kind: 'heroNetChips', value: context.facts.heroNetChips })
  if (context.facts.actualContinuation.length)
    add(null, {
      kind: 'actualContinuation',
      actions: context.facts.actualContinuation,
    })
  return { facts, map }
}
function composeDecision(
  boundary: CoachReviewBoundary,
  item: CoachCompletedDecision,
): CoachDecisionReview {
  const p = item.process
  boundary.assertProcess(p)
  assertCertifiedCoachContext(item.hindsightContext)
  if (
    item.hindsightContext !== boundary.hindsightContext(p) ||
    !isDeepStrictEqual(
      coachContextBinding(item.hindsightContext),
      p.analysis.input.binding,
    )
  )
    throw new TypeError('coach_hindsight_binding')
  const hindsight = validateHindsightExplanation(
    item.hindsightContext,
    item.hindsightOutput,
  )
  const { input, derived, assessment } = p.analysis,
    { decision } = input,
    e = p.explanation
  const projected = publicHindsight(
    item.hindsightContext,
    boundary.manifest.completedEventSeq,
    p,
  )
  const chart = derived.rangeChart
  if (
    chart &&
    chart.highlightedHandClass !==
      handClass(decision.visibleState.heroHoleCards)
  )
    throw new TypeError('coach_range_highlight')
  const boardRefs = derived.facts
    .filter(
      (f) =>
        f.status === 'available' &&
        f.value.kind === 'cards' &&
        f.value.metric === 'board',
    )
    .map((f) => f.factId)
  const publicRefs = new Set(derived.facts.map((f) => f.factId))
  const hindsightRefs = hindsight.hindsightExplanation.factRefs.map((ref) => {
    const publicRef = publicRefs.has(ref) ? ref : projected.map.get(ref)
    if (!publicRef) throw new TypeError('coach_unprojectable_reference')
    return publicRef
  })
  // Every assignment here is from an authenticated deterministic result or a
  // previously validated, phase-specific explanation. No model root is spread.
  return {
    decisionId: decision.decisionId,
    street: decision.street,
    boardContext: { cards: decision.visibleState.board, factRefs: boardRefs },
    actualAction: decision.actualAction,
    assessment: assessment.assessment,
    assessmentBasis: assessment.assessmentBasis,
    epistemicStatus: assessment.epistemicStatus,
    decisionGrade: assessment.decisionGrade,
    decisionGradePolicyVersion: assessment.decisionGradePolicyVersion,
    primaryDeviationCode: assessment.primaryDeviationCode,
    observedDeviationTags: assessment.observedDeviationTags,
    mistakeTaxonomyVersion: assessment.mistakeTaxonomyVersion,
    teachingHypotheses: assessment.teachingHypotheses,
    severity: assessment.severity,
    severityBasis: assessment.severityBasis,
    severityPolicyVersion: assessment.severityPolicyVersion,
    baselineComparison: assessment.baselineComparison,
    evLoss: assessment.evLoss,
    evidenceRefs: assessment.evidenceRefs,
    factManifest: [...derived.facts, ...projected.facts],
    baselineLayer: {
      baseline: derived.baseline,
      explanation: e.baselineExplanation,
      rangeChartId: chart?.chartId ?? null,
    },
    situationLayer: {
      factRefs: derived.facts.map((f) => f.factId),
      explanation: e.situationExplanation,
    },
    exploitLayer: {
      status: derived.opponentEvidence.some((e) => e.usableForExploit)
        ? 'evidenceSupported'
        : 'insufficientEvidence',
      evidence: derived.opponentEvidence,
      explanation: e.exploitExplanation,
      deviationExplanation: null,
    },
    alternatives: e.alternatives.map((a) => ({
      text: a.explanation,
      factRefs: [...a.factRefs],
    })),
    hindsightExplanation: {
      text: hindsight.hindsightExplanation.text,
      factRefs: [...new Set(hindsightRefs)],
    },
  }
}
/** The supplied policy is deterministic application code (M8.5), not model text.
 * Freeze its result once and reuse the exact validator for persistence admission. */
export function createCoachReviewContractValidator(input: {
  boundary: CoachReviewBoundary
  coachReviewId: CoachReviewId
  decisions: readonly CoachCompletedDecision[]
  projectTeaching: (decisions: readonly FrozenProcessAnalysis[]) => Presentation
}) {
  const { boundary } = input
  boundary.assertHindsightReady()
  if (
    !isDeepStrictEqual(
      input.decisions.map((d) => d.process.analysis.input.decision.decisionId),
      boundary.manifest.decisionIds,
    )
  )
    throw new TypeError('coach_incomplete_review')
  const reviews = input.decisions.map((d) => composeDecision(boundary, d))
  const presentation = input.projectTeaching(
    Object.freeze(input.decisions.map((d) => d.process)),
  )
  const largest = presentation.decisionPrioritySummary.largestEvLossDecision
  if (largest.status === 'available') {
    const available = input.decisions
      .map((d) => d.process.analysis.assessment.evLoss)
      .filter((ev) => ev.status !== 'unavailable')
    const first = available[0]
    if (
      !first ||
      available.some(
        (ev) =>
          ev.method !== first.method ||
          ev.sourceVersion !== first.sourceVersion ||
          !isDeepStrictEqual(ev.assumptions, first.assumptions),
      )
    )
      throw new TypeError('coach_incomparable_ev')
  }
  const allLessons = input.decisions.flatMap(
      (d) => d.process.explanation.keyLessons,
    ),
    allSuggestions = input.decisions.flatMap(
      (d) => d.process.explanation.practiceSuggestions,
    )
  if (
    presentation.keyLessons.some((l) => !allLessons.includes(l)) ||
    presentation.practiceSuggestions.some((l) => !allSuggestions.includes(l)) ||
    presentation.teachingProjection.projectionPolicyVersion !==
      boundary.manifest.binding.versions.teaching.version
  )
    throw new TypeError('coach_teaching_policy_binding')
  const expected = freezeCoachData(
    CoachReviewSchema.parse({
      schemaVersion: 1,
      coachReviewId: input.coachReviewId,
      handId: boundary.manifest.binding.handId,
      overview: presentation.overview,
      decisionPrioritySummary: presentation.decisionPrioritySummary,
      teachingProjection: presentation.teachingProjection,
      decisionReviews: reviews,
      keyLessons: presentation.keyLessons,
      practiceSuggestions: presentation.practiceSuggestions,
      rangeCharts: input.decisions.flatMap((d) =>
        d.process.analysis.derived.rangeChart
          ? [d.process.analysis.derived.rangeChart]
          : [],
      ),
    }),
  )
  return Object.freeze({
    review: expected,
    validate(value: unknown): CoachReview {
      const report = CoachReviewSchema.parse(value)
      if (!isDeepStrictEqual(report, expected))
        throw new TypeError('coach_frozen_report_mismatch')
      return freezeCoachData(report)
    },
  })
}
