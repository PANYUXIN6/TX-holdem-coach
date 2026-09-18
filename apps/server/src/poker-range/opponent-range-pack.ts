import { z } from 'zod'
import { POKER_RULE_SET_VERSION } from '../poker/poker-rule-set.js'

export const RANGE_RANKS = [
  'A',
  'K',
  'Q',
  'J',
  'T',
  '9',
  '8',
  '7',
  '6',
  '5',
  '4',
  '3',
  '2',
] as const
export const RANGE_SUITS = ['clubs', 'diamonds', 'hearts', 'spades'] as const
export interface Card {
  readonly rank: (typeof RANGE_RANKS)[number]
  readonly suit: (typeof RANGE_SUITS)[number]
}
export const RANGE_HAND_CLASSES = Object.freeze(
  RANGE_RANKS.flatMap((a, i) =>
    RANGE_RANKS.map((b, j) =>
      i === j ? a + b : i < j ? a + b + 's' : b + a + 'o',
    ),
  ),
)
const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/)
const text = z.string().trim().min(1)
const position = z.enum([
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
const action = z.enum(['fold', 'check', 'call', 'bet', 'raise', 'allIn'])
const street = z.enum(['preflop', 'flop', 'turn', 'river'])
const interval = z
  .strictObject({
    min: z.number().finite().nonnegative(),
    max: z.number().finite().nonnegative(),
  })
  .refine((value) => value.min <= value.max, 'invalid_interval')
export const RangeApplicabilitySchema = z.strictObject({
  tableSize: z.union([z.literal(6), z.literal(7), z.literal(8), z.literal(9)]),
  opponentLogicalPosition: position,
  effectiveStackIntervalBb: interval,
  preflopEntryMode: z.enum(['unentered', 'call', 'raise']),
  normalizedPreflopLine: z.array(
    z.strictObject({ actorPosition: position, action }),
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
  street,
})
export const RangeWeightSchema = z.strictObject({
  handClass: z.string().refine((value) => RANGE_HAND_CLASSES.includes(value)),
  relativeComboWeightBasisPoints: z.number().int().min(0).max(10000),
})
const sourceRefs = z.array(id).min(1)
const initialRange = z.strictObject({
  rangeId: id,
  sourceRefs,
  applicability: RangeApplicabilitySchema,
  matchStatus: z.enum(['matched', 'referenceOnly']),
  differences: z.array(text),
  limitations: z.array(text),
  weights: z.array(RangeWeightSchema).length(169),
})
const boardPredicate = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('any') }),
  z.strictObject({ kind: z.literal('paired'), value: z.boolean() }),
  z.strictObject({
    kind: z.literal('maxSuitCount'),
    count: z.number().int().min(1).max(5),
  }),
])
const handPredicate = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('handClasses'),
    handClasses: z.array(RangeWeightSchema.shape.handClass).min(1),
  }),
  z.strictObject({ kind: z.literal('any') }),
])
export const RangeUpdateRuleSchema = z.strictObject({
  ruleId: id,
  sourceRefs,
  // Selects the declared current range node; never claims historical state matching.
  rangeNodeApplicability: RangeApplicabilitySchema,
  street,
  observedAction: action,
  // Historical contributionDelta / potBefore; null means the source imposes no size filter.
  betSizeInterval: interval.nullable(),
  boardPredicate,
  handPredicate,
  weightMultiplierBasisPoints: z.number().int().min(0).max(1000000),
  explanation: text,
  limitations: z.array(text),
})
export const OpponentRangePackSchema = z
  .strictObject({
    opponentRangePackSchemaVersion: z.literal(1),
    datasetId: id,
    datasetVersion: z.number().int().positive().safe(),
    status: z.enum(['active', 'deprecated', 'revoked']),
    pokerRuleSetVersion: z.literal(POKER_RULE_SET_VERSION),
    sources: z
      .array(
        z.strictObject({
          sourceId: id,
          kind: z.enum([
            'projectCurated',
            'professionalReference',
            'empiricalStudy',
          ]),
          publisher: text,
          title: text,
          version: text,
          authorizationRef: text,
          reviewedAt: z.iso.datetime(),
          methodology: text,
        }),
      )
      .min(1),
    coverageManifest: z.array(
      z.strictObject({
        rangeId: id,
        status: z.enum(['matched', 'referenceOnly']),
        limitations: z.array(text),
      }),
    ),
    initialRanges: z.array(initialRange),
    updateRules: z.array(RangeUpdateRuleSchema),
    jointScenarios: z
      .array(
        z.strictObject({
          scenarioId: id,
          name: text,
          sourceRefs,
          initialRangeIds: z.array(id).min(1),
          updateRuleIds: z.array(id),
          allowUnmodeledActions: z.boolean(),
          limitations: z.array(text),
        }),
      )
      .max(3),
    limitations: z.array(text),
  })
  .superRefine((pack, context) => {
    const issue = (message: string) =>
      context.addIssue({ code: 'custom', message })
    const unique = (values: readonly string[]) =>
      new Set(values).size === values.length
    for (const values of [
      pack.sources.map((v) => v.sourceId),
      pack.initialRanges.map((v) => v.rangeId),
      pack.updateRules.map((v) => v.ruleId),
      pack.jointScenarios.map((v) => v.scenarioId),
      pack.coverageManifest.map((v) => v.rangeId),
    ]) {
      if (!unique(values)) issue('duplicate_identity')
    }
    const sources = new Set(pack.sources.map((v) => v.sourceId))
    for (const item of [
      ...pack.initialRanges,
      ...pack.updateRules,
      ...pack.jointScenarios,
    ]) {
      if (item.sourceRefs.some((ref) => !sources.has(ref)))
        issue('unknown_source')
    }
    for (const range of pack.initialRanges) {
      const allowedPositions = {
        6: ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
        7: ['UTG', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
        8: ['UTG', 'MP', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
        9: ['UTG', 'UTG+1', 'MP', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
      }[range.applicability.tableSize]
      if (
        !allowedPositions.includes(
          range.applicability.opponentLogicalPosition,
        ) ||
        range.applicability.normalizedPreflopLine.some(
          (entry) => !allowedPositions.includes(entry.actorPosition),
        )
      )
        issue('invalid_table_position')
      if (!unique(range.weights.map((v) => v.handClass)))
        issue('duplicate_hand_class')
      if (!range.weights.some((v) => v.relativeComboWeightBasisPoints > 0))
        issue('empty_range')
      const coverage = pack.coverageManifest.find(
        (v) => v.rangeId === range.rangeId,
      )
      if (!coverage || coverage.status !== range.matchStatus)
        issue('missing_coverage')
      if (
        range.matchStatus === 'referenceOnly' &&
        (!range.differences.length || !range.limitations.length)
      )
        issue('reference_requires_limits')
    }
    for (const coverage of pack.coverageManifest) {
      if (!pack.initialRanges.some((v) => v.rangeId === coverage.rangeId))
        issue('unknown_coverage')
    }
    for (const scenario of pack.jointScenarios) {
      if (!unique(scenario.initialRangeIds) || !unique(scenario.updateRuleIds))
        issue('duplicate_scenario_reference')
      if (
        scenario.initialRangeIds.some(
          (ref) => !pack.initialRanges.some((v) => v.rangeId === ref),
        ) ||
        scenario.updateRuleIds.some(
          (ref) => !pack.updateRules.some((v) => v.ruleId === ref),
        )
      )
        issue('unknown_scenario_reference')
    }
    if (pack.initialRanges.length > 0 && pack.jointScenarios.length === 0)
      issue('missing_scenario')
  })
export type OpponentRangePack = z.infer<typeof OpponentRangePackSchema>
export type RangeApplicability = z.infer<typeof RangeApplicabilitySchema>
export type RangeWeight = z.infer<typeof RangeWeightSchema>
export type RangeUpdateRule = z.infer<typeof RangeUpdateRuleSchema>
export interface OpponentRangePackReference {
  readonly datasetId: string
  readonly datasetVersion: number
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
export function parseOpponentRangePack(value: unknown): OpponentRangePack {
  return freeze(OpponentRangePackSchema.parse(value))
}
