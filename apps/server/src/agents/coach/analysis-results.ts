import { z } from 'zod'
import { PokerActionSchema } from '@tx-holdem-coach/contracts'
import { createDecisionAnalysisSchemas } from '../../poker/decision-analysis-schema.js'
import { CoreFactSourceRefSchema } from '../../poker/core-fact-source-schema.js'
import { createActionOutcomeSchema } from '../../poker/action-outcome-schema.js'
import { CoachBindingSchema, CoachSequence } from './review-case.js'
export const CoachMetricSourceSchema = z.strictObject({
  decisionId: z.string(),
  asOfEventSeq: z.number().int().nonnegative().safe(),
  source: z.union([
    CoreFactSourceRefSchema,
    z.strictObject({
      kind: z.literal('streetStartState'),
      eventSeq: CoachSequence,
      fields: z.tuple([z.literal('seats'), z.literal('pot')]),
    }),
  ]),
})
const core = createDecisionAnalysisSchemas(CoreFactSourceRefSchema)
export const COACH_METRICS_VERSION = Object.freeze({
  id: 'coach.review.metrics',
  version: 1,
})
const ratio = z.strictObject({
  numerator: CoachSequence,
  denominator: CoachSequence.positive(),
  basisPoints: CoachSequence,
})
export const CoachDecisionMetricsSchema = z.strictObject({
  binding: CoachBindingSchema,
  decisionId: z.string(),
  stateVersion: CoachSequence,
  asOfEventSeq: CoachSequence,
  normalizedSpot: core.NormalizedDecisionSpotSchema,
  handFeatures: core.HandFeatureAnalysisSchema,
  contestablePot: core.ContestablePotProjectionSchema,
  currentMetrics: core.DecisionMetricsSchema,
  streetStartMetrics: z.discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('notApplicable'),
      reasonCode: z.literal('preflop'),
    }),
    z.strictObject({
      status: z.literal('available'),
      eventSeq: CoachSequence,
      heroContestablePot: CoachSequence,
      byOpponent: z.array(
        z.strictObject({
          opponentSeatNumber: CoachSequence,
          effectiveStack: CoachSequence,
          spr: ratio,
        }),
      ),
    }),
  ]),
  factManifest: z.array(
    z.strictObject({
      factId: z.string().regex(/^metrics\.[A-Za-z0-9_.]+$/),
      valuePath: z
        .string()
        .regex(
          /^(normalizedSpot|handFeatures|contestablePot|currentMetrics|streetStartMetrics)(\.[A-Za-z0-9_]+)*$/,
        ),
      status: z.enum(['available', 'unavailable', 'notApplicable']),
      epistemicKind: z.enum([
        'ruleFact',
        'formulaFact',
        'rangeAssumption',
        'statisticalEvidence',
        'heuristicJudgment',
      ]),
      sourceRefs: z.array(CoachMetricSourceSchema),
      assumptionCodes: z.array(z.string()),
      reasonCode: z.string().nullable(),
    }),
  ),
  algorithmVersions: z.strictObject({
    spotSchema: z.literal(1),
    normalizer: z.literal(1),
    handFeatureSchema: z.literal(1),
    handFeatureAnalyzer: z.literal(1),
    potSchema: z.literal(1),
    potProjector: z.literal(1),
    metricsSchema: z.literal(1),
    metricsEngine: z.literal(1),
    actionOutcomeSchema: z.literal(1),
    actionOutcomeProjector: z.literal(1),
    coachAdapter: z.literal(1),
    streetStart: z.literal(1),
  }),
})
export type CoachDecisionMetrics = z.infer<typeof CoachDecisionMetricsSchema>
export const CoachActionOutcomesSchema = z.strictObject({
  binding: CoachBindingSchema,
  decisionId: z.string(),
  stateVersion: CoachSequence,
  asOfEventSeq: CoachSequence,
  outcomes: z
    .array(
      z.strictObject({
        action: PokerActionSchema,
        references: z
          .array(
            z.discriminatedUnion('kind', [
              z.strictObject({
                kind: z.literal('actual'),
                eventSeq: CoachSequence,
              }),
              z.strictObject({
                kind: z.literal('callComparison'),
              }),
            ]),
          )
          .min(1),
        result: createActionOutcomeSchema(CoreFactSourceRefSchema),
      }),
    )
    .min(1),
})
export type CoachActionOutcomes = z.infer<typeof CoachActionOutcomesSchema>
