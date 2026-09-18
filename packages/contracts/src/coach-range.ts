import { z } from 'zod'

const Id = z.string().min(1).max(160)
const DecisionId = z
  .string()
  .regex(/^[0-9a-fA-F-]{36}:(preflop|flop|turn|river):(0|[1-9][0-9]*)$/)
  .refine(
    (v) =>
      z.uuid().safeParse(v.split(':')[0]).success &&
      Number.isSafeInteger(Number(v.split(':')[2])),
  )
const Finite = z.number().finite()
const Nonnegative = Finite.nonnegative()
const Integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const Version = Integer.positive()
const Seat = z.number().int().min(0).max(8)
const Probability = Finite.min(0).max(1)
const Texts = z.array(z.string().min(1).max(2000))
export const CoachRangeIntervalSchema = z
  .strictObject({ lower: Finite, upper: Finite })
  .refine((v) => v.lower <= v.upper, 'invalid_interval')
export const CoachRangePackRefSchema = z.strictObject({
  datasetId: Id,
  datasetVersion: Version,
})
export const CoachRangeProvenanceSchema = z.strictObject({
  rangeProjectionVersion: Version,
  equityComputationPolicyVersion: Version,
  settlementProjectionVersion: Version,
})
const Common = {
  decisionId: DecisionId,
  rangePackRef: CoachRangePackRefSchema,
  provenance: CoachRangeProvenanceSchema,
}
const Unavailable = z.strictObject({
  ...Common,
  status: z.literal('unavailable'),
  reasonCode: Id,
})
const Position = z.enum([
  'UTG',
  'UTG+1',
  'MP',
  'LJ',
  'HJ',
  'CO',
  'BTN',
  'SB',
  'BB',
])
const Bounds = z
  .strictObject({ min: Nonnegative, max: Nonnegative })
  .refine((v) => v.min <= v.max)
export const CoachRangeApplicabilitySchema = z.strictObject({
  tableSize: z.number().int().min(6).max(9),
  opponentLogicalPosition: Position,
  effectiveStackIntervalBb: Bounds,
  preflopEntryMode: z.enum(['unentered', 'call', 'raise']),
  normalizedPreflopLine: z.array(
    z.strictObject({
      actorPosition: Position,
      action: z.enum(['fold', 'check', 'call', 'bet', 'raise', 'allIn']),
    }),
  ),
  participantTopology: z.strictObject({
    remainingSeatCount: z.number().int().min(2).max(9),
    hasSidePot: z.boolean(),
  }),
  potType: z.enum([
    'singleRaised',
    'threeBet',
    'fourBetOrMore',
    'limped',
    'unraisedPostflop',
    'multiwaySidePot',
    'other',
  ]),
  street: z.enum(['preflop', 'flop', 'turn', 'river']),
})
const Source = z.strictObject({
  sourceId: Id,
  kind: z.enum(['projectCurated', 'professionalReference', 'empiricalStudy']),
  publisher: Id,
  title: Id,
  version: Id,
  authorizationRef: Id,
  reviewedAt: z.iso.datetime(),
  methodology: z.string().min(1).max(2000),
})
const Opponent = z.strictObject({
  seatNumber: Seat,
  logicalPosition: Position,
  initialRangeId: Id,
  matchStatus: z.enum(['matched', 'referenceOnly']),
  applicability: CoachRangeApplicabilitySchema,
  appliedRuleIds: z.array(Id),
  sourceRefs: z.array(Id),
  limitations: Texts,
  differenceCodes: z.array(Id),
  availableComboCount: Integer,
  updateTrace: z.array(
    z.strictObject({
      eventSeq: Integer,
      ruleIds: z.array(Id),
      sourceRefs: z.array(Id),
      unmodeled: z.boolean(),
      adjustments: z.array(
        z.strictObject({
          ruleId: Id,
          weightMultiplierBasisPoints: Integer.max(1000000),
          affectedComboCount: Integer,
          massBefore: Nonnegative,
          massAfter: Nonnegative,
          explanation: z.string().min(1).max(2000),
        }),
      ),
    }),
  ),
})
export const OpponentRangeAnalysisSchema = z.discriminatedUnion('status', [
  Unavailable,
  z.strictObject({
    ...Common,
    status: z.literal('available'),
    sources: z.array(Source).min(1),
    limitations: Texts,
    matchStatus: z.enum(['matched', 'referenceOnly']),
    scenarios: z
      .array(
        z.strictObject({
          scenarioId: Id,
          name: Id,
          sourceRefs: z.array(Id).min(1),
          opponents: z.array(Opponent).min(1).max(8),
        }),
      )
      .min(1)
      .max(3),
  }),
])
const EquityPot = z
  .strictObject({
    potIndex: Integer,
    amount: Integer.positive(),
    eligibleSeatNumbers: z.array(Seat).min(1),
    winProbability: Probability,
    tieProbability: Probability,
    lossProbability: Probability,
    expectedAllocationShare: Probability,
    expectedReturn: Nonnegative,
    standardError: Nonnegative.nullable(),
    confidenceInterval: CoachRangeIntervalSchema.nullable(),
  })
  .superRefine((v, ctx) => {
    if (
      Math.abs(v.winProbability + v.tieProbability + v.lossProbability - 1) >
        1e-6 ||
      Math.abs(v.expectedReturn - v.amount * v.expectedAllocationShare) > 1e-6
    )
      ctx.addIssue({ code: 'custom', message: 'invalid_equity_pot' })
    if (
      v.confidenceInterval &&
      (v.confidenceInterval.lower < 0 ||
        v.confidenceInterval.upper > 1 ||
        v.confidenceInterval.lower > v.expectedAllocationShare ||
        v.confidenceInterval.upper < v.expectedAllocationShare)
    )
      ctx.addIssue({ code: 'custom', message: 'invalid_share_interval' })
  })
