import {
  AgentPersonaIdSchema,
  AgentPersonaStyleSchema,
  CardSchema,
} from '@tx-holdem-coach/contracts'
import { z } from 'zod'
import { canonicalJson, type JsonValue } from '../../persisted-json.js'
import { isLegalCandidateSemanticallyConsistent } from '../../poker/betting-projection.js'
import { PokerCommandSchema } from '../../poker/commands.js'
import { M45AssumptionCodeSchema } from '../../poker/decision-analysis-types.js'
import { POKER_RULE_SET_VERSION } from '../../poker/poker-rule-set.js'
import {
  parseStrategyPack,
  StrategyPackSchema,
} from '../../poker-strategy/strategy-pack.js'
import type { PlayerVisibleState } from '../../sessions/authoritative-state/player-visible-state.js'
import { Sha256DigestSchema } from '../audit/audit-primitives.js'
import type { CapabilityDefinition } from '../foundation/capability-executor.js'
import type { RuntimeComponentReference } from '../foundation/runtime-definition.js'
import {
  buildPlayerDecisionAnalysisCore,
  isPlayerDecisionAnalysisCore,
} from './player-decision-analysis-core.js'
import { createPlayerDecisionAnalysisBinding } from './player-decision-analysis-input.js'
import { FactSourceRefSchema } from './player-fact-sources.js'
import { buildPlayerOpponentEvidence } from './player-opponent-evidence.js'
import {
  AgentMemoryPayloadV1Schema,
  decodePlayerSessionMemoryV1,
  hashPlayerSessionMemoryV1,
} from './player-session-memory.js'
import { buildPlayerStrategyProjection } from './player-strategy-projection.js'

const SafePositiveIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
const SafeNonnegativeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
const PlayerDecisionReferenceSchema = z.strictObject({
  sessionId: z.string().uuid(),
  handId: z.string().uuid(),
  actorParticipantId: z.string().uuid(),
  actorSeat: z.number().int().min(1).max(8),
  pokerRuleSetVersion: z.literal(POKER_RULE_SET_VERSION),
  handNumber: SafeNonnegativeIntegerSchema,
  configSnapshotKey: Sha256DigestSchema,
  personaId: AgentPersonaIdSchema,
  personaVersion: z.literal(1),
  personaPolicy: AgentPersonaStyleSchema,
})

export const PlayerDecisionAnalysisBindingSchema = z.strictObject({
  observationSchemaVersion: z.literal(1),
  observationSha256: Sha256DigestSchema,
  sessionId: z.string().uuid(),
  handId: z.string().uuid(),
  stateVersion: SafeNonnegativeIntegerSchema,
  decisionRequestId: z.string().uuid(),
  actorParticipantId: z.string().uuid(),
  actorSeat: z.number().int().min(1).max(8),
  asOfEventSeq: SafeNonnegativeIntegerSchema,
  pokerRuleSetVersion: z.literal(POKER_RULE_SET_VERSION),
})

const LegalCandidateSchema = z
  .strictObject({
    candidateSchemaVersion: z.literal(1),
    candidateId: z.string().trim().min(1),
    action: PokerCommandSchema.shape.action,
    targetStreetCommitment: SafeNonnegativeIntegerSchema.nullable(),
    targetKind: z.enum([
      'minimum',
      'halfPot',
      'twoThirdsPot',
      'pot',
      'call',
      'allIn',
      'notApplicable',
    ]),
  })
  .superRefine((candidate, context) => {
    if (!isLegalCandidateSemanticallyConsistent(candidate)) {
      context.addIssue({
        code: 'custom',
        path: ['candidateId'],
        message: '候选 ID 必须与 action、target 和 targetKind 语义一致。',
      })
    }
  })

const DecisionStreetSchema = z.enum(['preflop', 'flop', 'turn', 'river'])
const SeatNumberSchema = z.number().int().min(0).max(8)
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
const CardSuitSchema = z.enum(['clubs', 'diamonds', 'hearts', 'spades'])
const ExactRatioSchema = z.strictObject({
  numerator: SafeNonnegativeIntegerSchema,
  denominator: SafePositiveIntegerSchema,
  basisPoints: SafeNonnegativeIntegerSchema,
})
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
const DerivedUnavailableReasonCodeSchema = z.enum([
  'noVersionedOpponentRange',
  'noJointResponseModel',
  'crossHandEvidenceUnavailable',
  'unsupportedStrategySpot',
  'insufficientEvidence',
])
const DerivedNotApplicableReasonCodeSchema = z.enum([
  'noCallRequired',
  'preflopCurrentSprUndefined',
  'forcedRunout',
  'noRangeBasedBluffClassification',
  'noBetOnStreet',
  'noFullRaiseOnStreet',
  'noPriorPostflopStreet',
  'noFutureDecisionStreet',
  'pairHasNoRankGap',
  'notCurrentHandCategory',
  'insufficientRanks',
])

