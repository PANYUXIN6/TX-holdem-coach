import {
  projectCoachRangeFacts,
  COACH_RANGE_FACT_ALGORITHM_VERSION,
  COACH_RANGE_FACT_KINDS,
} from './range-fact-projector.js'
import { assertCertifiedCoachRangeAnalysis } from './range-analysis.js'
import {
  projectCoachDecisionFacts,
  COACH_METRIC_FACT_ALGORITHM_VERSION,
} from './decision-fact-projector.js'
import { assertComputedCoachMetrics } from './decision-metrics.js'
import { assertComputedCoachActionOutcomes } from './action-outcomes.js'
import { isDeepStrictEqual } from 'node:util'
import { CoachAssessmentFieldsSchema } from '@tx-holdem-coach/contracts'
import {
  assertCoachPlainData,
  freezeCoachData,
  CoachDecisionSourceSchema,
  CoachDecisionInputSchema,
  type CoachDecisionSource,
  type CoachDecisionInput,
  type HandReviewCase,
  type CoachHindsightFacts,
} from './review-case.js'
import {
  CoachDerivedFactsSchema,
  CoachDecisionContextSchema,
  CoachHindsightContextSchema,
  validateDecisionExplanation,
  type CoachDerivedFacts,
  type CoachAssessment,
  type CoachDecisionExplanation,
  type CoachDecisionContext,
  type CoachHindsightContext,
  type CoachModelContext,
} from './decision-context.js'
import { createHindsightFactProjector } from './hindsight-context.js'

declare const certifiedInputBrand: unique symbol
declare const assessmentBrand: unique symbol
declare const processBrand: unique symbol
declare const hindsightBrand: unique symbol
const certifiedDecisionInputs = new WeakSet<object>()
export function assertCertifiedCoachDecisionInput(
  input: CertifiedCoachDecisionInput,
): void {
  if (!certifiedDecisionInputs.has(input))
    throw new TypeError('coach_uncertified_input')
}
export type CertifiedCoachDecisionInput = Readonly<CoachDecisionInput> & {
  readonly [certifiedInputBrand]: true
}
export type FrozenDecisionAssessment = Readonly<{
  input: CertifiedCoachDecisionInput
  derived: CoachDerivedFacts
  assessment: CoachAssessment
}> & { readonly [assessmentBrand]: true }
export type FrozenProcessAnalysis = Readonly<{
  analysis: FrozenDecisionAssessment
  explanation: CoachDecisionExplanation
}> & { readonly [processBrand]: true }
export type FrozenHindsightFacts = Readonly<CoachHindsightFacts> & {
  readonly [hindsightBrand]: true
}
const contexts = new WeakMap<
  object,
  { input: CertifiedCoachDecisionInput; source: object; canSend: () => boolean }
>()
export function assertCertifiedCoachContext(
  context: unknown,
): asserts context is CoachModelContext {
  if (typeof context !== 'object' || context === null || !contexts.has(context))
    throw new TypeError('coach_uncertified_context')
}
export function assertCoachContextSendAllowed(
  context: CoachModelContext,
): void {
  assertCertifiedCoachContext(context)
  if (!contexts.get(context)!.canSend())
    throw new TypeError('coach_process_phase_closed')
}
export function coachContextBinding(
  context: CoachModelContext,
): CoachDecisionInput['binding'] {
  assertCertifiedCoachContext(context)
  return contexts.get(context)!.input.binding
}

/** Trust root installed by M8.2/M8.5, never from HTTP/model data. Producers receive
 * only a certified decision, not this source or a callback that reads its audit. */
