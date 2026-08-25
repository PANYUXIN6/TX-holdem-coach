import { createHash } from 'node:crypto'
import { CardSchema } from '@tx-holdem-coach/contracts'
import { z } from 'zod'
import { canonicalJson, type JsonValue } from '../../persisted-json.js'
import { POKER_RULE_SET_VERSION } from '../../poker/poker-rule-set.js'
import { Sha256DigestSchema } from '../audit/audit-primitives.js'
import {
  MODEL_FACT_REASON_CODES_V1,
  ModelFactReasonCodeV1Schema,
  PLAYER_FACT_CONCEPTS_V1,
  PLAYER_FACT_MANIFEST_DESCRIPTOR_V1,
  isDecisionAuditSnapshotV1,
  type DecisionAuditSnapshotV1,
  type ModelFactReasonCodeV1,
} from './player-decision-audit.js'
import type { PlayerDecisionPreprocessingResultData } from './player-decision-preprocessor.js'

const SafeNonnegativeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
const SafePositiveIntegerSchema = SafeNonnegativeIntegerSchema.min(1)
const BasisPointsSchema = z.number().int().min(0).max(10_000)
const FactCodeSchema = z.number().int().min(0).max(31)
const FactIdsSchema = z
  .array(FactCodeSchema)
  .min(1)
  .max(4)
  .refine((value) => new Set(value).size === value.length)
const ExactRatioSchema = z.strictObject({
  numerator: SafeNonnegativeIntegerSchema,
  denominator: SafePositiveIntegerSchema,
  basisPoints: SafeNonnegativeIntegerSchema,
})
const CardRankSchema = z.enum([
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  'T',
  'J',
  'Q',
  'K',
  'A',
])
const LogicalPositionSchema = z.enum([
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
const HandCategorySchema = z.enum([
  'highCard',
  'onePair',
  'twoPair',
  'threeOfAKind',
  'straight',
  'flush',
  'fullHouse',
  'fourOfAKind',
  'straightFlush',
])
const DrawTypeSchema = z.enum([
  'flushDraw',
  'openEndedStraightDraw',
  'gutshot',
  'doubleGutshot',
  'comboDraw',
])
const ModelActorIdV1Schema = z.enum([
  'hero',
  'opponent-1',
  'opponent-2',
  'opponent-3',
  'opponent-4',
  'opponent-5',
  'opponent-6',
  'opponent-7',
  'opponent-8',
])

function factStateSchema<T extends z.ZodType>(valueSchema: T) {
  return z.discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('available'),
      value: valueSchema,
      factIds: FactIdsSchema,
    }),
    z.strictObject({
      status: z.literal('unavailable'),
      reasonCode: ModelFactReasonCodeV1Schema,
      factIds: FactIdsSchema,
    }),
    z.strictObject({
      status: z.literal('notApplicable'),
      reasonCode: ModelFactReasonCodeV1Schema,
      factIds: FactIdsSchema,
    }),
  ])
}

const PlayerCountFactsSchema = z.strictObject({
  dealtCount: SafeNonnegativeIntegerSchema,
  remainingSeatCount: SafeNonnegativeIntegerSchema,
  notFoldedCount: SafeNonnegativeIntegerSchema,
  activeCount: SafeNonnegativeIntegerSchema,
  allInCount: SafeNonnegativeIntegerSchema,
  voluntaryPreflopParticipantCount: SafeNonnegativeIntegerSchema,
  currentlyOwingActionCount: SafeNonnegativeIntegerSchema,
})
const PreflopNodeSchema = z.strictObject({
  kind: z.enum([
    'unopened',
    'limped',
    'singleRaised',
    'squeezed',
    'threeBet',
    'fourBetOrMore',
    'shortAllInTree',
    'notApplicable',
  ]),
  fullRaiseCount: SafeNonnegativeIntegerSchema,
  limperCount: SafeNonnegativeIntegerSchema,
  callerCount: SafeNonnegativeIntegerSchema,
  hasShortAllInRaise: z.boolean(),
})
const PotTypeSchema = z.strictObject({
  kind: z.enum([
    'singleRaised',
    'threeBet',
    'fourBetOrMore',
    'limped',
    'unraisedPostflop',
    'multiwaySidePot',
    'other',
  ]),
  isHeadsUp: z.boolean(),
  isMultiway: z.boolean(),
  hasSidePot: z.boolean(),
})

export const ModelActionLineCodeV1Schema = z
  .string()
  .max(12_299)
  .refine(
    (value) =>
      value === '' ||
      /^(?:[0-3][0-8][0-6]:(?:0|[1-9]\d{0,6}))(?:;(?:[0-3][0-8][0-6]:(?:0|[1-9]\d{0,6}))){0,1024}$/.test(
        value,
      ),
  )

const ModelSpotV1Schema = z.strictObject({
  street: z.enum(['preflop', 'flop', 'turn', 'river']),
  tableSize: z.union([z.literal(6), z.literal(7), z.literal(8), z.literal(9)]),
  heroPosition: LogicalPositionSchema,
  playerCounts: PlayerCountFactsSchema,
  playersBehindHeroCount: z.number().int().min(0).max(8),
  bigBlindOptionAvailable: z.boolean(),
  preflopNode: PreflopNodeSchema,
  potType: PotTypeSchema,
  heroHasPreflopInitiative: z.boolean().nullable(),
  heroHasCurrentStreetInitiative: z.boolean().nullable(),
  raiseReopenedForHero: z.boolean(),
  actionLineCode: ModelActionLineCodeV1Schema,
  factIds: FactIdsSchema,
})