function derivedFactSchema(valueSchema: z.ZodType) {
  return z.discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('available'),
      value: valueSchema,
      epistemicKind: z.enum([
        'ruleFact',
        'formulaFact',
        'datasetBaseline',
        'statisticalEvidence',
        'heuristicJudgment',
      ]),
      sourceRefs: z.array(FactSourceRefSchema),
      assumptionCodes: z.array(M45AssumptionCodeSchema),
    }),
    z.strictObject({
      status: z.literal('unavailable'),
      reasonCode: DerivedUnavailableReasonCodeSchema,
      sourceRefs: z.array(FactSourceRefSchema),
      assumptionCodes: z.array(M45AssumptionCodeSchema),
    }),
    z.strictObject({
      status: z.literal('notApplicable'),
      reasonCode: DerivedNotApplicableReasonCodeSchema,
      sourceRefs: z.array(FactSourceRefSchema),
      assumptionCodes: z.array(M45AssumptionCodeSchema),
    }),
  ])
}

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

const OpponentPositionRelationSchema = z.strictObject({
  opponentSeatNumber: SeatNumberSchema,
  opponentPosition: LogicalPositionSchema,
  preflopActsBeforeHero: z.boolean(),
  currentStreetActsBeforeHero: z.boolean(),
  relativePosition: z.enum(['inPosition', 'outOfPosition']),
})

const PlayerCountFactsSchema = z.strictObject({
  dealtCount: SafeNonnegativeIntegerSchema,
  remainingSeatCount: SafeNonnegativeIntegerSchema,
  notFoldedCount: SafeNonnegativeIntegerSchema,
  activeCount: SafeNonnegativeIntegerSchema,
  allInCount: SafeNonnegativeIntegerSchema,
  voluntaryPreflopParticipantCount: SafeNonnegativeIntegerSchema,
  currentlyOwingActionCount: SafeNonnegativeIntegerSchema,
})

const ForcedPostFactSchema = z.strictObject({
  seatNumber: SeatNumberSchema,
  kind: z.enum(['smallBlind', 'bigBlind']),
  nominalAmount: z.union([z.literal(10), z.literal(20)]),
  actualAmount: SafeNonnegativeIntegerSchema,
  isAllIn: z.boolean(),
})

const InitiativeFactsSchema = z.strictObject({
  lastPreflopFullAggressorSeatNumber: SeatNumberSchema.nullable(),
  lastPreflopFullAggressorStillInHand: z.boolean().nullable(),
  lastCurrentStreetFullAggressorSeatNumber: SeatNumberSchema.nullable(),
  lastCurrentStreetFullAggressorStillInHand: z.boolean().nullable(),
})

const NormalizedActionSchema = z.strictObject({
  eventSeq: SafeNonnegativeIntegerSchema,
  street: DecisionStreetSchema,
  actorSeatNumber: SeatNumberSchema,
  actionType: z.enum(['fold', 'check', 'call', 'bet', 'raise', 'allIn']),
  amountToCallBefore: SafeNonnegativeIntegerSchema,
  contributionDelta: SafeNonnegativeIntegerSchema,
  targetStreetCommitmentAfter: SafeNonnegativeIntegerSchema,
  totalContributionAfter: SafeNonnegativeIntegerSchema,
  potBefore: SafeNonnegativeIntegerSchema,
  contributionToPotRatio: ExactRatioSchema,
  targetToPotRatio: ExactRatioSchema,
  currentBetBefore: SafeNonnegativeIntegerSchema,
  currentBetAfter: SafeNonnegativeIntegerSchema,
  minimumFullRaiseIncrementBefore: SafePositiveIntegerSchema,
  minimumFullRaiseIncrementAfter: SafePositiveIntegerSchema,
  isVoluntaryPreflopContribution: z.boolean(),
  isFullRaise: z.boolean(),
})

const FullRaiseFactSchema = z.strictObject({
  targetStreetCommitment: SafeNonnegativeIntegerSchema,
  increment: SafePositiveIntegerSchema,
  source: z.enum(['action', 'forcedBigBlind']),
  actorSeatNumber: SeatNumberSchema.nullable(),
  eventSeq: SafeNonnegativeIntegerSchema.nullable(),
})

