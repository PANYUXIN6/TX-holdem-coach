import { CardSchema } from '@tx-holdem-coach/contracts'
import { z } from 'zod'
import { M45AssumptionCodeSchema } from './decision-analysis-types.js'
import { POKER_RULE_SET_VERSION } from './poker-rule-set.js'
const SafeNonnegativeIntegerSchema = z.number().int().nonnegative().safe()
const SafePositiveIntegerSchema = SafeNonnegativeIntegerSchema.positive()
const Sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/)

export function createDecisionAnalysisSchemas<TSource extends z.ZodType>(
  FactSourceRefSchema: TSource,
) {
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

  const NormalizedDecisionSpotSchema = z.strictObject({
    spotSchemaVersion: z.literal(1),
    normalizerVersion: z.literal(1),
    spotKey: Sha256DigestSchema,
    tableSize: z.union([
      z.literal(6),
      z.literal(7),
      z.literal(8),
      z.literal(9),
    ]),
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

  const HandFeatureAnalysisSchema = z.discriminatedUnion('kind', [
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
      counterfeitRiskFacts: derivedFactSchema(
        z.array(CounterfeitRiskFactSchema),
      ),
    }),
  ])

  const ContestablePotProjectionSchema = z.strictObject({
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

  const DecisionMetricsSchema = z.strictObject({
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

  return {
    NormalizedDecisionSpotSchema,
    HandFeatureAnalysisSchema,
    ContestablePotProjectionSchema,
    DecisionMetricsSchema,
  }
}