const ModelHandV1Schema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('preflop'),
    heroHoleCards: z.tuple([CardSchema, CardSchema]),
    board: z.tuple([]),
    startingHandClass: z.string().regex(/^[2-9TJQKA]{2}(?:s|o)?$/),
    isPair: z.boolean(),
    isSuited: z.boolean(),
    rankGap: factStateSchema(SafeNonnegativeIntegerSchema),
    isConnector: z.boolean(),
    isBroadway: z.boolean(),
    aceWheelPotential: z.boolean(),
    highRank: CardRankSchema,
    lowRank: CardRankSchema,
    factIds: FactIdsSchema,
  }),
  z.strictObject({
    kind: z.literal('postflop'),
    heroHoleCards: z.tuple([CardSchema, CardSchema]),
    board: z.union([
      z.tuple([CardSchema, CardSchema, CardSchema]),
      z.tuple([CardSchema, CardSchema, CardSchema, CardSchema]),
      z.tuple([CardSchema, CardSchema, CardSchema, CardSchema, CardSchema]),
    ]),
    handCategory: HandCategorySchema,
    handRankTuple: z.array(SafeNonnegativeIntegerSchema).max(6),
    holeCardsUsed: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    pairRelation: z.enum([
      'none',
      'pocketPairBelowBoard',
      'overpair',
      'topPair',
      'middlePair',
      'bottomPair',
      'boardPairOnly',
      'twoPairUsingHole',
      'set',
      'tripsUsingOneHole',
      'other',
    ]),
    kickerRanks: z.array(CardRankSchema).max(5),
    madeHandUsesBoardOnly: z.boolean(),
    boardStructure: z.strictObject({
      suitPattern: z.enum(['monotone', 'twoTone', 'rainbow', 'mixed']),
      maxSuitCount: SafeNonnegativeIntegerSchema,
      pairedRanks: z.array(CardRankSchema).max(2),
      tripRanks: z.array(CardRankSchema).max(1),
      maximumConsecutiveRankRun: SafeNonnegativeIntegerSchema,
      candidateStraightWindowCount: SafeNonnegativeIntegerSchema,
    }),
    drawTypes: z.array(DrawTypeSchema).max(5),
    structuralOutSummary: factStateSchema(
      z.strictObject({
        distinctCardCount: SafeNonnegativeIntegerSchema,
        byResultingCategory: z
          .array(
            z.strictObject({
              category: HandCategorySchema,
              distinctCardCount: SafeNonnegativeIntegerSchema,
            }),
          )
          .max(9),
        improvementKinds: z
          .array(
            z.enum([
              'higherCategory',
              'higherGrade',
              'completesFlush',
              'completesStraight',
              'pairsVisibleRank',
            ]),
          )
          .max(5),
      }),
    ),
    absoluteNuts: factStateSchema(z.boolean()),
    counterfeitRiskSummary: factStateSchema(
      z.strictObject({
        distinctCardCount: SafeNonnegativeIntegerSchema,
        reasonCodes: z
          .array(
            z.enum([
              'holeCardsUsedDecreases',
              'boardPairs',
              'boardMakesSharedHand',
              'pairStructureChanges',
            ]),
          )
          .max(4),
      }),
    ),
    factIds: FactIdsSchema,
  }),
])

const ModelMetricsV1Schema = z.strictObject({
  amountToCall: SafeNonnegativeIntegerSchema,
  currentStreetContribution: SafeNonnegativeIntegerSchema,
  currentTotalContribution: SafeNonnegativeIntegerSchema,
  heroContestablePotBefore: SafeNonnegativeIntegerSchema,
  heroMaximumContestableAmount: SafeNonnegativeIntegerSchema,
  potOdds: factStateSchema(ExactRatioSchema),
  currentSpr: factStateSchema(
    z.strictObject({
      byOpponent: z
        .array(
          z.strictObject({
            opponentId: ModelActorIdV1Schema,
            effectiveStack: SafeNonnegativeIntegerSchema,
            spr: ExactRatioSchema,
          }),
        )
        .max(8),
      maximumOpponentEffectiveSpr: ExactRatioSchema,
    }),
  ),
  factIds: FactIdsSchema,
})

const ModelDecisionPoliciesV1Schema = z.strictObject({
  candidateSource: z.enum(['strategy', 'heuristic']),
  strategy: z.strictObject({
    status: z.enum(['unsupported', 'exact', 'referenceOnly']),
    datasetVersion: SafePositiveIntegerSchema,
    abstractionLossCodes: z.array(z.literal('boardTextureCollapsed')).max(1),
    unsupportedReasonCode: z.literal('noAuthorizedCoverage').nullable(),
    confidence: z.enum(['dataset', 'low']),
    factIds: FactIdsSchema,
  }),
  persona: z.strictObject({
    policyVersion: z.literal(1),
    appliedReasonCodes: z.array(z.literal('boundedPersonaTransfer')).max(1),
    notApplicableReasonCodes: z
      .array(
        z.enum([
          'requiredCandidateFamilyMissing',
          'candidateCapReached',
          'noRangeBasedBluffClassification',
        ]),
      )
      .max(3),
    factIds: FactIdsSchema,
  }),
  opponentEvidence: z.strictObject({
    policyVersion: z.literal(1),
    asOfEventSeq: SafeNonnegativeIntegerSchema,
    status: z.literal('insufficientCurrentHandEvidence'),
    exploitAdjustmentBasisPoints: z.literal(0),
    reasonCode: z.literal('crossHandEvidenceUnavailable'),
    factIds: FactIdsSchema,
  }),
})

const ModelCandidateSemanticV1Schema = z.strictObject({
  candidateActionId: z.string().trim().min(1).max(128),
  actionType: z.enum(['fold', 'check', 'call', 'bet', 'raise', 'allIn']),
  targetStreetCommitment: SafeNonnegativeIntegerSchema.nullable(),
  contributionDelta: SafeNonnegativeIntegerSchema,
  commitmentRiskBand: z
    .enum(['zero', 'low', 'medium', 'high', 'allIn'])
    .nullable(),
  confidence: z.enum(['dataset', 'low']),
  baseWeightBasisPoints: BasisPointsSchema,
  personaAdjustedWeightBasisPoints: BasisPointsSchema,
  exploitAdjustedWeightBasisPoints: BasisPointsSchema,
  outcome: z.strictObject({
    amountActuallyAtRisk: SafeNonnegativeIntegerSchema,
    guaranteedUncalledReturn: SafeNonnegativeIntegerSchema,
    heroContestablePotAfterAction: SafeNonnegativeIntegerSchema,
    marginalContestablePot: z.strictObject({
      amountActuallyAtRisk: SafeNonnegativeIntegerSchema,
      contestableAmountAdded: SafeNonnegativeIntegerSchema,
    }),
    heroStackAfterAction: SafeNonnegativeIntegerSchema,
    isAllIn: z.boolean(),
    handEndsByFold: z.boolean(),
    forcesRunout: z.boolean(),
    remainingStreetsToDeal: z.number().int().min(0).max(3),
    canFaceFurtherAction: z.boolean(),
    responderCount: z.number().int().min(0).max(8),
    canRaiseResponderCount: z.number().int().min(0).max(8),
    projectedFlopMaximumOpponentSpr: factStateSchema(ExactRatioSchema),
    nextStreetMaximumOpponentSpr: factStateSchema(ExactRatioSchema),
    minimumRequiredEquityForCall: factStateSchema(ExactRatioSchema),
    pureBluffBreakEvenFoldRate: factStateSchema(ExactRatioSchema),
  }),
  factIds: FactIdsSchema,
})