const EffectiveStackBandFactSchema = z.strictObject({
  opponentSeatNumber: SeatNumberSchema,
  opponentPosition: LogicalPositionSchema,
  effectiveStackChips: SafeNonnegativeIntegerSchema,
  effectiveStackBigBlinds: ExactRatioSchema,
  band: z.enum(['lt20bb', '20to39bb', '40to79bb', '80to149bb', 'ge150bb']),
})

const LegalActionTopologyClassSchema = z.strictObject({
  actionType: z.enum(['fold', 'check', 'call', 'bet', 'raise', 'allIn']),
  targetStreetCommitment: SafeNonnegativeIntegerSchema.nullable(),
  heroActionCompletes: z.literal(true),
  bettingRoundClosesImmediately: z.boolean(),
  canFaceFurtherAction: z.boolean(),
})

export const NormalizedDecisionSpotSchema = z.strictObject({
  spotSchemaVersion: z.literal(1),
  normalizerVersion: z.literal(1),
  spotKey: Sha256DigestSchema,
  tableSize: z.union([z.literal(6), z.literal(7), z.literal(8), z.literal(9)]),
  heroPosition: LogicalPositionSchema,
  positionsByOpponent: z.array(OpponentPositionRelationSchema),
  street: DecisionStreetSchema,
  playerCounts: PlayerCountFactsSchema,
  actionOrder: z.array(SeatNumberSchema),
  playersBehindHero: z.array(SeatNumberSchema),
  forcedPosts: z.array(ForcedPostFactSchema),
  bigBlindOptionAvailable: z.boolean(),
  preflopNode: PreflopNodeSchema,
  potType: PotTypeSchema,
  initiative: InitiativeFactsSchema,
  actionLine: z.array(NormalizedActionSchema),
  lastFullRaise: derivedFactSchema(FullRaiseFactSchema),
  raiseReopenedForHero: z.boolean(),
  effectiveStackBandsByOpponent: z.array(EffectiveStackBandFactSchema),
  decisionTopology: z.array(LegalActionTopologyClassSchema),
})

const UnavailableHandFactsSchema = z.strictObject({
  cleanOuts: derivedFactSchema(z.never()),
  rangeConditionalEquity: derivedFactSchema(z.never()),
  expectedValue: derivedFactSchema(z.never()),
  dominationProbability: derivedFactSchema(z.never()),
  foldEquity: derivedFactSchema(z.never()),
  opponentResponseProbability: derivedFactSchema(z.never()),
  impliedOdds: derivedFactSchema(z.never()),
  reverseImpliedOdds: derivedFactSchema(z.never()),
  actualReverseOuts: derivedFactSchema(z.never()),
  strategicBlockerValue: derivedFactSchema(z.never()),
  rangeRoleLabels: derivedFactSchema(z.never()),
})

const HandFeatureBaseSchema = {
  handFeatureSchemaVersion: z.literal(1),
  analyzerVersion: z.literal(1),
  pokerRuleSetVersion: z.literal(POKER_RULE_SET_VERSION),
  visibleCardsSha256: Sha256DigestSchema,
  sourceRefs: z.array(FactSourceRefSchema),
  unavailableFacts: UnavailableHandFactsSchema,
}

