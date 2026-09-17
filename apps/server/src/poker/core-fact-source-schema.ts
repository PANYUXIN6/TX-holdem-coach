import { z } from 'zod'
import { POKER_RULE_SET_VERSION } from './poker-rule-set.js'
export const CoreFactSourceRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('analysisInputField'),
    path: z.enum([
      'table.buttonSeatNumber',
      'table.seats',
      'hand.street',
      'hand.positions',
      'hand.startingStacks',
      'hand.heroHoleCards',
      'hand.board',
      'hand.pot',
      'hand.bettingRound',
      'hand.legalActions',
      'hand.publicActions',
    ]),
    eventSeq: z.number().int().nonnegative().safe().nullable(),
  }),
  z.strictObject({
    kind: z.literal('ruleSet'),
    pokerRuleSetVersion: z.literal(POKER_RULE_SET_VERSION),
    factId: z.enum([
      'nominalBlinds',
      'standard52CardUnknownUniverse',
      'bettingRoundProgression',
      'contributionLayering',
    ]),
  }),
  z.strictObject({
    kind: z.literal('algorithm'),
    algorithmId: z.enum([
      'spotNormalizer',
      'handFeatureAnalyzer',
      'contestablePotProjector',
      'decisionMetricsEngine',
      'legalCandidateFactory',
      'candidateOutcomeProjector',
    ]),
    version: z.literal(1),
  }),
])