export const PLAYER_MODEL_ACTION_CODES_V1 = Object.freeze([
  'fold',
  'check',
  'call',
  'bet',
  'raise',
  'allIn',
] as const)
export const PLAYER_MODEL_RISK_CODES_V1 = Object.freeze([
  'zero',
  'low',
  'medium',
  'high',
  'allIn',
] as const)
export const PLAYER_MODEL_CONFIDENCE_CODES_V1 = Object.freeze([
  'dataset',
  'low',
] as const)

const RatioTupleV1Schema = z.tuple([
  SafeNonnegativeIntegerSchema,
  SafePositiveIntegerSchema,
  SafeNonnegativeIntegerSchema,
])
const RatioFactStateTupleV1Schema = z.union([
  z.tuple([z.literal(0), RatioTupleV1Schema, FactIdsSchema]),
  z.tuple([
    z.union([z.literal(1), z.literal(2)]),
    z
      .number()
      .int()
      .min(0)
      .max(MODEL_FACT_REASON_CODES_V1.length - 1),
    FactIdsSchema,
  ]),
])
const ModelCandidateOutcomeTupleV1Schema = z.tuple([
  SafeNonnegativeIntegerSchema,
  SafeNonnegativeIntegerSchema,
  SafeNonnegativeIntegerSchema,
  SafeNonnegativeIntegerSchema,
  SafeNonnegativeIntegerSchema,
  SafeNonnegativeIntegerSchema,
  z.number().int().min(0).max(15),
  z.number().int().min(0).max(3),
  z.number().int().min(0).max(8),
  z.number().int().min(0).max(8),
  RatioFactStateTupleV1Schema,
  RatioFactStateTupleV1Schema,
  RatioFactStateTupleV1Schema,
  RatioFactStateTupleV1Schema,
])
export const PlayerModelCandidateTupleV1Schema = z.tuple([
  z.string().trim().min(1).max(128),
  z
    .number()
    .int()
    .min(0)
    .max(PLAYER_MODEL_ACTION_CODES_V1.length - 1),
  SafeNonnegativeIntegerSchema.nullable(),
  SafeNonnegativeIntegerSchema,
  z
    .number()
    .int()
    .min(0)
    .max(PLAYER_MODEL_RISK_CODES_V1.length - 1)
    .nullable(),
  z
    .number()
    .int()
    .min(0)
    .max(PLAYER_MODEL_CONFIDENCE_CODES_V1.length - 1),
  BasisPointsSchema,
  BasisPointsSchema,
  BasisPointsSchema,
  ModelCandidateOutcomeTupleV1Schema,
  FactIdsSchema,
])

export type PlayerModelCandidateTupleV1 = Readonly<
  z.infer<typeof PlayerModelCandidateTupleV1Schema>
>
export type PlayerModelCandidateSemanticV1 = Readonly<
  z.infer<typeof ModelCandidateSemanticV1Schema>
>

export const PLAYER_MODEL_CANDIDATE_TUPLE_DESCRIPTOR_V1 = Object.freeze({
  descriptorVersion: 1,
  candidate: Object.freeze([
    'candidateActionId',
    'actionTypeCode',
    'targetStreetCommitment',
    'contributionDelta',
    'commitmentRiskBandCode',
    'confidenceCode',
    'baseWeightBasisPoints',
    'personaAdjustedWeightBasisPoints',
    'exploitAdjustedWeightBasisPoints',
    'outcome',
    'factIds',
  ]),
  outcome: Object.freeze([
    'amountActuallyAtRisk',
    'guaranteedUncalledReturn',
    'heroContestablePotAfterAction',
    'marginalContestablePot.amountActuallyAtRisk',
    'marginalContestablePot.contestableAmountAdded',
    'heroStackAfterAction',
    'booleanFlags',
    'remainingStreetsToDeal',
    'responderCount',
    'canRaiseResponderCount',
    'projectedFlopMaximumOpponentSpr',
    'nextStreetMaximumOpponentSpr',
    'minimumRequiredEquityForCall',
    'pureBluffBreakEvenFoldRate',
  ]),
  ratioFactState: Object.freeze(['statusCode', 'valueOrReasonCode', 'factIds']),
  booleanFlagBits: Object.freeze([
    'isAllIn',
    'handEndsByFold',
    'forcesRunout',
    'canFaceFurtherAction',
  ]),
})

const ModelCandidateLimitationsV1Schema = z.strictObject({
  appliesToAllCandidateActionIds: z.literal(true),
  rangeConditionalEquity: factStateSchema(z.never()),
  opponentResponseProbability: factStateSchema(z.never()),
  expectedValue: factStateSchema(z.never()),
  futureStreetValue: factStateSchema(z.never()),
  impliedOdds: factStateSchema(z.never()),
  foldEquity: factStateSchema(z.never()),
  factIds: FactIdsSchema,
})

const RuntimeComponentReferenceSchema = z.strictObject({
  id: z.string().trim().min(1).max(128),
  version: SafePositiveIntegerSchema,
})
const ModelFactManifestEntryV1Schema = z.tuple([
  FactCodeSchema,
  FactCodeSchema,
  FactCodeSchema,
  FactCodeSchema,
  z.union([z.literal(0), z.literal(1), z.literal(2)]),
  z.union([
    z.literal(0),
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
  ]),
  z.number().int().min(0).max(63),
  SafeNonnegativeIntegerSchema,
  z.array(z.number().int().min(0).max(15)).max(8),
  z.number().int().min(0).max(15),
  z.number().int().min(0).max(25).nullable(),
])