const HandRankTupleSchema = z.tuple([
  SafeNonnegativeIntegerSchema,
  SafeNonnegativeIntegerSchema,
  SafeNonnegativeIntegerSchema,
  SafeNonnegativeIntegerSchema,
  SafeNonnegativeIntegerSchema,
  SafeNonnegativeIntegerSchema,
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
const ImprovementKindSchema = z.enum([
  'higherCategory',
  'higherGrade',
  'completesFlush',
  'completesStraight',
  'pairsVisibleRank',
])

const StraightWindowFactSchema = z.strictObject({
  highRank: CardRankSchema,
  occupiedRanks: z.array(CardRankSchema),
  missingRanks: z.array(CardRankSchema),
  duplicateBoardCards: SafeNonnegativeIntegerSchema,
})

const BoardStreetDeltaSchema = z.strictObject({
  addedCard: CardSchema,
  changedSuit: z.strictObject({
    suit: CardSuitSchema,
    countBefore: SafeNonnegativeIntegerSchema,
    countAfter: SafeNonnegativeIntegerSchema,
  }),
  changedRank: z.strictObject({
    rank: CardRankSchema,
    countBefore: SafeNonnegativeIntegerSchema,
    countAfter: SafeNonnegativeIntegerSchema,
  }),
  changedStraightWindows: z.array(
    z.strictObject({
      highRank: CardRankSchema,
      missingRanksBefore: z.array(CardRankSchema),
      missingRanksAfter: z.array(CardRankSchema),
    }),
  ),
})

const HandTransitionFactSchema = z.strictObject({
  categoryBefore: HandCategorySchema,
  categoryAfter: HandCategorySchema,
  comparisonGradeBefore: HandRankTupleSchema,
  comparisonGradeAfter: HandRankTupleSchema,
  holeCardsUsedBefore: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  holeCardsUsedAfter: z.union([z.literal(0), z.literal(1), z.literal(2)]),
})

const BoardStructureFactsSchema = z.strictObject({
  suitCounts: z.array(
    z.strictObject({
      suit: CardSuitSchema,
      count: SafeNonnegativeIntegerSchema,
    }),
  ),
  maxSuitCount: SafeNonnegativeIntegerSchema,
  suitPattern: z.enum(['monotone', 'twoTone', 'rainbow', 'mixed']),
  rankCounts: z.array(
    z.strictObject({
      rank: CardRankSchema,
      count: SafeNonnegativeIntegerSchema,
    }),
  ),
  uniqueRanks: z.array(CardRankSchema),
  rankMultiplicity: z.strictObject({
    pairs: z.array(CardRankSchema),
    trips: z.array(CardRankSchema),
    quads: z.array(CardRankSchema),
  }),
  straightWindows: z.array(StraightWindowFactSchema),
  maximumConsecutiveRankRun: SafeNonnegativeIntegerSchema,
  minimumInternalGap: derivedFactSchema(SafeNonnegativeIntegerSchema),
  candidateStraightWindowCount: SafeNonnegativeIntegerSchema,
  boardHighRank: CardRankSchema,
  boardLowRank: CardRankSchema,
  streetDelta: derivedFactSchema(BoardStreetDeltaSchema),
  handTransition: derivedFactSchema(HandTransitionFactSchema),
})

const BackdoorDrawFactSchema = z.strictObject({
  kind: z.enum(['backdoorFlush', 'backdoorStraight']),
  suit: CardSuitSchema.nullable(),
  neededRanks: z.array(CardRankSchema),
})

const StructuralOutCardSchema = z.strictObject({
  card: CardSchema,
  resultingCategory: HandCategorySchema,
  resultingGrade: HandRankTupleSchema,
  improvementKinds: z.array(ImprovementKindSchema),
})

const CardRemovalFactSchema = z.strictObject({
  card: CardSchema,
  unknownCardsOfSameRank: SafeNonnegativeIntegerSchema,
  unknownCardsOfSameSuit: SafeNonnegativeIntegerSchema,
  opponentTwoCardCombinationsRemaining: SafeNonnegativeIntegerSchema,
  opponentTwoCardCombinationsRemoved: SafeNonnegativeIntegerSchema,
})

const CounterfeitRiskFactSchema = z.strictObject({
  nextCard: CardSchema,
  reasonCodes: z.array(
    z.enum([
      'holeCardsUsedDecreases',
      'boardPairs',
      'boardMakesSharedHand',
      'pairStructureChanges',
    ]),
  ),
})

export const HandFeatureAnalysisSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...HandFeatureBaseSchema,
    kind: z.literal('preflop'),
    street: z.literal('preflop'),
    startingHandClass: z.string().regex(/^[2-9TJQKA]{2}(?:s|o)?$/),
    isPair: z.boolean(),
    isSuited: z.boolean(),
    rankGap: derivedFactSchema(SafeNonnegativeIntegerSchema),
    isConnector: z.boolean(),
    isBroadway: z.boolean(),
    aceWheelPotential: z.boolean(),
    highRank: CardRankSchema,
    lowRank: CardRankSchema,
    containsAce: z.boolean(),
    containsKing: z.boolean(),
    containsQueen: z.boolean(),
    containsJack: z.boolean(),
    containsTen: z.boolean(),
  }),
  z.strictObject({
    ...HandFeatureBaseSchema,
    kind: z.literal('postflop'),
    street: z.enum(['flop', 'turn', 'river']),
    bestFiveCards: z.tuple([
      CardSchema,
      CardSchema,
      CardSchema,
      CardSchema,
      CardSchema,
    ]),
    handRankTuple: HandRankTupleSchema,
    handCategory: HandCategorySchema,
    holeCardsUsed: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    holeCardsInBestFive: z.array(CardSchema),
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
    kickerRanks: z.array(CardRankSchema),
    overcardCount: SafeNonnegativeIntegerSchema,
    flushHighRank: derivedFactSchema(CardRankSchema),
    straightHighRank: derivedFactSchema(CardRankSchema),
    madeHandUsesBoardOnly: z.boolean(),
    boardStructure: BoardStructureFactsSchema,
    drawTypes: z.array(
      z.enum([
        'flushDraw',
        'openEndedStraightDraw',
        'gutshot',
        'doubleGutshot',
        'comboDraw',
      ]),
    ),
    backdoorDraws: z.array(BackdoorDrawFactSchema),
    structuralOutCards: derivedFactSchema(z.array(StructuralOutCardSchema)),
    overlappingOutGroups: derivedFactSchema(
      z.array(
        z.strictObject({
          card: CardSchema,
          improvementKinds: z.array(ImprovementKindSchema),
        }),
      ),
    ),
    redrawFacts: derivedFactSchema(
      z.array(
        z.strictObject({
          fromCategory: HandCategorySchema,
          improvingCards: z.array(CardSchema),
        }),
      ),
    ),
    absoluteNuts: derivedFactSchema(z.boolean()),
    cardRemovalFacts: z.array(CardRemovalFactSchema),
    counterfeitRiskFacts: derivedFactSchema(z.array(CounterfeitRiskFactSchema)),
  }),
])