const EquityScenario = z
  .strictObject({
    scenarioId: Id,
    method: z.enum(['exactEnumeration', 'monteCarlo']),
    seed: Id.nullable(),
    exactStates: Integer.nullable(),
    proposedSamples: Integer.nullable(),
    acceptedSamples: Integer.nullable(),
    pots: z.array(EquityPot).min(1),
    expectedHeroReturn: Nonnegative,
    totalStandardError: Nonnegative.nullable(),
    totalConfidenceInterval: CoachRangeIntervalSchema.nullable(),
  })
  .superRefine((v, ctx) => {
    const exact = v.method === 'exactEnumeration'
    if (
      exact
        ? v.exactStates === null ||
          v.exactStates === 0 ||
          v.proposedSamples !== null ||
          v.acceptedSamples !== null ||
          v.totalStandardError !== null ||
          v.totalConfidenceInterval !== null ||
          v.pots.some(
            (p) => p.standardError !== null || p.confidenceInterval !== null,
          )
        : v.exactStates !== null ||
          v.seed === null ||
          v.acceptedSamples === null ||
          v.acceptedSamples < 1 ||
          v.proposedSamples === null ||
          v.proposedSamples < v.acceptedSamples ||
          v.totalStandardError === null ||
          v.totalConfidenceInterval === null ||
          v.pots.some(
            (p) => p.standardError === null || p.confidenceInterval === null,
          )
    )
      ctx.addIssue({ code: 'custom', message: 'invalid_computation_metadata' })
    if (
      Math.abs(
        v.expectedHeroReturn -
          v.pots.reduce((sum, p) => sum + p.expectedReturn, 0),
      ) > 1e-6
    )
      ctx.addIssue({ code: 'custom', message: 'invalid_total_return' })
  })
export const JointEquityAnalysisSchema = z.discriminatedUnion('status', [
  Unavailable,
  z.strictObject({
    ...Common,
    status: z.literal('available'),
    evaluationContext: z.enum(['afterCall', 'currentShowdown']),
    assumptions: Texts,
    scenarios: z.array(EquityScenario).min(1).max(3),
  }),
])
export const ConditionalCallEvSchema = z.discriminatedUnion('status', [
  Unavailable,
  z.strictObject({
    ...Common,
    status: z.literal('available'),
    callAction: z.strictObject({ type: z.enum(['call', 'allIn']) }),
    scenarios: z
      .array(
        z
          .strictObject({
            scenarioId: Id,
            expectedHeroReturn: Nonnegative,
            amountActuallyAtRisk: Integer,
            callEvVersusFold: Finite,
            confidenceInterval: CoachRangeIntervalSchema.nullable(),
          })
          .refine(
            (v) =>
              Math.abs(
                v.callEvVersusFold -
                  (v.expectedHeroReturn - v.amountActuallyAtRisk),
              ) <= 1e-6,
            'invalid_call_ev',
          ),
      )
      .min(1)
      .max(3),
  }),
])
export const RangeSensitivitySchema = z.discriminatedUnion('status', [
  Unavailable,
  z
    .strictObject({
      ...Common,
      status: z.literal('available'),
      scenarioIds: z.array(Id).min(2).max(3),
      equityMin: Probability,
      equityMax: Probability,
      callEvMin: Finite.nullable(),
      callEvMax: Finite.nullable(),
      signStable: z.boolean().nullable(),
    })
    .superRefine((v, ctx) => {
      if (
        v.equityMin > v.equityMax ||
        (v.callEvMin === null) !== (v.callEvMax === null) ||
        (v.callEvMin !== null &&
          v.callEvMax !== null &&
          v.callEvMin > v.callEvMax) ||
        (v.callEvMin === null) !== (v.signStable === null)
      )
        ctx.addIssue({ code: 'custom', message: 'invalid_sensitivity' })
    }),
])
export const OpponentRangeChartSpecSchema = z
  .strictObject({
    ...Common,
    schemaVersion: z.literal(1),
    chartId: Id,
    scenarioId: Id,
    seatNumber: Seat,
    logicalPosition: Id,
    matchStatus: z.enum(['matched', 'referenceOnly']),
    rankOrder: z.tuple([
      z.literal('A'),
      z.literal('K'),
      z.literal('Q'),
      z.literal('J'),
      z.literal('T'),
      z.literal('9'),
      z.literal('8'),
      z.literal('7'),
      z.literal('6'),
      z.literal('5'),
      z.literal('4'),
      z.literal('3'),
      z.literal('2'),
    ]),
    cells: z
      .array(
        z.strictObject({
          handClass: Id,
          relativeComboWeightBasisPoints: Integer.max(10000),
          availableComboCount: Integer.max(12),
          normalizedMass: Probability,
        }),
      )
      .length(169),
  })
  .superRefine((chart, ctx) => {
    if (
      new Set(chart.cells.map((c) => c.handClass)).size !== 169 ||
      chart.cells.some(
        (c) =>
          !handClasses.has(c.handClass) ||
          c.availableComboCount >
            (c.handClass.length === 2
              ? 6
              : c.handClass.endsWith('s')
                ? 4
                : 12) ||
          (c.availableComboCount === 0 && c.normalizedMass !== 0),
      ) ||
      Math.abs(chart.cells.reduce((sum, c) => sum + c.normalizedMass, 0) - 1) >
        1e-6
    )
      ctx.addIssue({ code: 'custom', message: 'invalid_chart_cells' })
  })
