import { createHash } from 'node:crypto'
import type { PlayerDecisionPreprocessingResult } from '../../../src/agents/player/player-decision-preprocessor.js'
import type { JsonValue } from '../../../src/persisted-json.js'
import { canonicalJson } from '../../../src/persisted-json.js'
import type { PlayerVisibleState } from '../../../src/sessions/authoritative-state/player-visible-state.js'
import type {
  PlayerEvalForcedRunoutEvidence,
  PlayerEvalScenario,
  PlayerEvalSessionMemory,
} from '../player-eval-scenarios.js'

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function futureFact(input: {
  readonly status: string
  readonly value?: readonly unknown[]
  readonly reasonCode?: string
}) {
  return input.status === 'available'
    ? {
        status: 'available' as const,
        valueSha256: createHash('sha256')
          .update(canonicalJson((input.value ?? []) as JsonValue), 'utf8')
          .digest('hex'),
      }
    : {
        status: 'notApplicable' as const,
        reasonCode: input.reasonCode,
      }
}

export function gradeDeterministicPlayerScenario(input: {
  readonly scenario: PlayerEvalScenario
  readonly observation: PlayerVisibleState
  readonly preprocessing: PlayerDecisionPreprocessingResult
  readonly forcedRunout: PlayerEvalForcedRunoutEvidence | null
  readonly sessionMemory: PlayerEvalSessionMemory
}): void {
  const actualActionTypes = input.preprocessing.candidates.data.map(
    (candidate) => candidate.action.type,
  )
  const expectedActionTypes = input.scenario.assertions.candidateActionTypes
  const actualPublicActionTypes = input.observation.hand.publicActions.map(
    (action) => action.action.action.type,
  )
  const topology = input.preprocessing.normalizedSpot.data
  const expectedTopology = input.scenario.assertions.normalizedSpot
  const expectedForcedRunout = input.scenario.assertions.forcedRunout
  const actualCandidateSizing = input.preprocessing.candidateOutcomes.data.map(
    ({ candidate }) => ({
      actionType: candidate.action.type,
      targetStreetCommitment: candidate.targetStreetCommitment,
      targetKind: candidate.targetKind,
    }),
  )
  const contestablePot = input.preprocessing.contestablePot.data
  const currentMetrics = input.preprocessing.currentMetrics.data
  const actualPotOdds =
    currentMetrics.potOdds.status === 'available'
      ? {
          status: 'available' as const,
          numerator: currentMetrics.potOdds.value.numerator,
          denominator: currentMetrics.potOdds.value.denominator,
          basisPoints: currentMetrics.potOdds.value.basisPoints,
        }
      : {
          status: 'notApplicable' as const,
          reasonCode: currentMetrics.potOdds.reasonCode,
        }
  const handFeatures = input.preprocessing.handFeatures.data
  const actualHandFeatures =
    handFeatures.kind === 'preflop'
      ? {
          kind: 'preflop' as const,
          startingHandClass: handFeatures.startingHandClass,
          isPair: handFeatures.isPair,
          isSuited: handFeatures.isSuited,
          rankGap:
            handFeatures.rankGap.status === 'available'
              ? handFeatures.rankGap.value
              : null,
          isConnector: handFeatures.isConnector,
          isBroadway: handFeatures.isBroadway,
        }
      : {
          kind: 'postflop' as const,
          handCategory: handFeatures.handCategory,
          holeCardsUsed: handFeatures.holeCardsUsed,
          pairRelation: handFeatures.pairRelation,
          overcardCount: handFeatures.overcardCount,
          madeHandUsesBoardOnly: handFeatures.madeHandUsesBoardOnly,
          drawTypes: handFeatures.drawTypes,
          structuralOutCards: futureFact(handFeatures.structuralOutCards),
          redrawFacts: futureFact(handFeatures.redrawFacts),
          counterfeitRiskFacts: futureFact(handFeatures.counterfeitRiskFacts),
        }
  const expectedMemory = input.scenario.assertions.memory
  const memoryEvidence =
    expectedMemory === undefined
      ? null
      : input.preprocessing.opponentEvidence.data.opponents
          .find(
            ({ seatNumber }) =>
              seatNumber === expectedMemory.evidence.opponentSeatNumber,
          )
          ?.evidence.find(
            ({ metric }) => metric === expectedMemory.evidence.metric,
          )
  if (
    input.observation.table.seats.length !== input.scenario.input.playerCount ||
    input.observation.hand.street !== input.scenario.input.targetStreet ||
    input.observation.identity.actorSeat !==
      input.scenario.input.targetActorSeat ||
    input.preprocessing.candidateSource !== 'heuristic' ||
    actualActionTypes.join(',') !== expectedActionTypes.join(',') ||
    actualPublicActionTypes.join(',') !==
      input.scenario.assertions.publicActionTypes.join(',') ||
    topology.preflopNode.kind !== expectedTopology.preflopNodeKind ||
    topology.preflopNode.fullRaiseCount !== expectedTopology.fullRaiseCount ||
    topology.preflopNode.limperCount !== expectedTopology.limperCount ||
    topology.preflopNode.callerCount !== expectedTopology.callerCount ||
    topology.preflopNode.hasShortAllInRaise !==
      expectedTopology.hasShortAllInRaise ||
    topology.potType.kind !== expectedTopology.potTypeKind ||
    topology.potType.hasSidePot !== expectedTopology.hasSidePot ||
    topology.raiseReopenedForHero !== expectedTopology.raiseReopened ||
    topology.playerCounts.allInCount !== expectedTopology.allInCount ||
    (expectedForcedRunout === undefined
      ? input.forcedRunout !== null
      : input.forcedRunout?.terminationReason !==
          expectedForcedRunout.terminationReason ||
        input.forcedRunout.boardCardCount !==
          expectedForcedRunout.boardCardCount) ||
    input.preprocessing.candidates.data.reduce(
      (sum, candidate) => sum + candidate.weightBasisPoints,
      0,
    ) !== 10_000 ||
    input.preprocessing.candidates.data.some(
      (candidate) => candidate.sourceRefs.length === 0,
    ) ||
    input.preprocessing.opponentEvidence.data.status !==
      'insufficientEvidence' ||
    !sameJson(
      actualCandidateSizing,
      input.scenario.assertions.candidateSizing,
    ) ||
    !sameJson(
      {
        potBreakdown: contestablePot.potBreakdown.map((layer) => ({
          potId: layer.potId,
          amount: layer.amount,
          eligibleSeatNumbers: layer.eligibleSeatNumbers,
        })),
        heroContestablePotBefore: contestablePot.heroContestablePotBefore,
        heroMaximumContestableAmount:
          contestablePot.heroMaximumContestableAmount,
      },
      input.scenario.assertions.contestablePot,
    ) ||
    !sameJson(actualPotOdds, input.scenario.assertions.potOdds) ||
    !sameJson(actualHandFeatures, input.scenario.assertions.handFeatures) ||
    (expectedMemory !== undefined &&
      (input.sessionMemory.asOfEventSeq !==
        input.observation.identity.asOfEventSeq ||
        input.sessionMemory.payload.scannedThrough === null ||
        !sameJson(
          input.sessionMemory.payload.scannedThrough,
          expectedMemory.scannedThrough,
        ) ||
        input.sessionMemory.payload.lastCompletedHandNumber !==
          expectedMemory.lastCompletedHandNumber ||
        input.sessionMemory.payload.sessionSummary.completedHandsObserved !==
          expectedMemory.completedHandsObserved ||
        input.sessionMemory.payload.sessionSummary.showdownHandsObserved !==
          expectedMemory.showdownHandsObserved ||
        input.preprocessing.opponentEvidence.data.memoryRevision !==
          input.sessionMemory.revision ||
        input.preprocessing.opponentEvidence.data.historyAsOfEventSeq !==
          input.sessionMemory.asOfEventSeq ||
        input.preprocessing.opponentEvidence.data.historyAsOfEventSeq !==
          input.observation.identity.asOfEventSeq ||
        memoryEvidence?.numerator !== expectedMemory.evidence.numerator ||
        memoryEvidence?.denominator !== expectedMemory.evidence.denominator ||
        memoryEvidence?.distinctHandCount !==
          expectedMemory.evidence.distinctHandCount ||
        memoryEvidence?.currentHandAsOfEventSeq !==
          input.observation.identity.asOfEventSeq ||
        input.preprocessing.exploitAdjustment.data.status !==
          'insufficientEvidence' ||
        input.preprocessing.exploitAdjustment.data.reasonCode !==
          'noApprovedExploitBaseline' ||
        input.preprocessing.candidates.data.some(
          (candidate) =>
            candidate.exploitAdjustedWeightBasisPoints !==
            candidate.personaAdjustedWeightBasisPoints,
        )))
  ) {
    throw new Error(
      `player_deterministic_eval_assertion_failed:${input.scenario.scenarioId}`,
    )
  }
}