export const ContestablePotProjectionSchema = z.strictObject({
  contestablePotSchemaVersion: z.literal(1),
  projectorVersion: z.literal(1),
  sourceRefs: z.array(FactSourceRefSchema),
  potBreakdown: z.array(
    z.strictObject({
      potId: z.string().regex(/^(?:main|side-[1-9]\d*)$/),
      amount: SafeNonnegativeIntegerSchema,
      lowerContributionExclusive: SafeNonnegativeIntegerSchema,
      upperContributionInclusive: SafeNonnegativeIntegerSchema,
      contributingSeatNumbers: z.array(SeatNumberSchema),
      eligibleSeatNumbers: z.array(SeatNumberSchema),
    }),
  ),
  effectiveStacksByOpponent: z.array(
    z.strictObject({
      opponentSeatNumber: SeatNumberSchema,
      currentEffectiveStack: SafeNonnegativeIntegerSchema,
      maximumAdditionalMatchedContribution: SafeNonnegativeIntegerSchema,
    }),
  ),
  heroContestablePotBefore: SafeNonnegativeIntegerSchema,
  heroMaximumContestableAmount: SafeNonnegativeIntegerSchema,
})

export const DecisionMetricsSchema = z.strictObject({
  decisionMetricsSchemaVersion: z.literal(1),
  engineVersion: z.literal(1),
  sourceRefs: z.array(FactSourceRefSchema),
  amounts: z.strictObject({
    amountToCall: SafeNonnegativeIntegerSchema,
    currentStreetContribution: SafeNonnegativeIntegerSchema,
    currentTotalContribution: SafeNonnegativeIntegerSchema,
    minimumBetOrRaiseTarget: SafeNonnegativeIntegerSchema.nullable(),
    maximumOrdinaryTarget: SafeNonnegativeIntegerSchema.nullable(),
    allInTarget: SafeNonnegativeIntegerSchema.nullable(),
  }),
  potOdds: derivedFactSchema(ExactRatioSchema),
  currentSpr: derivedFactSchema(
    z.strictObject({
      byOpponent: z.array(
        z.strictObject({
          opponentSeatNumber: SeatNumberSchema,
          effectiveStack: SafeNonnegativeIntegerSchema,
          spr: ExactRatioSchema,
        }),
      ),
      maximumOpponentEffectiveSpr: z.strictObject({
        effectiveStack: SafeNonnegativeIntegerSchema,
        spr: ExactRatioSchema,
      }),
    }),
  ),
  publicActionScales: z.array(
    z.strictObject({
      eventSeq: SafeNonnegativeIntegerSchema,
      contributionDeltaToPotBefore: z.strictObject({
        ratioKind: z.literal('contributionDeltaToPotBefore'),
        value: ExactRatioSchema,
      }),
      targetStreetCommitmentToPotBefore: z.discriminatedUnion('status', [
        z.strictObject({
          status: z.literal('available'),
          ratioKind: z.literal('targetStreetCommitmentToPotBefore'),
          value: ExactRatioSchema,
        }),
        z.strictObject({
          status: z.literal('notApplicable'),
          reasonCode: z.literal('noTarget'),
        }),
      ]),
      sourceRefs: z.array(FactSourceRefSchema),
    }),
  ),
})

export const PlayerComputeDecisionMetricsCapabilityInputSchema = z.strictObject(
  {
    observation: z.unknown(),
    reference: PlayerDecisionReferenceSchema,
  },
)

export const PlayerComputeDecisionMetricsCapabilityOutputSchema =
  z.strictObject({
    binding: PlayerDecisionAnalysisBindingSchema,
    data: z.strictObject({
      normalizedSpot: NormalizedDecisionSpotSchema,
      handFeatures: HandFeatureAnalysisSchema,
      contestablePot: ContestablePotProjectionSchema,
      currentMetrics: DecisionMetricsSchema,
      legalCandidates: z.array(LegalCandidateSchema),
    }),
  })