export const PlayerModelProjectionV1Schema = z
  .strictObject({
    modelProjectionSchemaVersion: z.literal(1),
    pokerRuleSetVersion: z.literal(POKER_RULE_SET_VERSION),
    spot: ModelSpotV1Schema,
    hand: ModelHandV1Schema,
    metrics: ModelMetricsV1Schema,
    policies: ModelDecisionPoliciesV1Schema,
    candidates: z.array(PlayerModelCandidateTupleV1Schema).min(1).max(7),
    candidateLimitations: ModelCandidateLimitationsV1Schema,
    versionCatalog: z.array(RuntimeComponentReferenceSchema).min(1).max(16),
    factManifest: z
      .array(ModelFactManifestEntryV1Schema)
      .length(PLAYER_FACT_CONCEPTS_V1.length),
    constraints: z.strictObject({
      chooseExactlyOneCandidate: z.literal(true),
      mayInventAction: z.literal(false),
      mayInventAmount: z.literal(false),
      mayRecalculateFacts: z.literal(false),
      referenceWeightsAreSamplingGuarantee: z.literal(false),
    }),
  })
  .superRefine((projection, context) => {
    if (
      projection.factManifest.some((entry, index) => entry[0] !== index) ||
      new Set(projection.candidates.map((candidate) => candidate[0])).size !==
        projection.candidates.length ||
      projection.candidates.reduce(
        (total, candidate) => total + candidate[6],
        0,
      ) !== 10_000 ||
      projection.candidates.reduce(
        (total, candidate) => total + candidate[7],
        0,
      ) !== 10_000 ||
      projection.candidates.reduce(
        (total, candidate) => total + candidate[8],
        0,
      ) !== 10_000
    ) {
      context.addIssue({
        code: 'custom',
        path: ['factManifest'],
        message: 'Player 模型投影目录或候选权重无效。',
      })
    }
  })

export type PlayerModelProjectionV1 = Readonly<
  z.infer<typeof PlayerModelProjectionV1Schema>
>

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

type CandidateRatioFactState =
  PlayerModelCandidateSemanticV1['outcome']['projectedFlopMaximumOpponentSpr']

function encodeRatioFactStateV1(
  value: CandidateRatioFactState,
): z.infer<typeof RatioFactStateTupleV1Schema> {
  if (value.status === 'available') {
    return [
      0,
      [value.value.numerator, value.value.denominator, value.value.basisPoints],
      [...value.factIds],
    ]
  }
  const reasonCode = MODEL_FACT_REASON_CODES_V1.indexOf(value.reasonCode)
  if (reasonCode < 0) throw new RangeError('Player 候选事实 reason 无效。')
  return [
    value.status === 'unavailable' ? 1 : 2,
    reasonCode,
    [...value.factIds],
  ]
}

function decodeRatioFactStateV1(
  value: z.infer<typeof RatioFactStateTupleV1Schema>,
): CandidateRatioFactState {
  if (value[0] === 0) {
    return {
      status: 'available',
      value: {
        numerator: value[1][0],
        denominator: value[1][1],
        basisPoints: value[1][2],
      },
      factIds: [...value[2]],
    }
  }
  const reasonCode = MODEL_FACT_REASON_CODES_V1[value[1]]
  if (reasonCode === undefined) {
    throw new RangeError('Player 候选事实 reason code 无效。')
  }
  return {
    status: value[0] === 1 ? 'unavailable' : 'notApplicable',
    reasonCode,
    factIds: [...value[2]],
  }
}

export function encodePlayerModelCandidateTupleV1(
  input: unknown,
): PlayerModelCandidateTupleV1 {
  const candidate = ModelCandidateSemanticV1Schema.parse(input)
  const actionTypeCode = PLAYER_MODEL_ACTION_CODES_V1.indexOf(
    candidate.actionType,
  )
  const riskCode =
    candidate.commitmentRiskBand === null
      ? null
      : PLAYER_MODEL_RISK_CODES_V1.indexOf(candidate.commitmentRiskBand)
  const confidenceCode = PLAYER_MODEL_CONFIDENCE_CODES_V1.indexOf(
    candidate.confidence,
  )
  if (
    actionTypeCode < 0 ||
    (riskCode !== null && riskCode < 0) ||
    confidenceCode < 0
  ) {
    throw new RangeError('Player 候选 code 无效。')
  }
  const outcome = candidate.outcome
  const booleanFlags =
    (outcome.isAllIn ? 1 : 0) |
    (outcome.handEndsByFold ? 2 : 0) |
    (outcome.forcesRunout ? 4 : 0) |
    (outcome.canFaceFurtherAction ? 8 : 0)
  return deepFreeze(
    PlayerModelCandidateTupleV1Schema.parse([
      candidate.candidateActionId,
      actionTypeCode,
      candidate.targetStreetCommitment,
      candidate.contributionDelta,
      riskCode,
      confidenceCode,
      candidate.baseWeightBasisPoints,
      candidate.personaAdjustedWeightBasisPoints,
      candidate.exploitAdjustedWeightBasisPoints,
      [
        outcome.amountActuallyAtRisk,
        outcome.guaranteedUncalledReturn,
        outcome.heroContestablePotAfterAction,
        outcome.marginalContestablePot.amountActuallyAtRisk,
        outcome.marginalContestablePot.contestableAmountAdded,
        outcome.heroStackAfterAction,
        booleanFlags,
        outcome.remainingStreetsToDeal,
        outcome.responderCount,
        outcome.canRaiseResponderCount,
        encodeRatioFactStateV1(outcome.projectedFlopMaximumOpponentSpr),
        encodeRatioFactStateV1(outcome.nextStreetMaximumOpponentSpr),
        encodeRatioFactStateV1(outcome.minimumRequiredEquityForCall),
        encodeRatioFactStateV1(outcome.pureBluffBreakEvenFoldRate),
      ],
      [...candidate.factIds],
    ]),
  )
}

