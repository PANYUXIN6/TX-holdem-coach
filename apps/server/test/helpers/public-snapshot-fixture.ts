import type { PublicSessionSnapshot } from '@tx-holdem-coach/contracts'
import { getLegalActions } from '../../src/poker/betting.js'
import type { PrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'
import type { LockedSessionView } from '../../src/persistence/session-mutation-repository.js'
function projectCompletedHandSummary(
  summary: NonNullable<PrivateTableState['lastCompletedHandSummary']>,
): PublicSessionSnapshot['lastCompletedHandSummary'] {
  return {
    handId: summary.handId,
    terminationReason: summary.terminationReason,
    participantSeatNumbers: [...summary.participantSeatNumbers],
    buttonSeatNumber: summary.buttonSeatNumber,
    smallBlindSeatNumber: summary.smallBlindSeatNumber,
    bigBlindSeatNumber: summary.bigBlindSeatNumber,
    positions: summary.positions.map((position) => ({ ...position })),
    board: [...summary.board],
    seatResults: summary.seats.map(
      ({
        seatNumber,
        startingStack,
        endingStack,
        totalContribution,
        netChange,
      }) => ({
        seatNumber,
        startingStack,
        endingStack,
        totalContribution,
        netChange,
      }),
    ),
    uncalledBetReturns: summary.uncalledBetReturns.map((item) => ({
      ...item,
    })),
    pots: summary.pots.map((pot) => ({
      potIndex: pot.potIndex,
      kind: pot.kind,
      amount: pot.amount,
      winningSeatNumbers: [...pot.winningSeatNumbers],
      awards: pot.awards.map((award) => ({
        seatNumber: award.seatNumber,
        amount: award.amount,
      })),
    })),
    revealedHands: summary.participantHands.map((hand) => {
      const visible =
        hand.seatNumber === 0 ||
        (summary.terminationReason === 'showdown' &&
          hand.handEvaluation !== null)
      return {
        seatNumber: hand.seatNumber,
        holeCards: visible ? [...hand.holeCards] : null,
        handEvaluation:
          visible && hand.handEvaluation !== null
            ? {
                category: hand.handEvaluation.category,
                bestFive: [...hand.handEvaluation.bestFive],
              }
            : null,
      }
    }),
  }
}

export function projectPublicSnapshot(
  state: PrivateTableState,
  session: LockedSessionView,
  eventSeq: number,
): PublicSessionSnapshot {
  const hand = state.poker.hand
  const privateHeroHoleCards = hand?.holeCards.find(
    (cards) => cards.seatNumber === 0,
  )?.cards
  const heroHoleCards =
    privateHeroHoleCards === undefined ? null : [...privateHeroHoleCards]
  return {
    sessionId: session.sessionId,
    stateVersion: state.stateVersion,
    eventSeq,
    pokerPhase: state.poker.pokerPhase,
    lifecycleStatus: session.lifecycleStatus,
    agentRunState: session.agentRunState,
    activeDecision: null,
    seats: state.poker.seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      playerId: seat.playerId,
      displayName: seat.isUser ? '玩家' : `AI ${seat.seatNumber}`,
      avatarColor: '#0f766e',
      isUser: seat.isUser,
      stack: seat.stack,
      status: seat.status,
    })),
    hand:
      hand === null
        ? null
        : {
            handId: hand.handId,
            street: hand.street,
            board: [...hand.board],
            pot: hand.pot,
            currentActorSeatNumber: hand.currentActorSeatNumber,
            heroHoleCards,
            legalActions:
              hand.currentActorSeatNumber === 0
                ? getLegalActions(state.poker)
                : [],
            actionTimeline: [],
          },
    lastCompletedHandSummary:
      hand !== null || state.lastCompletedHandSummary === null
        ? null
        : projectCompletedHandSummary(state.lastCompletedHandSummary),
  }
}