export const PlayerProjectStrategyCapabilityInputSchema = z.strictObject({
  analysisCore: z.unknown(),
  strategyPack: StrategyPackSchema,
})

const StrategyCandidateWeightSchema = z.strictObject({
  candidateId: z.string().trim().min(1),
  actionFrequencyBasisPoints: z.number().int().min(0).max(10_000),
  betSizePotRatio: z
    .strictObject({
      numerator: SafeNonnegativeIntegerSchema,
      denominator: SafePositiveIntegerSchema,
    })
    .nullable(),
  solverEv: z
    .strictObject({
      valueMilliBigBlinds: z.number().int(),
      sourceRef: z.string().trim().min(1),
    })
    .nullable(),
})

export const StrategyProjectionDataSchema = z.discriminatedUnion('status', [
  z.strictObject({
    strategyProjectionSchemaVersion: z.literal(1),
    status: z.literal('unsupported'),
    reasonCode: z.literal('noAuthorizedCoverage'),
    datasetId: z.string().trim().min(1),
    datasetVersion: SafePositiveIntegerSchema,
    candidateWeights: z.tuple([]),
  }),
  z.strictObject({
    strategyProjectionSchemaVersion: z.literal(1),
    status: z.enum(['exact', 'referenceOnly']),
    recordId: z.string().trim().min(1),
    datasetId: z.string().trim().min(1),
    datasetVersion: SafePositiveIntegerSchema,
    authorizationRef: z.string().trim().min(1),
    abstractionLossCodes: z.array(z.literal('boardTextureCollapsed')),
    candidateWeights: z.array(StrategyCandidateWeightSchema).min(1),
  }),
])

export const PlayerProjectStrategyCapabilityOutputSchema = z.strictObject({
  binding: PlayerDecisionAnalysisBindingSchema,
  data: StrategyProjectionDataSchema,
})

export const PlayerReadSessionMemoryCapabilityInputSchema = z.strictObject({
  binding: PlayerDecisionAnalysisBindingSchema,
  revision: SafeNonnegativeIntegerSchema.positive(),
  payloadVersion: z.literal(1),
  payload: AgentMemoryPayloadV1Schema,
  sha256: Sha256DigestSchema,
  asOfEventSeq: SafeNonnegativeIntegerSchema,
})

export const PlayerReadSessionMemoryCapabilityOutputSchema =
  PlayerReadSessionMemoryCapabilityInputSchema

export const PlayerProjectOpponentFeaturesCapabilityInputSchema =
  z.strictObject({
    observation: z.unknown(),
    reference: PlayerDecisionReferenceSchema,
    sessionMemory: PlayerReadSessionMemoryCapabilityOutputSchema,
  })

export const OpponentRateEvidenceSchema = z.strictObject({
  metric: z.enum([
    'preflopVoluntaryParticipation',
    'preflopFullRaise',
    'facingAggressionFold',
    'facingAggressionCall',
    'facingAggressionRaise',
    'currentStreetAggression',
  ]),
  numerator: SafeNonnegativeIntegerSchema,
  denominator: SafeNonnegativeIntegerSchema,
  distinctHandCount: SafeNonnegativeIntegerSchema,
  source: z.literal('currentHandAndSessionMemory'),
  memoryRevision: SafeNonnegativeIntegerSchema.positive(),
  historyAsOfEventSeq: SafeNonnegativeIntegerSchema,
  currentHandAsOfEventSeq: SafeNonnegativeIntegerSchema,
  confidence: z.enum(['insufficient', 'low', 'medium', 'high']),
  filterCode: z.string().trim().min(1),
  firstEventSeq: SafeNonnegativeIntegerSchema.nullable(),
  lastEventSeq: SafeNonnegativeIntegerSchema.nullable(),
})

export const OpponentEvidenceProjectionDataSchema = z.strictObject({
  opponentEvidenceSchemaVersion: z.literal(1),
  sourceScope: z.literal('currentHandAndSessionMemory'),
  memoryRevision: SafeNonnegativeIntegerSchema.positive(),
  historyAsOfEventSeq: SafeNonnegativeIntegerSchema,
  asOfEventSeq: SafeNonnegativeIntegerSchema,
  evidenceId: Sha256DigestSchema,
  status: z.enum(['insufficientEvidence', 'available']),
  reasonCode: z.literal('insufficientEvidence').nullable(),
  opponents: z.array(
    z.strictObject({
      participantId: z.string().uuid(),
      seatNumber: z.number().int().min(0).max(8),
      evidence: z.array(OpponentRateEvidenceSchema),
    }),
  ),
})

