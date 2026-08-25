import { createHash } from 'node:crypto'
import { buildPlayerDecisionAnalysisCore } from '../../src/agents/player/player-decision-analysis-core.js'
import {
  DecisionAuditSnapshotV1Schema,
  buildDecisionAuditSnapshotV1,
  certifyPersistedDecisionAuditSnapshotV1,
  type DecisionAuditSnapshotV1,
} from '../../src/agents/player/player-decision-audit.js'
import { issueRuntimeCommitAuthority } from '../../src/agents/foundation/runtime-ports.js'
import { composePlayerDecisionPreprocessingResult } from '../../src/agents/player/player-decision-preprocessor.js'
import { buildPlayerOpponentEvidence } from '../../src/agents/player/player-opponent-evidence.js'
import type { PlayerDecisionReference } from '../../src/agents/player/player-decision-reference.js'
import { buildPlayerStrategyProjection } from '../../src/agents/player/player-strategy-projection.js'
import { loadAndValidatePersonaCatalog } from '../../src/personas/catalog.js'
import {
  createConfigSnapshotKey,
  PERSONA_CONFIG_PAYLOAD_VERSION,
} from '../../src/personas/config.js'
import { EMPTY_AUTHORIZED_STRATEGY_PACK } from '../../src/poker-strategy/strategy-pack-repository.js'
import { STANDARD_DECK } from '../../src/poker/cards.js'
import {
  buildPlayerModelProjectionBudgetFixtureV1,
  buildPlayerModelProjectionV1,
  decodePlayerModelCandidateTupleV1,
  encodePlayerModelCandidateTupleV1,
  type PlayerModelProjectionV1,
} from '../../src/agents/player/player-model-projection.js'
import { buildPlayerObservationDraft } from '../../src/sessions/authoritative-state/player-observation-builder.js'
import { certifyPlayerVisibleState } from '../../src/sessions/authoritative-state/player-information-boundary-guard.js'
import type { PlayerVisibleState } from '../../src/sessions/authoritative-state/player-visible-state.js'
import { createPlayerObservationFixture } from './player-observation-fixture.js'
import { canonicalJson, type JsonValue } from '../../src/persisted-json.js'

function referenceFor(
  observation: PlayerVisibleState,
  personaId?: AgentPersonaId,
): PlayerDecisionReference {
  const catalog = loadAndValidatePersonaCatalog()
  const persona =
    personaId === undefined ? catalog.list()[0]! : catalog.get(personaId)!
  return Object.freeze({
    sessionId: observation.identity.sessionId,
    handId: observation.identity.handId,
    actorParticipantId: observation.identity.actorParticipantId,
    actorSeat: observation.identity.actorSeat,
    pokerRuleSetVersion: 'nlhe-cash-6to9-10-20-v1',
    handNumber: observation.hand.handNumber,
    configSnapshotKey: createConfigSnapshotKey(
      PERSONA_CONFIG_PAYLOAD_VERSION,
      persona,
    ),
    personaId: persona.personaId,
    personaVersion: 1,
    personaPolicy: { ...persona.style },
  })
}

export function createPlayerDecisionAuditFixture(
  input: {
    readonly playerCount?: 6 | 7 | 8 | 9
    readonly actorSeat?: number
    readonly actorStack?: number
    readonly personaId?: AgentPersonaId
    readonly withPublicAction?: boolean
  } = {},
): {
  readonly snapshot: DecisionAuditSnapshotV1
  readonly observation: PlayerVisibleState
} {
  const fixture = createPlayerObservationFixture({
    ...(input.playerCount === undefined
      ? {}
      : { playerCount: input.playerCount }),
    ...(input.actorSeat === undefined ? {} : { actorSeat: input.actorSeat }),
    ...(input.actorStack === undefined ? {} : { actorStack: input.actorStack }),
    withPublicAction: input.withPublicAction ?? true,
  })
  const observation = certifyPlayerVisibleState(
    buildPlayerObservationDraft(fixture.input),
  )
  const reference = referenceFor(observation, input.personaId)
  const analysisCore = buildPlayerDecisionAnalysisCore({
    observation,
    reference,
  })
  const strategyProjection = buildPlayerStrategyProjection({
    analysisCore,
    strategyPack: EMPTY_AUTHORIZED_STRATEGY_PACK,
  })
  const opponentEvidence = buildPlayerOpponentEvidence({
    observation,
    reference,
  })
  const preprocessing = composePlayerDecisionPreprocessingResult({
    observation,
    reference,
    strategyPackRef: {
      datasetId: EMPTY_AUTHORIZED_STRATEGY_PACK.datasetId,
      datasetVersion: EMPTY_AUTHORIZED_STRATEGY_PACK.datasetVersion,
    },
    analysisCore,
    strategyProjection,
    opponentEvidence,
  })
  return {
    observation,
    snapshot: buildDecisionAuditSnapshotV1({
      observation,
      preprocessing,
      strategyPackRef: preprocessing.strategyPackRef,
    }),
  }
}