export function createCoachReviewBoundary(ports: {
  source: CoachDecisionSource
  readHindsightSource: () => unknown
  derive: (input: CertifiedCoachDecisionInput) => CoachDerivedFacts
  classify: (
    input: CertifiedCoachDecisionInput,
    derived: Readonly<CoachDerivedFacts>,
  ) => CoachAssessment
  projectHindsight: (
    source: Readonly<HandReviewCase>,
    decision: CertifiedCoachDecisionInput,
  ) => CoachHindsightFacts
}) {
  assertCoachPlainData(ports.source)
  const source = freezeCoachData(CoachDecisionSourceSchema.parse(ports.source))
  const derive = ports.derive,
    classify = ports.classify
  const inputs = new WeakSet<object>(),
    analyses = new WeakSet<object>(),
    processes = new WeakSet<object>()
  const inputById = new Map<string, CertifiedCoachDecisionInput>(),
    analysisByInput = new WeakMap<object, FrozenDecisionAssessment>(),
    processById = new Map<string, FrozenProcessAnalysis>()
  const decisionContexts = new WeakMap<object, CoachDecisionContext>()
  const hindsightContexts = new WeakMap<object, CoachHindsightContext>()
  let phase: 'process' | 'loadingHindsight' | 'hindsight' | 'failed' = 'process'
  const projector = createHindsightFactProjector({
    decisionSource: source,
    canRead: () => phase === 'loadingHindsight' || phase === 'hindsight',
    readSource: ports.readHindsightSource,
    project: ports.projectHindsight,
  })
  function beginHindsight(): void {
    if (phase === 'hindsight') return
    if (phase !== 'process')
      throw new TypeError('coach_hindsight_admission_failed')
    if (source.heroDecisions.some((d) => !processById.has(d.decisionId)))
      throw new TypeError('coach_process_incomplete')
    // Close even previously prepared Decision requests before the first actual read.
    phase = 'loadingHindsight'
    try {
      projector.prepare()
      phase = 'hindsight'
    } catch (error) {
      phase = 'failed'
      throw error
    }
  }
  function assertHindsightReady(): void {
    if (phase !== 'hindsight') throw new TypeError('coach_hindsight_not_ready')
  }
  const requireInput = (input: CertifiedCoachDecisionInput) => {
    if (!inputs.has(input)) throw new TypeError('coach_uncertified_input')
  }
  const requireAnalysis = (analysis: FrozenDecisionAssessment) => {
    if (!analyses.has(analysis))
      throw new TypeError('coach_uncertified_assessment')
  }
  function projectModelDecision(decision: CoachDecisionInput['decision']) {
    return {
      decisionId: decision.decisionId,
      eventSeq: decision.eventSeq,
      street: decision.street,
      logicalPosition: decision.logicalPosition,
      visibleState: decision.visibleState,
      legalActions: decision.legalActions,
      actualAction: decision.actualAction,
      stacksAndContributions: decision.stacksAndContributions,
      asOfEventSeq: decision.opponentEvidenceCutoff.asOfEventSeq,
    }
  }
  function decisionContext(
    analysis: FrozenDecisionAssessment,
  ): CoachDecisionContext {
    requireAnalysis(analysis)
    const existing = decisionContexts.get(analysis)
    if (existing) return existing
    const context = freezeCoachData(
      CoachDecisionContextSchema.parse({
        contextKind: 'decisionAnalysis',
        schemaVersion: 1,
        decisionId: analysis.input.decision.decisionId,
        decision: projectModelDecision(analysis.input.decision),
        derived: {
          versions: analysis.derived.versions,
          asOfEventSeq: analysis.derived.asOfEventSeq,
          facts: analysis.derived.facts,
          rangeAnalysis: {
            opponentRangeAnalysis:
              analysis.derived.rangeAnalysis.opponentRangeAnalysis,
            jointEquityAnalysis:
              analysis.derived.rangeAnalysis.jointEquityAnalysis,
            conditionalCallEv: analysis.derived.rangeAnalysis.conditionalCallEv,
            rangeSensitivity: analysis.derived.rangeAnalysis.rangeSensitivity,
          },
          opponentEvidence: analysis.derived.opponentEvidence,
        },
        assessment: analysis.assessment,
      }),
    )
    contexts.set(context, {
      input: analysis.input,
      source,
      canSend: () => phase === 'process',
    })
    decisionContexts.set(analysis, context)
    return context
  }
  function certifyDecision(candidate: unknown): CertifiedCoachDecisionInput {
    assertCoachPlainData(candidate)
    const parsed = CoachDecisionInputSchema.parse(candidate)
    const decision = source.heroDecisions.find(
      (d) => d.decisionId === parsed.decision.decisionId,
    )
    if (
      !decision ||
      !isDeepStrictEqual(parsed, {
        reviewContextVersion: source.reviewContextVersion,
        binding: source.binding,
        tableSize: source.tableSize,
        decision,
      })
    )
      throw new TypeError('coach_source_mismatch')
    const existing = inputById.get(decision.decisionId)
    if (existing) return existing
    const input = freezeCoachData(parsed) as CertifiedCoachDecisionInput
    inputs.add(input)
    certifiedDecisionInputs.add(input)
    inputById.set(decision.decisionId, input)
    return input
  }
  function analyze(
    input: CertifiedCoachDecisionInput,
  ): FrozenDecisionAssessment {
    requireInput(input)
    if (phase !== 'process') throw new TypeError('coach_process_phase_closed')
    const existing = analysisByInput.get(input)
    if (existing) return existing
    const raw = derive(input)
    assertCoachPlainData(raw)
    assertComputedCoachMetrics(raw.metrics)
    assertComputedCoachActionOutcomes(raw.actionOutcomes)
    assertCertifiedCoachRangeAnalysis(
      raw.rangeAnalysis,
      input,
      raw.metrics,
      raw.actionOutcomes,
    )
    const rangeFacts = projectCoachRangeFacts(
      input,
      raw.metrics,
      raw.actionOutcomes,
      raw.rangeAnalysis,
    )
    const derived = freezeCoachData(CoachDerivedFactsSchema.parse(raw))
    for (const value of [derived.metrics, derived.actionOutcomes]) {
      if (
        !isDeepStrictEqual(value.binding, input.binding) ||
        value.decisionId !== input.decision.decisionId ||
        value.stateVersion !== input.decision.stateVersion ||
        value.asOfEventSeq !==
          input.decision.opponentEvidenceCutoff.asOfEventSeq
      )
        throw new TypeError('coach_metrics_binding')
    }

    if (
      !isDeepStrictEqual(derived.versions, input.binding.versions) ||
      derived.asOfEventSeq !==
        input.decision.opponentEvidenceCutoff.asOfEventSeq
    )
      throw new TypeError('coach_derivation_binding')
    // Public metric evidence is a projection of the authenticated private result,
    // not an independently trusted output from derive. Producer membership is
    // independent of status; unavailable facts have no value.metric to inspect.
    const metricFacts = projectCoachDecisionFacts(input, derived.metrics)
    for (const fact of derived.facts) {
      const projected = metricFacts.find(
        (expected) =>
          expected.factId === fact.factId ||
          (fact.status === 'available' &&
            'metric' in fact.value &&
            expected.factId === `metrics.${fact.value.metric}`),
      )
      if (
        (fact.algorithmVersion === COACH_METRIC_FACT_ALGORITHM_VERSION ||
          projected ||
          fact.factId.startsWith('metrics.')) &&
        !isDeepStrictEqual(fact, projected)
      )
        throw new TypeError('coach_metric_fact_mismatch')
    }
    for (const fact of derived.facts) {
      const kind = fact.status === 'available' ? fact.value.kind : fact.kind
      const projected = rangeFacts.find(
        (expected) => expected.factId === fact.factId,
      )
      const isRangeFact =
        COACH_RANGE_FACT_KINDS.some((k) => k === kind) ||
        fact.factId.startsWith('range.') ||
        fact.algorithmVersion === COACH_RANGE_FACT_ALGORITHM_VERSION ||
        fact.sourceRefs.some(
          (source) =>
            source.kind === 'algorithm' &&
            source.algorithmId === 'coach.range-fact-projection',
        )
      if (isRangeFact && !isDeepStrictEqual(fact, projected))
        throw new TypeError('coach_range_fact_mismatch')
    }
    const decision = input.decision
    const opponents = decision.stacksAndContributions.filter(
      (s) =>
        s.seatNumber !== decision.visibleState.heroSeat &&
        (s.status === 'active' || s.status === 'allIn'),
    )
    const potType = opponents.length > 1 ? 'multiway' : 'headsUp'
    const facts = new Map(derived.facts.map((f) => [f.factId, f]))
    if (
      facts.size !== derived.facts.length ||
      derived.facts.some(
        (f) =>
          f.scope !== 'decision' ||
          f.asOfEventSeq > derived.asOfEventSeq ||
          f.sourceRefs.some(
            (s) =>
              s.kind === 'event' &&
              (s.sessionId !== input.binding.sessionId ||
                s.handId !== input.binding.handId ||
                s.eventSeq > f.asOfEventSeq),
          ),
      )
    )
      throw new TypeError('coach_derivation_cutoff')
    if (
      derived.facts.some(
        (f) =>
          f.epistemicKind === 'modelGeneratedText' ||
          (f.status === 'available' && f.value.kind === 'assessment'),
      )
    )
      throw new TypeError('coach_unclassified_fact')
    if (
      derived.opponentEvidence.some(
        (e) =>
          e.filters.tableSize !== input.tableSize ||
          e.filters.potType !== potType ||
          !decision.opponentEvidenceSubjects.some(
            (subject) =>
              subject.personaSnapshotId === e.filters.personaSnapshotId &&
              opponents.some(
                (seat) =>
                  seat.seatNumber === subject.seatNumber &&
                  seat.logicalPosition === e.filters.logicalPosition,
              ),
          ) ||
          e.asOfEventSeq > derived.asOfEventSeq ||
          e.policyVersion !== input.binding.versions.opponentEvidence.version,
      )
    )
      throw new TypeError('coach_evidence_binding')
    for (const f of derived.facts) {
      for (const source of f.sourceRefs)
        if (
          source.kind === 'fact' &&
          (!facts.has(source.factId) ||
            facts.get(source.factId)!.asOfEventSeq > f.asOfEventSeq)
        )
          throw new TypeError('coach_fact_reference')
    }
    for (const f of derived.facts)
      if (f.status === 'available') {
        if (
          f.value.kind === 'cards' &&
          f.value.metric === 'board' &&
          !isDeepStrictEqual(f.value.cards, input.decision.visibleState.board)
        )
          throw new TypeError('coach_visible_fact_mismatch')
        if (
          f.value.kind === 'cards' &&
          f.value.metric === 'heroHoleCards' &&
          !isDeepStrictEqual(
            f.value.cards,
            input.decision.visibleState.heroHoleCards,
          )
        )
          throw new TypeError('coach_visible_fact_mismatch')
        if (
          f.value.kind === 'stacks' &&
          !isDeepStrictEqual(
            f.value.seats,
            input.decision.stacksAndContributions,
          )
        )
          throw new TypeError('coach_visible_fact_mismatch')
        if (
          f.value.kind === 'legalActions' &&
          !isDeepStrictEqual(f.value.actions, input.decision.legalActions)
        )
          throw new TypeError('coach_visible_fact_mismatch')
        if (
          f.value.kind === 'actualAction' &&
          !isDeepStrictEqual(f.value.action, input.decision.actualAction)
        )
          throw new TypeError('coach_action_fact_mismatch')
      }
    const rawAssessment = classify(input, derived)
    assertCoachPlainData(rawAssessment)
    const assessment = CoachAssessmentFieldsSchema.parse(rawAssessment)
    const evidenceRefs = [
      ...assessment.evidenceRefs,
      ...assessment.observedDeviationTags.flatMap((t) => t.evidenceRefs),
      ...assessment.teachingHypotheses.flatMap((t) => t.evidenceRefs),
    ]
    if (
      evidenceRefs.some(
        (ref) =>
          !facts.has(ref) ||
          facts.get(ref)!.epistemicKind === 'modelGeneratedText',
      ) ||
      assessment.conditionalConclusionPolicyVersion !==
        input.binding.versions.conclusion.version ||
      assessment.severityPolicyVersion !==
        input.binding.versions.severity.version
    )
      throw new TypeError('coach_assessment_binding')
    const conclusion = assessment.conditionalConclusion
    if (conclusion !== 'insufficientEvidence') {
      const sensitivity = derived.rangeAnalysis.rangeSensitivity
      const ev = derived.rangeAnalysis.conditionalCallEv
      if (sensitivity.status !== 'available' || ev.status !== 'available')
        throw new TypeError('coach_conclusion_evidence')
      if (
        conclusion === 'rangeSensitive'
          ? sensitivity.signStable !== false ||
            !ev.scenarios.some((s) => s.callEvVersusFold < 0) ||
            !ev.scenarios.some((s) => s.callEvVersusFold > 0)
          : sensitivity.signStable !== true
      )
        throw new TypeError('coach_conclusion_evidence')
      if (
        conclusion === 'favorableAcrossModeledRanges' &&
        ev.scenarios.some(
          (s) => (s.confidenceInterval?.lower ?? s.callEvVersusFold) <= 0,
        )
      )
        throw new TypeError('coach_conclusion_evidence')
      if (
        conclusion === 'unfavorableAcrossModeledRanges' &&
        ev.scenarios.some(
          (s) => (s.confidenceInterval?.upper ?? s.callEvVersusFold) >= 0,
        )
      )
        throw new TypeError('coach_conclusion_evidence')
    }
    const analysis = freezeCoachData({
      input,
      derived,
      assessment,
    }) as FrozenDecisionAssessment
    analyses.add(analysis)
    analysisByInput.set(input, analysis)
    return analysis
  }
  function freezeProcess(
    analysis: FrozenDecisionAssessment,
    output: unknown,
  ): FrozenProcessAnalysis {
    requireAnalysis(analysis)
    if (
      phase !== 'process' ||
      processById.has(analysis.input.decision.decisionId)
    )
      throw new TypeError('coach_process_already_frozen')
    assertCoachPlainData(output)
    const explanation = validateDecisionExplanation(
      decisionContext(analysis),
      output,
    )
    const process = freezeCoachData({
      analysis,
      explanation,
    }) as FrozenProcessAnalysis
    processes.add(process)
    processById.set(analysis.input.decision.decisionId, process)
    return process
  }
  function hindsightContext(
    process: FrozenProcessAnalysis,
  ): CoachHindsightContext {
    if (
      !processes.has(process) ||
      source.heroDecisions.some((d) => !processById.has(d.decisionId))
    )
      throw new TypeError('coach_process_incomplete')
    beginHindsight()
    const existing = hindsightContexts.get(process)
    if (existing) return existing
    const input = process.analysis.input
    const facts = projector.project(input)
    if (
      [
        ...facts.revealedHandRanks,
        ...facts.runoutTransitions,
        ...facts.potAwards,
        ...facts.uncalledReturns,
        ...facts.showdownComparisonsByPot,
      ].some((f) =>
        process.analysis.derived.facts.some((d) => d.factId === f.factId),
      )
    )
      throw new TypeError('coach_hindsight_reference_collision')
    const frozen = facts as FrozenHindsightFacts
    const context = freezeCoachData(
      CoachHindsightContextSchema.parse({
        contextKind: 'hindsight',
        schemaVersion: 1,
        decisionId: input.decision.decisionId,
        process: {
          assessment: process.analysis.assessment,
          explanation: process.explanation,
          facts: process.analysis.derived.facts,
        },
        facts: frozen,
      }),
    )
    contexts.set(context, { input, source, canSend: () => true })
    hindsightContexts.set(process, context)
    return context
  }
  return Object.freeze({
    certifyDecision,
    analyze,
    decisionContext,
    freezeProcess,
    hindsightContext,
    beginHindsight,
    assertHindsightReady,
    assertProcess(process: FrozenProcessAnalysis): void {
      if (!processes.has(process))
        throw new TypeError('coach_uncertified_process')
    },
    // Returns safe identities only. Consumers never get the captured source/audit object.
    manifest: freezeCoachData({
      binding: source.binding,
      completedEventSeq: source.completedEventSeq,
      decisionIds: source.heroDecisions.map((d) => d.decisionId),
    }),
  })
}
export type CoachReviewBoundary = ReturnType<typeof createCoachReviewBoundary>