export const PlayerProjectOpponentFeaturesCapabilityOutputSchema =
  z.strictObject({
    binding: PlayerDecisionAnalysisBindingSchema,
    data: OpponentEvidenceProjectionDataSchema,
  })

export const PLAYER_COMPUTE_DECISION_METRICS_CAPABILITY = Object.freeze({
  id: 'player.compute-decision-metrics',
  version: 1,
} as const satisfies RuntimeComponentReference)

export const PLAYER_READ_SESSION_MEMORY_CAPABILITY = Object.freeze({
  id: 'player.read-session-memory',
  version: 1,
} as const satisfies RuntimeComponentReference)

export const PLAYER_PROJECT_STRATEGY_CAPABILITY = Object.freeze({
  id: 'player.project-strategy',
  version: 1,
} as const satisfies RuntimeComponentReference)

export const PLAYER_PROJECT_OPPONENT_FEATURES_CAPABILITY = Object.freeze({
  id: 'player.project-opponent-features',
  version: 1,
} as const satisfies RuntimeComponentReference)

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

function canonical<Value>(value: Value): Value {
  canonicalJson(value as unknown as JsonValue)
  return value
}

function parseObservationInput(input: unknown): JsonValue {
  const parsed = PlayerComputeDecisionMetricsCapabilityInputSchema.parse(input)
  const observation = parsed.observation as PlayerVisibleState
  const reference = deepFreeze(parsed.reference)
  createPlayerDecisionAnalysisBinding({ observation, reference })
  return canonical(
    deepFreeze({ observation, reference }) as unknown as JsonValue,
  )
}

function parseMemoryInput(input: unknown): JsonValue {
  const parsed = PlayerReadSessionMemoryCapabilityInputSchema.parse(input)
  if (hashPlayerSessionMemoryV1(parsed.payload) !== parsed.sha256) {
    throw new RangeError('Session Memory digest 与 payload 不一致。')
  }
  return canonical(deepFreeze(parsed) as unknown as JsonValue)
}

function parseOpponentInput(input: unknown): JsonValue {
  const parsed = PlayerProjectOpponentFeaturesCapabilityInputSchema.parse(input)
  const observation = parsed.observation as PlayerVisibleState
  const reference = deepFreeze(parsed.reference)
  createPlayerDecisionAnalysisBinding({ observation, reference })
  if (
    hashPlayerSessionMemoryV1(parsed.sessionMemory.payload) !==
    parsed.sessionMemory.sha256
  ) {
    throw new RangeError('Session Memory digest 与 payload 不一致。')
  }
  return canonical(
    deepFreeze({
      observation,
      reference,
      sessionMemory: parsed.sessionMemory,
    }) as unknown as JsonValue,
  )
}

function parseStrategyInput(input: unknown): JsonValue {
  const parsed = PlayerProjectStrategyCapabilityInputSchema.parse(input)
  if (!isPlayerDecisionAnalysisCore(parsed.analysisCore)) {
    throw new RangeError('策略能力只接受 Plan 重新认证的分析核心。')
  }
  const strategyPack = parseStrategyPack(parsed.strategyPack)
  const analysisCore = parsed.analysisCore
  return canonical(
    deepFreeze({ analysisCore, strategyPack }) as unknown as JsonValue,
  )
}

function parseOutput(
  schema:
    | typeof PlayerComputeDecisionMetricsCapabilityOutputSchema
    | typeof PlayerProjectStrategyCapabilityOutputSchema
    | typeof PlayerProjectOpponentFeaturesCapabilityOutputSchema
    | typeof PlayerReadSessionMemoryCapabilityOutputSchema,
  input: unknown,
): JsonValue {
  return canonical(schema.parse(input) as unknown as JsonValue)
}

export const playerReadSessionMemoryCapabilityDefinition = Object.freeze({
  runtimeType: 'player',
  capability: PLAYER_READ_SESSION_MEMORY_CAPABILITY,
  mode: 'readOnly',
  inputSchema: Object.freeze({
    id: 'player.capability.read-session-memory.input',
    version: 1,
  }),
  outputSchema: Object.freeze({
    id: 'player.capability.read-session-memory.output',
    version: 1,
  }),
  timeoutMs: 1_000,
  parseInput: parseMemoryInput,
  parseOutput: (input: unknown) =>
    parseOutput(PlayerReadSessionMemoryCapabilityOutputSchema, input),
  execute: async (input: JsonValue, signal: AbortSignal) => {
    throwIfAborted(signal)
    const parsed = PlayerReadSessionMemoryCapabilityInputSchema.parse(input)
    const payload = decodePlayerSessionMemoryV1(parsed.payload)
    if (hashPlayerSessionMemoryV1(payload) !== parsed.sha256) {
      throw new RangeError('Session Memory digest 与 payload 不一致。')
    }
    throwIfAborted(signal)
    return parsed as unknown as JsonValue
  },
} as const satisfies CapabilityDefinition<'player'>)

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('player_capability_cancelled')
}