const MAXIMUM_SAFE_INTEGER = Number.MAX_SAFE_INTEGER
const MAXIMUM_RATIO = Object.freeze({
  numerator: MAXIMUM_SAFE_INTEGER,
  denominator: 1,
  basisPoints: MAXIMUM_SAFE_INTEGER,
})
const MAXIMUM_ACTION_LINE_RATIO = Object.freeze({
  numerator: MAXIMUM_SAFE_INTEGER,
  denominator: 1,
  basisPoints: 1_000_000,
})

function maximumFactState(factIds: readonly number[]) {
  return {
    status: 'available' as const,
    value: MAXIMUM_RATIO,
    factIds: [...factIds],
  }
}

function sha256(value: JsonValue): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

export function createPlayerDecisionProjectionWorstCaseFixtureV1(): PlayerModelProjectionV1 {
  const { snapshot } = createPlayerDecisionAuditFixture({ playerCount: 9 })
  const snapshotData = DecisionAuditSnapshotV1Schema.parse(snapshot)
  const action = snapshotData.preprocessing.normalizedSpot.data.actionLine[0]
  if (action === undefined) throw new Error('预算 fixture 缺少行动模板。')
  snapshotData.preprocessing.normalizedSpot.data.actionLine = Array.from(
    { length: 1_025 },
    (_, index) => ({
      ...action,
      eventSeq: index,
      street: 'river' as const,
      actorSeatNumber: 2,
      actionType: 'allIn' as const,
      amountToCallBefore: MAXIMUM_SAFE_INTEGER,
      contributionDelta: MAXIMUM_SAFE_INTEGER,
      contributionToPotRatio: MAXIMUM_ACTION_LINE_RATIO,
      isFullRaise: false,
    }),
  )
  const { preprocessingSha256: _preprocessingSha256, ...preprocessingData } =
    snapshotData.preprocessing
  snapshotData.preprocessing.preprocessingSha256 = sha256(
    preprocessingData as unknown as JsonValue,
  )
  snapshotData.preprocessingSha256 =
    snapshotData.preprocessing.preprocessingSha256
  const { snapshotSha256: _snapshotSha256, ...snapshotWithoutHash } =
    snapshotData
  snapshotData.snapshotSha256 = sha256(
    snapshotWithoutHash as unknown as JsonValue,
  )
  const authority = issueRuntimeCommitAuthority({
    runtimeType: 'player',
    runId: '11111111-1111-4111-8111-111111111146',
    leaseOwner: 'm46-budget:player:0',
    fencingToken: 1,
  })
  const certified = certifyPersistedDecisionAuditSnapshotV1({
    snapshot: snapshotData,
    authority,
    expected: {
      sessionId: snapshotData.binding.sessionId,
      handId: snapshotData.binding.handId,
      participantId: snapshotData.binding.actorParticipantId,
      sourceStateVersion: snapshotData.binding.stateVersion,
      decisionRequestId: snapshotData.binding.decisionRequestId,
    },
  })
  return buildPlayerModelProjectionV1(certified)
}