export const CoachRangeAnalysisFieldsSchema = z.strictObject({
  opponentRangeAnalysis: OpponentRangeAnalysisSchema,
  jointEquityAnalysis: JointEquityAnalysisSchema,
  conditionalCallEv: ConditionalCallEvSchema,
  rangeSensitivity: RangeSensitivitySchema,
  rangeCharts: z.array(OpponentRangeChartSpecSchema),
})
const unique = (v: readonly unknown[]) => new Set(v).size === v.length
const ranks = 'AKQJT98765432'.split('')
const handClasses = new Set(
  ranks.flatMap((a, i) =>
    ranks.map((b, j) => (i === j ? a + b : i < j ? a + b + 's' : b + a + 'o')),
  ),
)
export const CoachRangeAnalysisSchema =
  CoachRangeAnalysisFieldsSchema.superRefine((v, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message })
    const range = v.opponentRangeAnalysis
    for (const object of [
      v.jointEquityAnalysis,
      v.conditionalCallEv,
      v.rangeSensitivity,
      ...v.rangeCharts,
    ]) {
      if (
        object.decisionId !== range.decisionId ||
        JSON.stringify(object.rangePackRef) !==
          JSON.stringify(range.rangePackRef) ||
        JSON.stringify(object.provenance) !== JSON.stringify(range.provenance)
      )
        fail('range_identity_mismatch')
    }
    if (range.status === 'unavailable') {
      if (
        v.jointEquityAnalysis.status !== 'unavailable' ||
        v.conditionalCallEv.status !== 'unavailable' ||
        v.rangeSensitivity.status !== 'unavailable' ||
        v.rangeCharts.length
      )
        fail('unavailable_range_has_results')
      return
    }
    const sourceIds = range.sources.map((s) => s.sourceId)
    if (!unique(sourceIds)) fail('duplicate_source')
    const allMatched = range.scenarios.every((s) =>
      s.opponents.every((o) => o.matchStatus === 'matched'),
    )
    if ((range.matchStatus === 'matched') !== allMatched)
      fail('range_match_status_mismatch')
    const ids = range.scenarios.map((s) => s.scenarioId)
    if (!unique(ids)) fail('duplicate_scenarios')
    for (const scenario of range.scenarios) {
      if (scenario.sourceRefs.some((ref) => !sourceIds.includes(ref)))
        fail('range_source_mismatch')
      if (!unique(scenario.opponents.map((o) => o.seatNumber)))
        fail('duplicate_opponents')
      for (const o of scenario.opponents) {
        if (
          o.sourceRefs.some((ref) => !sourceIds.includes(ref)) ||
          o.updateTrace.some(
            (t) =>
              t.sourceRefs.some((ref) => !sourceIds.includes(ref)) ||
              t.adjustments.some((a) => !t.ruleIds.includes(a.ruleId)),
          )
        )
          fail('range_source_mismatch')
        if (
          !o.availableComboCount ||
          !unique(o.appliedRuleIds) ||
          o.updateTrace.some(
            (t, i) => i > 0 && t.eventSeq < o.updateTrace[i - 1]!.eventSeq,
          )
        )
          fail('invalid_range_trace')
        if (range.matchStatus === 'matched' && o.differenceCodes.length)
          fail('matched_range_difference')
      }
    }
    const equity = v.jointEquityAnalysis
    if (equity.status === 'available') {
      if (
        !unique(equity.scenarios.map((s) => s.scenarioId)) ||
        equity.scenarios.length !== ids.length ||
        equity.scenarios.some((s) => !ids.includes(s.scenarioId))
      )
        fail('equity_scenario_mismatch')
      for (const s of equity.scenarios)
        if (
          !unique(s.pots.map((p) => p.potIndex)) ||
          s.pots.some((p) => !unique(p.eligibleSeatNumbers))
        )
          fail('duplicate_pot_identity')
    }
    const ev = v.conditionalCallEv
    if (ev.status === 'available') {
      if (
        equity.status !== 'available' ||
        !unique(ev.scenarios.map((s) => s.scenarioId)) ||
        ev.scenarios.length !== ids.length
      )
        fail('ev_scenario_mismatch')
      for (const s of ev.scenarios) {
        const e =
          equity.status === 'available'
            ? equity.scenarios.find((e) => e.scenarioId === s.scenarioId)
            : undefined
        if (!e || Math.abs(e.expectedHeroReturn - s.expectedHeroReturn) > 1e-6)
          fail('ev_return_mismatch')
        if (e) {
          const expected = e.totalConfidenceInterval
            ? {
                lower: e.totalConfidenceInterval.lower - s.amountActuallyAtRisk,
                upper: e.totalConfidenceInterval.upper - s.amountActuallyAtRisk,
              }
            : null
          if (JSON.stringify(expected) !== JSON.stringify(s.confidenceInterval))
            fail('ev_interval_mismatch')
        }
      }
    }
    const sensitivity = v.rangeSensitivity
    if (sensitivity.status === 'available') {
      if (
        equity.status !== 'available' ||
        ids.length < 2 ||
        !unique(sensitivity.scenarioIds) ||
        sensitivity.scenarioIds.length !== ids.length ||
        sensitivity.scenarioIds.some((id) => !ids.includes(id))
      )
        fail('sensitivity_scenario_mismatch')
      if (equity.status === 'available') {
        const shares = equity.scenarios.map(
          (s) =>
            s.expectedHeroReturn / s.pots.reduce((sum, p) => sum + p.amount, 0),
        )
        if (
          Math.abs(sensitivity.equityMin - Math.min(...shares)) > 1e-6 ||
          Math.abs(sensitivity.equityMax - Math.max(...shares)) > 1e-6
        )
          fail('sensitivity_equity_mismatch')
      }
      if (ev.status === 'available') {
        const values = ev.scenarios.map((s) => s.callEvVersusFold)
        const stable =
          ev.scenarios.every(
            (s) => (s.confidenceInterval?.lower ?? s.callEvVersusFold) > 0,
          ) ||
          ev.scenarios.every(
            (s) => (s.confidenceInterval?.upper ?? s.callEvVersusFold) < 0,
          )
        if (
          sensitivity.callEvMin !== Math.min(...values) ||
          sensitivity.callEvMax !== Math.max(...values) ||
          sensitivity.signStable !== stable
        )
          fail('sensitivity_ev_mismatch')
      } else if (
        sensitivity.callEvMin !== null ||
        sensitivity.callEvMax !== null ||
        sensitivity.signStable !== null
      )
        fail('unavailable_ev_sensitivity')
    }
    if (!unique(v.rangeCharts.map((c) => c.chartId))) fail('duplicate_chart')
    if (
      v.rangeCharts.length !==
        range.scenarios.reduce((count, s) => count + s.opponents.length, 0) ||
      !unique(
        v.rangeCharts.map((c) => JSON.stringify([c.scenarioId, c.seatNumber])),
      )
    )
      fail('incomplete_range_charts')
    for (const chart of v.rangeCharts) {
      const opponent = range.scenarios
        .find((s) => s.scenarioId === chart.scenarioId)
        ?.opponents.find((o) => o.seatNumber === chart.seatNumber)
      if (
        !opponent ||
        opponent.logicalPosition !== chart.logicalPosition ||
        opponent.matchStatus !== chart.matchStatus
      )
        fail('chart_range_mismatch')
    }
  })
export type CoachRangeAnalysis = z.infer<typeof CoachRangeAnalysisSchema>
export type OpponentRangeAnalysis = z.infer<typeof OpponentRangeAnalysisSchema>
export type JointEquityAnalysis = z.infer<typeof JointEquityAnalysisSchema>
export type ConditionalCallEv = z.infer<typeof ConditionalCallEvSchema>
export type RangeSensitivity = z.infer<typeof RangeSensitivitySchema>