export function decodePlayerModelCandidateTupleV1(
  input: unknown,
): PlayerModelCandidateSemanticV1 {
  const candidate = PlayerModelCandidateTupleV1Schema.parse(input)
  const actionType = PLAYER_MODEL_ACTION_CODES_V1[candidate[1]]
  const risk =
    candidate[4] === null ? null : PLAYER_MODEL_RISK_CODES_V1[candidate[4]]
  const confidence = PLAYER_MODEL_CONFIDENCE_CODES_V1[candidate[5]]
  if (
    actionType === undefined ||
    risk === undefined ||
    confidence === undefined
  ) {
    throw new RangeError('Player 候选 tuple code 无效。')
  }
  const outcome = candidate[9]
  return deepFreeze(
    ModelCandidateSemanticV1Schema.parse({
      candidateActionId: candidate[0],
      actionType,
      targetStreetCommitment: candidate[2],
      contributionDelta: candidate[3],
      commitmentRiskBand: risk,
      confidence,
      baseWeightBasisPoints: candidate[6],
      personaAdjustedWeightBasisPoints: candidate[7],
      exploitAdjustedWeightBasisPoints: candidate[8],
      outcome: {
        amountActuallyAtRisk: outcome[0],
        guaranteedUncalledReturn: outcome[1],
        heroContestablePotAfterAction: outcome[2],
        marginalContestablePot: {
          amountActuallyAtRisk: outcome[3],
          contestableAmountAdded: outcome[4],
        },
        heroStackAfterAction: outcome[5],
        isAllIn: (outcome[6] & 1) !== 0,
        handEndsByFold: (outcome[6] & 2) !== 0,
        forcesRunout: (outcome[6] & 4) !== 0,
        remainingStreetsToDeal: outcome[7],
        canFaceFurtherAction: (outcome[6] & 8) !== 0,
        responderCount: outcome[8],
        canRaiseResponderCount: outcome[9],
        projectedFlopMaximumOpponentSpr: decodeRatioFactStateV1(outcome[10]),
        nextStreetMaximumOpponentSpr: decodeRatioFactStateV1(outcome[11]),
        minimumRequiredEquityForCall: decodeRatioFactStateV1(outcome[12]),
        pureBluffBreakEvenFoldRate: decodeRatioFactStateV1(outcome[13]),
      },
      factIds: [...candidate[10]],
    }),
  )
}

export function assertPlayerModelProjectionDescriptorV1(
  input: unknown,
): asserts input is PlayerModelProjectionV1 {
  const projection = PlayerModelProjectionV1Schema.parse(input)
  if (
    PLAYER_MODEL_CANDIDATE_TUPLE_DESCRIPTOR_V1.candidate.length !== 11 ||
    PLAYER_MODEL_CANDIDATE_TUPLE_DESCRIPTOR_V1.outcome.length !== 14 ||
    PLAYER_MODEL_CANDIDATE_TUPLE_DESCRIPTOR_V1.ratioFactState.length !== 3 ||
    PLAYER_MODEL_CANDIDATE_TUPLE_DESCRIPTOR_V1.booleanFlagBits.length !== 4 ||
    projection.candidates.some(
      (candidate) =>
        canonicalJson(
          encodePlayerModelCandidateTupleV1(
            decodePlayerModelCandidateTupleV1(candidate),
          ) as unknown as JsonValue,
        ) !== canonicalJson(candidate as unknown as JsonValue),
    )
  ) {
    throw new RangeError('Player 模型投影 descriptor 不一致。')
  }
}

export function buildPlayerModelProjectionBudgetFixtureV1(
  input: unknown,
): PlayerModelProjectionV1 {
  const projection = PlayerModelProjectionV1Schema.parse(input)
  assertPlayerModelProjectionDescriptorV1(projection)
  return deepFreeze(projection)
}

function sha256(value: JsonValue): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

function factCode(concept: (typeof PLAYER_FACT_CONCEPTS_V1)[number]): number {
  return PLAYER_FACT_CONCEPTS_V1.indexOf(concept)
}

function toFactState(
  value: {
    readonly status: string
    readonly value?: unknown
    readonly reasonCode?: string
  },
  concept: (typeof PLAYER_FACT_CONCEPTS_V1)[number],
): Record<string, unknown> {
  const factIds = [factCode(concept)]
  if (value.status === 'available') {
    return { status: 'available', value: value.value, factIds }
  }
  return {
    status: value.status,
    reasonCode: value.reasonCode,
    factIds,
  }
}

function sourceKindMask(sources: readonly { readonly kind: string }[]): number {
  let mask = 0
  for (const source of sources) {
    if (source.kind === 'observationField') mask |= 1 << 0
    else if (source.kind === 'ruleSet') mask |= 1 << 1
    else if (source.kind === 'algorithm') mask |= 1 << 2
    else if (source.kind === 'strategyRecord' || source.kind === 'strategyPack')
      mask |= 1 << 3
    else if (
      source.kind === 'personaSnapshot' ||
      source.kind === 'heuristicPolicy'
    )
      mask |= 1 << 4
    else if (
      source.kind === 'opponentEvidence' ||
      source.kind === 'exploitPolicy'
    )
      mask |= 1 << 5
  }
  return mask
}

function assumptionMask(codes: readonly string[]): number {
  const order = [
    'ignoresFutureAction',
    'noVersionedOpponentRange',
    'noJointResponseModel',
    'currentHandEvidenceOnly',
  ]
  return codes.reduce((mask, code) => {
    const index = order.indexOf(code)
    return index < 0 ? mask : mask | (1 << index)
  }, 0)
}

const FACT_STATUS_CODES_V1 = Object.freeze({
  available: 0,
  unavailable: 1,
  notApplicable: 2,
} as const)
const FACT_EPISTEMIC_CODES_V1 = Object.freeze({
  ruleFact: 0,
  formulaFact: 1,
  datasetBaseline: 2,
  statisticalEvidence: 3,
  heuristicJudgment: 4,
} as const)