export function createPlayerDecisionProjectionRepresentationalUpperBoundFixtureV1(): PlayerModelProjectionV1 {
  const { snapshot } = createPlayerDecisionAuditFixture({ playerCount: 9 })
  const base = buildPlayerModelProjectionV1(snapshot)
  const factIds = [0, 1, 2, 3] as const
  const weights = [1_429, 1_429, 1_429, 1_429, 1_428, 1_428, 1_428]
  const actionLineCode = Array.from(
    { length: 1_025 },
    () => '386:1000000',
  ).join(';')
  const versionCatalog = Array.from({ length: 16 }, (_, index) => ({
    id: `v${String(index).padStart(2, '0')}.${'x'.repeat(124)}`,
    version: MAXIMUM_SAFE_INTEGER,
  }))
  const candidates = base.candidates.map((encoded, index) => {
    const candidate = decodePlayerModelCandidateTupleV1(encoded)
    return encodePlayerModelCandidateTupleV1({
      ...candidate,
      candidateActionId: `c${String(index)}${'x'.repeat(126)}`,
      actionType: 'raise' as const,
      targetStreetCommitment: MAXIMUM_SAFE_INTEGER,
      contributionDelta: MAXIMUM_SAFE_INTEGER,
      commitmentRiskBand: 'allIn' as const,
      confidence: 'dataset' as const,
      baseWeightBasisPoints: weights[index]!,
      personaAdjustedWeightBasisPoints: weights[index]!,
      exploitAdjustedWeightBasisPoints: weights[index]!,
      outcome: {
        amountActuallyAtRisk: MAXIMUM_SAFE_INTEGER,
        guaranteedUncalledReturn: MAXIMUM_SAFE_INTEGER,
        heroContestablePotAfterAction: MAXIMUM_SAFE_INTEGER,
        marginalContestablePot: {
          amountActuallyAtRisk: MAXIMUM_SAFE_INTEGER,
          contestableAmountAdded: MAXIMUM_SAFE_INTEGER,
        },
        heroStackAfterAction: MAXIMUM_SAFE_INTEGER,
        isAllIn: true,
        handEndsByFold: true,
        forcesRunout: true,
        remainingStreetsToDeal: 3,
        canFaceFurtherAction: true,
        responderCount: 8,
        canRaiseResponderCount: 8,
        projectedFlopMaximumOpponentSpr: maximumFactState(factIds),
        nextStreetMaximumOpponentSpr: maximumFactState(factIds),
        minimumRequiredEquityForCall: maximumFactState(factIds),
        pureBluffBreakEvenFoldRate: maximumFactState(factIds),
      },
      factIds: [...factIds],
    })
  })
  return buildPlayerModelProjectionBudgetFixtureV1({
    ...base,
    spot: {
      ...base.spot,
      street: 'river',
      tableSize: 9,
      heroPosition: 'UTG+1',
      playerCounts: {
        dealtCount: MAXIMUM_SAFE_INTEGER,
        remainingSeatCount: MAXIMUM_SAFE_INTEGER,
        notFoldedCount: MAXIMUM_SAFE_INTEGER,
        activeCount: MAXIMUM_SAFE_INTEGER,
        allInCount: MAXIMUM_SAFE_INTEGER,
        voluntaryPreflopParticipantCount: MAXIMUM_SAFE_INTEGER,
        currentlyOwingActionCount: MAXIMUM_SAFE_INTEGER,
      },
      playersBehindHeroCount: 8,
      preflopNode: {
        kind: 'fourBetOrMore',
        fullRaiseCount: MAXIMUM_SAFE_INTEGER,
        limperCount: MAXIMUM_SAFE_INTEGER,
        callerCount: MAXIMUM_SAFE_INTEGER,
        hasShortAllInRaise: true,
      },
      potType: {
        kind: 'multiwaySidePot',
        isHeadsUp: false,
        isMultiway: true,
        hasSidePot: true,
      },
      actionLineCode,
      factIds: [...factIds],
    },
    hand: {
      kind: 'postflop',
      heroHoleCards: [STANDARD_DECK[0]!, STANDARD_DECK[1]!],
      board: [
        STANDARD_DECK[2]!,
        STANDARD_DECK[3]!,
        STANDARD_DECK[4]!,
        STANDARD_DECK[5]!,
        STANDARD_DECK[6]!,
      ],
      handCategory: 'straightFlush',
      handRankTuple: Array.from({ length: 6 }, () => MAXIMUM_SAFE_INTEGER),
      holeCardsUsed: 2,
      pairRelation: 'twoPairUsingHole',
      kickerRanks: ['A', 'K', 'Q', 'J', 'T'],
      madeHandUsesBoardOnly: true,
      boardStructure: {
        suitPattern: 'monotone',
        maxSuitCount: MAXIMUM_SAFE_INTEGER,
        pairedRanks: ['A', 'K'],
        tripRanks: ['Q'],
        maximumConsecutiveRankRun: MAXIMUM_SAFE_INTEGER,
        candidateStraightWindowCount: MAXIMUM_SAFE_INTEGER,
      },
      drawTypes: [
        'flushDraw',
        'openEndedStraightDraw',
        'gutshot',
        'doubleGutshot',
        'comboDraw',
      ],
      structuralOutSummary: {
        status: 'available',
        value: {
          distinctCardCount: MAXIMUM_SAFE_INTEGER,
          byResultingCategory: [
            'highCard',
            'onePair',
            'twoPair',
            'threeOfAKind',
            'straight',
            'flush',
            'fullHouse',
            'fourOfAKind',
            'straightFlush',
          ].map((category) => ({
            category,
            distinctCardCount: MAXIMUM_SAFE_INTEGER,
          })),
          improvementKinds: [
            'higherCategory',
            'higherGrade',
            'completesFlush',
            'completesStraight',
            'pairsVisibleRank',
          ],
        },
        factIds: [...factIds],
      },
      absoluteNuts: {
        status: 'available',
        value: true,
        factIds: [...factIds],
      },
      counterfeitRiskSummary: {
        status: 'available',
        value: {
          distinctCardCount: MAXIMUM_SAFE_INTEGER,
          reasonCodes: [
            'holeCardsUsedDecreases',
            'boardPairs',
            'boardMakesSharedHand',
            'pairStructureChanges',
          ],
        },
        factIds: [...factIds],
      },
      factIds: [...factIds],
    },
    metrics: {
      amountToCall: MAXIMUM_SAFE_INTEGER,
      currentStreetContribution: MAXIMUM_SAFE_INTEGER,
      currentTotalContribution: MAXIMUM_SAFE_INTEGER,
      heroContestablePotBefore: MAXIMUM_SAFE_INTEGER,
      heroMaximumContestableAmount: MAXIMUM_SAFE_INTEGER,
      potOdds: maximumFactState(factIds),
      currentSpr: {
        status: 'available',
        value: {
          byOpponent: Array.from({ length: 8 }, (_, index) => ({
            opponentId: `opponent-${String(index + 1)}`,
            effectiveStack: MAXIMUM_SAFE_INTEGER,
            spr: MAXIMUM_RATIO,
          })),
          maximumOpponentEffectiveSpr: MAXIMUM_RATIO,
        },
        factIds: [...factIds],
      },
      factIds: [...factIds],
    },
    policies: {
      candidateSource: 'strategy',
      strategy: {
        status: 'referenceOnly',
        datasetVersion: MAXIMUM_SAFE_INTEGER,
        abstractionLossCodes: ['boardTextureCollapsed'],
        unsupportedReasonCode: null,
        confidence: 'dataset',
        factIds: [...factIds],
      },
      persona: {
        policyVersion: 1,
        appliedReasonCodes: ['boundedPersonaTransfer'],
        notApplicableReasonCodes: [
          'requiredCandidateFamilyMissing',
          'candidateCapReached',
          'noRangeBasedBluffClassification',
        ],
        factIds: [...factIds],
      },
      opponentEvidence: {
        policyVersion: 1,
        asOfEventSeq: MAXIMUM_SAFE_INTEGER,
        status: 'insufficientCurrentHandEvidence',
        exploitAdjustmentBasisPoints: 0,
        reasonCode: 'crossHandEvidenceUnavailable',
        factIds: [...factIds],
      },
    },
    candidates,
    candidateLimitations: {
      appliesToAllCandidateActionIds: true,
      rangeConditionalEquity: {
        status: 'unavailable',
        reasonCode: 'noVersionedOpponentRange',
        factIds: [...factIds],
      },
      opponentResponseProbability: {
        status: 'unavailable',
        reasonCode: 'noJointResponseModel',
        factIds: [...factIds],
      },
      expectedValue: {
        status: 'unavailable',
        reasonCode: 'insufficientEvidence',
        factIds: [...factIds],
      },
      futureStreetValue: {
        status: 'unavailable',
        reasonCode: 'noFutureDecisionStreet',
        factIds: [...factIds],
      },
      impliedOdds: {
        status: 'unavailable',
        reasonCode: 'insufficientEvidence',
        factIds: [...factIds],
      },
      foldEquity: {
        status: 'unavailable',
        reasonCode: 'insufficientEvidence',
        factIds: [...factIds],
      },
      factIds: [...factIds],
    },
    versionCatalog,
    factManifest: Array.from({ length: 32 }, (_, index) => [
      index,
      index,
      index,
      index,
      2,
      4,
      63,
      MAXIMUM_SAFE_INTEGER,
      [0, 1, 2, 3, 4, 5, 6, 7],
      15,
      25,
    ]),
  })
}
import type { AgentPersonaId } from '@tx-holdem-coach/contracts'
