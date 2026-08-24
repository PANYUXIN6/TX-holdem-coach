import type { LegalActions } from '@tx-holdem-coach/contracts'
import {
  createCommittedActionProof,
  getProjectedLegalActions,
  projectBettingTransition,
  type BettingProjectionState,
} from './betting-projection.js'
import { PokerCommandSchema, type PokerCommand } from './commands.js'
import type { PokerTableState } from './state.js'

type BettingRound = NonNullable<
  NonNullable<PokerTableState['hand']>['bettingRound']
>

export interface BettingTransitionResult {
  readonly actorSeatNumber: number
  readonly action: PokerCommand['action']
  readonly contributionDelta: number
  readonly seats: PokerTableState['seats']
  readonly pot: number
  readonly bettingRound: BettingRound
}

function toBettingProjectionState(
  state: PokerTableState,
): BettingProjectionState {
  const hand = state.hand
  if (
    state.pokerPhase !== 'inHand' ||
    hand === null ||
    !['preflop', 'flop', 'turn', 'river'].includes(hand.street) ||
    hand.bettingRound === null ||
    hand.currentActorSeatNumber === null
  ) {
    throw new RangeError('只有稳定下注街道才能生成或执行动作。')
  }
  return {
    buttonSeatNumber: state.buttonSeatNumber,
    participantSeatNumbers: hand.holeCards.map(
      (holeCards) => holeCards.seatNumber,
    ),
    street: hand.street as BettingProjectionState['street'],
    currentActorSeatNumber: hand.currentActorSeatNumber,
    pot: hand.pot,
    seats: state.seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      status: seat.status,
      stack: seat.stack,
      streetContribution: seat.streetContribution,
      totalContribution: seat.totalContribution,
    })),
    bettingRound: {
      currentBet: hand.bettingRound.currentBet,
      minimumFullRaiseIncrement: hand.bettingRound.minimumFullRaiseIncrement,
      seatStates: hand.bettingRound.seatStates.map((seatState) => ({
        seatNumber: seatState.seatNumber,
        betLevelAfterLastAction: seatState.betLevelAfterLastAction,
      })),
    },
  }
}

export function getLegalActions(state: PokerTableState): LegalActions {
  return getProjectedLegalActions(toBettingProjectionState(state))
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const nestedValue of Object.values(value)) deepFreeze(nestedValue)
    Object.freeze(value)
  }
  return value
}

export function applyBettingAction(
  state: PokerTableState,
  command: PokerCommand,
): BettingTransitionResult {
  const parsedCommand = PokerCommandSchema.parse(command)
  const projectionState = toBettingProjectionState(state)
  if (
    parsedCommand.actorSeatNumber !== projectionState.currentActorSeatNumber
  ) {
    throw new RangeError('命令行动者必须等于当前行动者。')
  }
  const legalActions = getProjectedLegalActions(projectionState)
  const transition = projectBettingTransition(
    projectionState,
    createCommittedActionProof(parsedCommand, legalActions),
  )
  const projectedSeatByNumber = new Map(
    transition.state.seats.map((seat) => [seat.seatNumber, seat]),
  )
  const seats = state.seats.map((seat) => {
    const projected = projectedSeatByNumber.get(seat.seatNumber)
    if (projected === undefined) {
      throw new RangeError('下注投影缺少权威座位。')
    }
    return { ...seat, ...projected }
  })
  return deepFreeze({
    actorSeatNumber: transition.actorSeatNumber,
    action: transition.action,
    contributionDelta: transition.contributionDelta,
    seats,
    pot: transition.state.pot,
    bettingRound: transition.state.bettingRound,
  })
}
