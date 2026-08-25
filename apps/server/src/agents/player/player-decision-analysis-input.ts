import { LegalActionsSchema } from '@tx-holdem-coach/contracts'
import type { DecisionAnalysisInput } from '../../poker/decision-analysis-input.js'
import { POKER_RULE_SET_VERSION } from '../../poker/poker-rule-set.js'
import type { PlayerVisibleState } from '../../sessions/authoritative-state/player-visible-state.js'
import { isPlayerVisibleState } from '../../sessions/authoritative-state/player-information-boundary-guard.js'
import type { PlayerDecisionReference } from './player-decision-reference.js'

export interface PlayerDecisionAnalysisBinding {
  readonly observationSchemaVersion: 1
  readonly observationSha256: string
  readonly sessionId: string
  readonly handId: string
  readonly stateVersion: number
  readonly decisionRequestId: string
  readonly actorParticipantId: string
  readonly actorSeat: number
  readonly asOfEventSeq: number
  readonly pokerRuleSetVersion: typeof POKER_RULE_SET_VERSION
}

export interface BoundAnalysis<TData> {
  readonly binding: PlayerDecisionAnalysisBinding
  readonly data: TData
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

function assertReferenceMatches(
  observation: PlayerVisibleState,
  reference: PlayerDecisionReference,
): void {
  if (
    reference.sessionId !== observation.identity.sessionId ||
    reference.handId !== observation.identity.handId ||
    reference.actorParticipantId !== observation.identity.actorParticipantId ||
    reference.actorSeat !== observation.identity.actorSeat ||
    reference.handNumber !== observation.hand.handNumber ||
    reference.pokerRuleSetVersion !== POKER_RULE_SET_VERSION
  ) {
    throw new RangeError('Player 决策参考与认证观察不一致。')
  }
}

export function createPlayerDecisionAnalysisBinding(input: {
  readonly observation: PlayerVisibleState
  readonly reference: PlayerDecisionReference
}): PlayerDecisionAnalysisBinding {
  if (!isPlayerVisibleState(input.observation)) {
    throw new RangeError('Player 决策分析只接受实时认证观察。')
  }
  assertReferenceMatches(input.observation, input.reference)
  const identity = input.observation.identity
  return deepFreeze({
    observationSchemaVersion: 1,
    observationSha256: input.observation.observationSha256,
    sessionId: identity.sessionId,
    handId: identity.handId,
    stateVersion: identity.stateVersion,
    decisionRequestId: identity.decisionRequestId,
    actorParticipantId: identity.actorParticipantId,
    actorSeat: identity.actorSeat,
    asOfEventSeq: identity.asOfEventSeq,
    pokerRuleSetVersion: POKER_RULE_SET_VERSION,
  })
}

export function createPlayerDecisionAnalysisInput(input: {
  readonly observation: PlayerVisibleState
  readonly reference: PlayerDecisionReference
}): {
  readonly binding: PlayerDecisionAnalysisBinding
  readonly analysisInput: DecisionAnalysisInput
} {
  const binding = createPlayerDecisionAnalysisBinding(input)
  const observation = input.observation
  const analysisInput: DecisionAnalysisInput = {
    pokerRuleSetVersion: input.reference.pokerRuleSetVersion,
    buttonSeatNumber: observation.table.buttonSeatNumber,
    participantSeatNumbers: [...observation.hand.participantSeatNumbers],
    heroSeatNumber: observation.identity.actorSeat,
    street: observation.hand.street,
    positions: observation.hand.positions.map((position) => ({ ...position })),
    startingStacks: observation.hand.startingStacks.map((stack) => ({
      ...stack,
    })),
    smallBlindSeatNumber: observation.hand.smallBlindSeatNumber,
    bigBlindSeatNumber: observation.hand.bigBlindSeatNumber,
    heroHoleCards: [
      { ...observation.hand.heroHoleCards[0] },
      { ...observation.hand.heroHoleCards[1] },
    ],
    board: observation.hand.board.map((card) => ({ ...card })),
    pot: observation.hand.pot,
    seats: observation.table.seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      stack: seat.stack,
      status: seat.status,
      streetContribution: seat.streetContribution,
      totalContribution: seat.totalContribution,
    })),
    bettingRound: {
      currentBet: observation.hand.bettingRound.currentBet,
      minimumFullRaiseIncrement:
        observation.hand.bettingRound.minimumFullRaiseIncrement,
      seatStates: observation.hand.bettingRound.seatStates.map((seat) => ({
        ...seat,
      })),
    },
    legalActions: LegalActionsSchema.parse(observation.hand.legalActions),
    publicActions: observation.hand.publicActions.map((action) => ({
      eventSeq: action.eventSeq,
      streetBefore: action.streetBefore,
      actorSeatNumber: action.actorSeatNumber,
      action: { ...action.action.action },
      amountToCallBefore: action.amountToCallBefore,
      contributionDelta: action.contributionDelta,
      targetStreetCommitmentAfter: action.targetStreetCommitmentAfter,
      totalContributionAfter: action.totalContributionAfter,
      potBefore: action.potBefore,
      currentBetBefore: action.currentBetBefore,
      currentBetAfter: action.currentBetAfter,
      minimumFullRaiseIncrementBefore: action.minimumFullRaiseIncrementBefore,
      minimumFullRaiseIncrementAfter: action.minimumFullRaiseIncrementAfter,
      isVoluntaryPreflopContribution: action.isVoluntaryPreflopContribution,
      isFullRaise: action.isFullRaise,
    })),
  }
  return deepFreeze({ binding, analysisInput })
}

export function samePlayerDecisionBinding(
  left: PlayerDecisionAnalysisBinding,
  right: PlayerDecisionAnalysisBinding,
): boolean {
  return (
    left.observationSchemaVersion === right.observationSchemaVersion &&
    left.observationSha256 === right.observationSha256 &&
    left.sessionId === right.sessionId &&
    left.handId === right.handId &&
    left.stateVersion === right.stateVersion &&
    left.decisionRequestId === right.decisionRequestId &&
    left.actorParticipantId === right.actorParticipantId &&
    left.actorSeat === right.actorSeat &&
    left.asOfEventSeq === right.asOfEventSeq &&
    left.pokerRuleSetVersion === right.pokerRuleSetVersion
  )
}