function assertFactManifestMappingV1(
  snapshot: DecisionAuditSnapshotV1,
  projection: PlayerModelProjectionV1,
): void {
  const descriptors = PLAYER_FACT_MANIFEST_DESCRIPTOR_V1.entries
  if (
    descriptors.length !== PLAYER_FACT_CONCEPTS_V1.length ||
    snapshot.fullFactManifest.length !== descriptors.length ||
    projection.factManifest.length !== descriptors.length ||
    new Set(descriptors.map(({ conceptId }) => conceptId)).size !==
      descriptors.length ||
    new Set(descriptors.map(({ auditPath }) => auditPath)).size !==
      descriptors.length ||
    new Set(descriptors.map(({ modelPath }) => modelPath)).size !==
      descriptors.length
  ) {
    throw new RangeError('Player 事实 descriptor 不完整或不唯一。')
  }
  for (const [index, descriptor] of descriptors.entries()) {
    const full = snapshot.fullFactManifest[index]
    const model = projection.factManifest[index]
    const reasonCodeIndex =
      full?.reasonCode === null || full?.reasonCode === undefined
        ? null
        : MODEL_FACT_REASON_CODES_V1.indexOf(full.reasonCode)
    if (
      descriptor.conceptId !== PLAYER_FACT_CONCEPTS_V1[index] ||
      full === undefined ||
      model === undefined ||
      full.factId !== `audit.v1.${descriptor.conceptId}` ||
      full.conceptId !== descriptor.conceptId ||
      full.auditPath !== descriptor.auditPath ||
      model[0] !== index ||
      model[1] !== index ||
      model[2] !== index ||
      model[3] !== index ||
      model[4] !== FACT_STATUS_CODES_V1[full.status] ||
      model[5] !== FACT_EPISTEMIC_CODES_V1[full.epistemicKind] ||
      model[6] !== sourceKindMask(full.sourceRefs) ||
      model[7] !== full.asOfEventSeq ||
      canonicalJson(model[8] as unknown as JsonValue) !== '[0]' ||
      model[9] !== assumptionMask(full.assumptionCodes) ||
      model[10] !== reasonCodeIndex
    ) {
      throw new RangeError('Player full/model 事实清单映射不一致。')
    }
  }
}

function createActorMap(
  snapshot: DecisionAuditSnapshotV1,
): Map<number, string> {
  const hero = snapshot.binding.actorSeat
  const opponents = snapshot.observation.table.seats
    .filter((seat) => seat.seatNumber !== hero && seat.status !== 'out')
    .sort(
      (left, right) =>
        ((left.seatNumber - hero + 9) % 9) -
        ((right.seatNumber - hero + 9) % 9),
    )
  return new Map<number, string>([
    [hero, 'hero'],
    ...opponents.map(
      (seat, index) =>
        [seat.seatNumber, `opponent-${String(index + 1)}`] as const,
    ),
  ])
}

function actionCode(action: {
  readonly actionType: string
  readonly amountToCallBefore: number
  readonly contributionDelta: number
  readonly isFullRaise: boolean
}): number {
  if (action.actionType === 'fold') return 0
  if (action.actionType === 'check') return 1
  if (action.actionType === 'call') return 2
  if (action.actionType === 'bet') return 3
  if (action.actionType === 'raise') return action.isFullRaise ? 4 : 5
  if (action.isFullRaise) return 4
  return action.contributionDelta <= action.amountToCallBefore ? 6 : 5
}

function maximumSpr(
  value: readonly {
    readonly spr: {
      readonly numerator: number
      readonly denominator: number
      readonly basisPoints: number
    }
  }[],
): {
  readonly numerator: number
  readonly denominator: number
  readonly basisPoints: number
} {
  const maximum = [...value].sort(
    (left, right) => right.spr.basisPoints - left.spr.basisPoints,
  )[0]
  if (maximum === undefined) throw new RangeError('SPR 投影缺少对手。')
  return maximum.spr
}

function unique<Value>(values: readonly Value[]): readonly Value[] {
  return [...new Set(values)]
}

function mapPostflopSummary(snapshot: DecisionAuditSnapshotV1) {
  const preprocessing =
    snapshot.preprocessing as unknown as PlayerDecisionPreprocessingResultData
  const hand = preprocessing.handFeatures.data
  if (hand.kind !== 'postflop') throw new RangeError('当前手不是翻后。')
  const structural = hand.structuralOutCards
  const structuralOutSummary =
    structural.status === 'available'
      ? {
          status: 'available' as const,
          value: {
            distinctCardCount: new Set(
              structural.value.map(({ card }) =>
                canonicalJson(card as JsonValue),
              ),
            ).size,
            byResultingCategory: [
              ...structural.value.reduce((counts, entry) => {
                counts.set(
                  entry.resultingCategory,
                  (counts.get(entry.resultingCategory) ?? 0) + 1,
                )
                return counts
              }, new Map<string, number>()),
            ].map(([category, distinctCardCount]) => ({
              category,
              distinctCardCount,
            })),
            improvementKinds: unique(
              structural.value.flatMap(
                ({ improvementKinds }) => improvementKinds,
              ),
            ),
          },
          factIds: [factCode('handDrawStructure')],
        }
      : toFactState(structural, 'handDrawStructure')
  const counterfeit = hand.counterfeitRiskFacts
  const counterfeitRiskSummary =
    counterfeit.status === 'available'
      ? {
          status: 'available' as const,
          value: {
            distinctCardCount: new Set(
              counterfeit.value.map(({ nextCard }) =>
                canonicalJson(nextCard as JsonValue),
              ),
            ).size,
            reasonCodes: unique(
              counterfeit.value.flatMap(({ reasonCodes }) => reasonCodes),
            ),
          },
          factIds: [factCode('handCounterfeitRisk')],
        }
      : toFactState(counterfeit, 'handCounterfeitRisk')
  return { structuralOutSummary, counterfeitRiskSummary }
}

function limitationState(
  snapshot: DecisionAuditSnapshotV1,
  key:
    | 'rangeConditionalEquity'
    | 'opponentResponseProbability'
    | 'expectedValue'
    | 'futureStreetValue'
    | 'impliedOdds'
    | 'foldEquity',
) {
  const first = snapshot.candidates.outcomes[0]?.[key]
  if (first === undefined) throw new RangeError('候选限制事实缺失。')
  const canonical = canonicalJson(first as JsonValue)
  if (
    snapshot.candidates.outcomes.some(
      (outcome) => canonicalJson(outcome[key] as JsonValue) !== canonical,
    )
  ) {
    throw new RangeError('候选共同限制事实不一致。')
  }
  const concept =
    key === 'rangeConditionalEquity'
      ? 'candidateRangeEquityLimitation'
      : key === 'opponentResponseProbability'
        ? 'candidateResponseLimitation'
        : 'candidateValueLimitations'
  return toFactState(first, concept)
}