export const playerComputeDecisionMetricsCapabilityDefinition = Object.freeze({
  runtimeType: 'player',
  capability: PLAYER_COMPUTE_DECISION_METRICS_CAPABILITY,
  mode: 'deterministicCompute',
  inputSchema: Object.freeze({
    id: 'player.capability.compute-decision-metrics.input',
    version: 1,
  }),
  outputSchema: Object.freeze({
    id: 'player.capability.compute-decision-metrics.output',
    version: 1,
  }),
  timeoutMs: 2_000,
  parseInput: parseObservationInput,
  parseOutput: (input: unknown) =>
    parseOutput(PlayerComputeDecisionMetricsCapabilityOutputSchema, input),
  execute: async (input: JsonValue, signal: AbortSignal) => {
    throwIfAborted(signal)
    const parsed = input as unknown as z.infer<
      typeof PlayerComputeDecisionMetricsCapabilityInputSchema
    >
    const output = buildPlayerDecisionAnalysisCore({
      observation: parsed.observation as PlayerVisibleState,
      reference: parsed.reference,
    })
    throwIfAborted(signal)
    return output as unknown as JsonValue
  },
} as const satisfies CapabilityDefinition<'player'>)

export const playerProjectStrategyCapabilityDefinition = Object.freeze({
  runtimeType: 'player',
  capability: PLAYER_PROJECT_STRATEGY_CAPABILITY,
  mode: 'deterministicCompute',
  inputSchema: Object.freeze({
    id: 'player.capability.project-strategy.input',
    version: 1,
  }),
  outputSchema: Object.freeze({
    id: 'player.capability.project-strategy.output',
    version: 1,
  }),
  timeoutMs: 1_000,
  parseInput: parseStrategyInput,
  parseOutput: (input: unknown) =>
    parseOutput(PlayerProjectStrategyCapabilityOutputSchema, input),
  execute: async (input: JsonValue, signal: AbortSignal) => {
    throwIfAborted(signal)
    const parsed = input as unknown as {
      readonly analysisCore: Parameters<
        typeof buildPlayerStrategyProjection
      >[0]['analysisCore']
      readonly strategyPack: Parameters<
        typeof buildPlayerStrategyProjection
      >[0]['strategyPack']
    }
    const output = buildPlayerStrategyProjection(parsed)
    if (
      output.data.datasetId !== parsed.strategyPack.datasetId ||
      output.data.datasetVersion !== parsed.strategyPack.datasetVersion
    ) {
      throw new RangeError('策略能力输出未绑定本次策略包。')
    }
    throwIfAborted(signal)
    return output as unknown as JsonValue
  },
} as const satisfies CapabilityDefinition<'player'>)

export const playerProjectOpponentFeaturesCapabilityDefinition = Object.freeze({
  runtimeType: 'player',
  capability: PLAYER_PROJECT_OPPONENT_FEATURES_CAPABILITY,
  mode: 'deterministicCompute',
  inputSchema: Object.freeze({
    id: 'player.capability.project-opponent-features.input',
    version: 1,
  }),
  outputSchema: Object.freeze({
    id: 'player.capability.project-opponent-features.output',
    version: 1,
  }),
  timeoutMs: 1_000,
  parseInput: parseOpponentInput,
  parseOutput: (input: unknown) =>
    parseOutput(PlayerProjectOpponentFeaturesCapabilityOutputSchema, input),
  execute: async (input: JsonValue, signal: AbortSignal) => {
    throwIfAborted(signal)
    const parsed = input as unknown as z.infer<
      typeof PlayerProjectOpponentFeaturesCapabilityInputSchema
    >
    const output = buildPlayerOpponentEvidence({
      observation: parsed.observation as PlayerVisibleState,
      reference: parsed.reference,
      sessionMemory: parsed.sessionMemory,
    })
    throwIfAborted(signal)
    return output as unknown as JsonValue
  },
} as const satisfies CapabilityDefinition<'player'>)

export const playerDecisionCapabilityDefinitions = Object.freeze([
  playerReadSessionMemoryCapabilityDefinition,
  playerComputeDecisionMetricsCapabilityDefinition,
  playerProjectStrategyCapabilityDefinition,
  playerProjectOpponentFeaturesCapabilityDefinition,
] as const satisfies readonly CapabilityDefinition<'player'>[])