export function buildPlayerModelProjectionV1(
  snapshot: DecisionAuditSnapshotV1,
): PlayerModelProjectionV1 {
  if (!isDecisionAuditSnapshotV1(snapshot)) {
    throw new RangeError('模型投影只接受认证审计快照。')
  }
  const preprocessing =
    snapshot.preprocessing as unknown as PlayerDecisionPreprocessingResultData
  const spot = preprocessing.normalizedSpot.data
  const hand = preprocessing.handFeatures.data
  const metrics = preprocessing.currentMetrics.data
  const actorMap = createActorMap(snapshot)
  const streetCode = { preflop: 0, flop: 1, turn: 2, river: 3 } as const
  const actionLineCode = spot.actionLine
    .map((action) => {
      const actor = actorMap.get(action.actorSeatNumber)
      if (actor === undefined) throw new RangeError('行动线包含未知模型角色。')
      const actorCode = actor === 'hero' ? 0 : Number(actor.split('-')[1])
      return `${streetCode[action.street]}${String(actorCode)}${String(
        actionCode(action),
      )}:${String(action.contributionToPotRatio.basisPoints)}`
    })
    .join(';')
  const heroSeat = snapshot.binding.actorSeat
  const modelHand =
    hand.kind === 'preflop'
      ? {
          kind: 'preflop' as const,
          heroHoleCards: snapshot.observation.hand.heroHoleCards,
          board: [] as const,
          startingHandClass: hand.startingHandClass,
          isPair: hand.isPair,
          isSuited: hand.isSuited,
          rankGap: toFactState(hand.rankGap, 'handMadeStructure'),
          isConnector: hand.isConnector,
          isBroadway: hand.isBroadway,
          aceWheelPotential: hand.aceWheelPotential,
          highRank: hand.highRank,
          lowRank: hand.lowRank,
          factIds: [
            factCode('handVisibleCards'),
            factCode('handMadeStructure'),
          ],
        }
      : {
          kind: 'postflop' as const,
          heroHoleCards: snapshot.observation.hand.heroHoleCards,
          board: snapshot.observation.hand.board,
          handCategory: hand.handCategory,
          handRankTuple: hand.handRankTuple,
          holeCardsUsed: hand.holeCardsUsed,
          pairRelation: hand.pairRelation,
          kickerRanks: hand.kickerRanks,
          madeHandUsesBoardOnly: hand.madeHandUsesBoardOnly,
          boardStructure: {
            suitPattern: hand.boardStructure.suitPattern,
            maxSuitCount: hand.boardStructure.maxSuitCount,
            pairedRanks: hand.boardStructure.rankMultiplicity.pairs,
            tripRanks: hand.boardStructure.rankMultiplicity.trips,
            maximumConsecutiveRankRun:
              hand.boardStructure.maximumConsecutiveRankRun,
            candidateStraightWindowCount:
              hand.boardStructure.candidateStraightWindowCount,
          },
          drawTypes: hand.drawTypes,
          ...mapPostflopSummary(snapshot),
          absoluteNuts: toFactState(hand.absoluteNuts, 'handAbsoluteNuts'),
          factIds: [
            factCode('handVisibleCards'),
            factCode('handMadeStructure'),
            factCode('handDrawStructure'),
          ],
        }
  const currentSpr =
    metrics.currentSpr.status === 'available'
      ? {
          status: 'available' as const,
          value: {
            byOpponent: metrics.currentSpr.value.byOpponent.map((entry) => ({
              opponentId: actorMap.get(entry.opponentSeatNumber),
              effectiveStack: entry.effectiveStack,
              spr: entry.spr,
            })),
            maximumOpponentEffectiveSpr:
              metrics.currentSpr.value.maximumOpponentEffectiveSpr.spr,
          },
          factIds: [factCode('metricsCurrentSpr')],
        }
      : toFactState(metrics.currentSpr, 'metricsCurrentSpr')
  const strategy = preprocessing.strategyProjection.data
  const personaAdjustments = preprocessing.personaAdjustment.data.adjustments
  const outcomesById = new Map(
    snapshot.candidates.outcomes.map((outcome) => [
      outcome.candidate.candidateId,
      outcome,
    ]),
  )
  const semanticCandidates = snapshot.candidates.candidates.map((candidate) => {
    const outcome = outcomesById.get(candidate.candidateId)
    if (outcome === undefined) throw new RangeError('候选 outcome 缺失。')
    const sprState = (
      value: typeof outcome.projectedFlopSpr,
      concept: 'candidateProjectedSpr',
    ) =>
      value.status === 'available'
        ? {
            status: 'available' as const,
            value: maximumSpr(value.value),
            factIds: [factCode(concept)],
          }
        : toFactState(value, concept)
    return {
      candidateActionId: candidate.candidateId,
      actionType: candidate.action.type,
      targetStreetCommitment: candidate.targetStreetCommitment,
      contributionDelta: candidate.contributionDelta,
      commitmentRiskBand: candidate.commitmentRiskBand,
      confidence:
        candidate.source === 'strategy'
          ? ('dataset' as const)
          : ('low' as const),
      baseWeightBasisPoints: candidate.baseWeightBasisPoints,
      personaAdjustedWeightBasisPoints:
        candidate.personaAdjustedWeightBasisPoints,
      exploitAdjustedWeightBasisPoints:
        candidate.exploitAdjustedWeightBasisPoints,
      outcome: {
        amountActuallyAtRisk: outcome.amountActuallyAtRisk,
        guaranteedUncalledReturn: outcome.guaranteedUncalledReturn,
        heroContestablePotAfterAction: outcome.heroContestablePotAfterAction,
        marginalContestablePot: outcome.marginalContestablePot,
        heroStackAfterAction: outcome.heroStackAfterAction,
        isAllIn: outcome.isAllIn,
        handEndsByFold: outcome.handEndsByFold,
        forcesRunout: outcome.forcesRunout,
        remainingStreetsToDeal: outcome.remainingStreetsToDeal,
        canFaceFurtherAction: outcome.canFaceFurtherAction,
        responderCount: outcome.responders.length,
        canRaiseResponderCount: outcome.canRaiseSeats.length,
        projectedFlopMaximumOpponentSpr: sprState(
          outcome.projectedFlopSpr,
          'candidateProjectedSpr',
        ),
        nextStreetMaximumOpponentSpr: sprState(
          outcome.nextStreetSpr,
          'candidateProjectedSpr',
        ),
        minimumRequiredEquityForCall: toFactState(
          outcome.minimumRequiredEquityForCall,
          'candidateCallThreshold',
        ),
        pureBluffBreakEvenFoldRate: toFactState(
          outcome.pureBluffBreakEvenFoldRate,
          'candidateBluffThreshold',
        ),
      },
      factIds: [
        factCode('candidateCatalog'),
        factCode('candidateWeights'),
        factCode('candidateContestablePot'),
      ],
    }
  })
  const candidates = semanticCandidates.map(encodePlayerModelCandidateTupleV1)
  const versionCatalog = [
    { id: 'player.model-projection', version: 1 },
    { id: 'player.decision-audit-snapshot', version: 1 },
    { id: 'player.decision-preprocessing', version: 1 },
    { id: 'player.spot-normalizer', version: 1 },
    { id: 'player.hand-feature-analyzer', version: 1 },
    { id: 'player.candidate-outcome-projector', version: 1 },
  ]
  const factManifest = snapshot.fullFactManifest.map(
    (entry, index) =>
      [
        index,
        index,
        index,
        index,
        FACT_STATUS_CODES_V1[entry.status],
        FACT_EPISTEMIC_CODES_V1[entry.epistemicKind],
        sourceKindMask(entry.sourceRefs),
        entry.asOfEventSeq,
        [0],
        assumptionMask(entry.assumptionCodes),
        entry.reasonCode === null
          ? null
          : MODEL_FACT_REASON_CODES_V1.indexOf(
              entry.reasonCode as ModelFactReasonCodeV1,
            ),
      ] as const,
  )
  const projection = PlayerModelProjectionV1Schema.parse({
    modelProjectionSchemaVersion: 1,
    pokerRuleSetVersion: POKER_RULE_SET_VERSION,
    spot: {
      street: spot.street,
      tableSize: spot.tableSize,
      heroPosition: spot.heroPosition,
      playerCounts: spot.playerCounts,
      playersBehindHeroCount: spot.playersBehindHero.length,
      bigBlindOptionAvailable: spot.bigBlindOptionAvailable,
      preflopNode: spot.preflopNode,
      potType: spot.potType,
      heroHasPreflopInitiative:
        spot.initiative.lastPreflopFullAggressorSeatNumber === null
          ? null
          : spot.initiative.lastPreflopFullAggressorSeatNumber === heroSeat,
      heroHasCurrentStreetInitiative:
        spot.initiative.lastCurrentStreetFullAggressorSeatNumber === null
          ? null
          : spot.initiative.lastCurrentStreetFullAggressorSeatNumber ===
            heroSeat,
      raiseReopenedForHero: spot.raiseReopenedForHero,
      actionLineCode,
      factIds: [
        factCode('spotIdentity'),
        factCode('spotActionLine'),
        factCode('spotInitiative'),
      ],
    },
    hand: modelHand,
    metrics: {
      amountToCall: metrics.amounts.amountToCall,
      currentStreetContribution: metrics.amounts.currentStreetContribution,
      currentTotalContribution: metrics.amounts.currentTotalContribution,
      heroContestablePotBefore:
        preprocessing.contestablePot.data.heroContestablePotBefore,
      heroMaximumContestableAmount:
        preprocessing.contestablePot.data.heroMaximumContestableAmount,
      potOdds: toFactState(metrics.potOdds, 'metricsPotOdds'),
      currentSpr,
      factIds: [
        factCode('metricsAmounts'),
        factCode('potContestable'),
        factCode('metricsPotOdds'),
      ],
    },
    policies: {
      candidateSource: preprocessing.candidateSource,
      strategy: {
        status: strategy.status,
        datasetVersion: strategy.datasetVersion,
        abstractionLossCodes:
          strategy.status === 'unsupported'
            ? []
            : strategy.abstractionLossCodes,
        unsupportedReasonCode:
          strategy.status === 'unsupported' ? strategy.reasonCode : null,
        confidence: strategy.status === 'unsupported' ? 'low' : 'dataset',
        factIds: [factCode('strategyPolicy')],
      },
      persona: {
        policyVersion:
          preprocessing.personaAdjustment.data.personaDeviationPolicyVersion,
        appliedReasonCodes: unique(
          personaAdjustments
            .filter(({ status }) => status === 'applied')
            .map(() => 'boundedPersonaTransfer' as const),
        ),
        notApplicableReasonCodes: unique(
          personaAdjustments
            .filter(({ status }) => status === 'notApplicable')
            .map(({ reasonCode }) => reasonCode),
        ),
        factIds: [factCode('personaPolicy')],
      },
      opponentEvidence: {
        policyVersion: 1,
        asOfEventSeq: preprocessing.opponentEvidence.data.asOfEventSeq,
        status: 'insufficientCurrentHandEvidence',
        exploitAdjustmentBasisPoints: 0,
        reasonCode: preprocessing.opponentEvidence.data.reasonCode,
        factIds: [factCode('opponentEvidence'), factCode('exploitPolicy')],
      },
    },
    candidates,
    candidateLimitations: {
      appliesToAllCandidateActionIds: true,
      rangeConditionalEquity: limitationState(
        snapshot,
        'rangeConditionalEquity',
      ),
      opponentResponseProbability: limitationState(
        snapshot,
        'opponentResponseProbability',
      ),
      expectedValue: limitationState(snapshot, 'expectedValue'),
      futureStreetValue: limitationState(snapshot, 'futureStreetValue'),
      impliedOdds: limitationState(snapshot, 'impliedOdds'),
      foldEquity: limitationState(snapshot, 'foldEquity'),
      factIds: [
        factCode('candidateRangeEquityLimitation'),
        factCode('candidateResponseLimitation'),
        factCode('candidateValueLimitations'),
      ],
    },
    versionCatalog,
    factManifest,
    constraints: {
      chooseExactlyOneCandidate: true,
      mayInventAction: false,
      mayInventAmount: false,
      mayRecalculateFacts: false,
      referenceWeightsAreSamplingGuarantee: false,
    },
  })
  assertFactManifestMappingV1(snapshot, projection)
  assertPlayerModelProjectionDescriptorV1(projection)
  return deepFreeze(projection)
}

export function hashPlayerModelProjectionV1(
  projection: PlayerModelProjectionV1,
): string {
  return sha256(
    PlayerModelProjectionV1Schema.parse(projection) as unknown as JsonValue,
  )
}

export const PlayerDecisionContextSectionV1Schema = z.strictObject({
  sectionSchemaVersion: z.literal(1),
  projection: PlayerModelProjectionV1Schema,
  projectionSha256: Sha256DigestSchema,
})

export type PlayerDecisionContextSectionV1 = Readonly<
  z.infer<typeof PlayerDecisionContextSectionV1Schema>
>
