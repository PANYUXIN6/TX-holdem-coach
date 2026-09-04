import {
  HandHistoryResponseSchema,
  type HandHistoryResponse,
  type HandHistoryView,
} from '@tx-holdem-coach/contracts'
import type {
  AuthoritativeCompletedHandHistory,
  HistoryBettingStreetPhase,
  HistoryShowdownPhase,
} from './completed-hand-history.js'
import { CompletedHandHistoryInvariantError } from './errors.js'

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const nestedValue of Object.values(value)) deepFreeze(nestedValue)
    Object.freeze(value)
  }
  return value
}

function copyCard(card: { readonly rank: string; readonly suit: string }) {
  return { rank: card.rank, suit: card.suit }
}

function projectBettingPhase(phase: HistoryBettingStreetPhase) {
  return {
    phase: phase.phase,
    communityCards: phase.communityCards.map(copyCard),
    actions: phase.actions.map((action) => ({
      actionNumber: action.actionNumber,
      eventSeq: action.eventSeq,
      actorSeatNumber: action.actorSeatNumber,
      playerId: action.playerId,
      position: action.position,
      action: { ...action.action },
      committedAmount: action.committedAmount,
      streetContributionAfterAction: action.streetContributionAfterAction,
      stackAfterAction: action.stackAfterAction,
      potBeforeAction: action.potBeforeAction,
      potAfterAction: action.potAfterAction,
    })),
  }
}

function projectResultPhase(
  history: AuthoritativeCompletedHandHistory,
  terminal: HistoryShowdownPhase,
  view: HandHistoryView,
) {
  const participantBySeat = new Map(
    history.participants.map((participant) => [
      participant.seatNumber,
      participant,
    ]),
  )
  return {
    phase: 'showdown' as const,
    terminationReason: terminal.terminationReason,
    handCompletedEventSeq: terminal.handCompletedEventSeq,
    communityCards: terminal.communityCards.map(copyCard),
    uncalledBetReturns: terminal.uncalledBetReturns.map((returned) => ({
      eventSeq: returned.eventSeq,
      seatNumber: returned.seatNumber,
      amount: returned.amount,
    })),
    revealedHands: terminal.privateHands.map((privateHand) => {
      const participant = participantBySeat.get(privateHand.seatNumber)
      if (participant === undefined)
        throw new CompletedHandHistoryInvariantError()
      const visible =
        view === 'auditReveal' ||
        participant.isUser ||
        (terminal.terminationReason === 'showdown' &&
          privateHand.handEvaluation !== null)
      return {
        seatNumber: privateHand.seatNumber,
        holeCards: visible ? privateHand.holeCards.map(copyCard) : null,
        handEvaluation:
          visible && privateHand.handEvaluation !== null
            ? {
                category: privateHand.handEvaluation.category,
                bestFive: privateHand.handEvaluation.bestFive.map(copyCard),
              }
            : null,
      }
    }),
    pots: terminal.pots.map((pot) => ({
      potIndex: pot.potIndex,
      kind: pot.kind,
      amount: pot.amount,
      winningSeatNumbers: [...pot.winningSeatNumbers],
      awards: pot.awards.map((award) => ({
        seatNumber: award.seatNumber,
        amount: award.amount,
      })),
    })),
  }
}

export function projectCompletedHandHistoryView(
  history: AuthoritativeCompletedHandHistory,
  view: HandHistoryView,
): HandHistoryResponse {
  try {
    const terminal = history.phases.at(-1)
    if (terminal?.phase !== 'showdown') {
      throw new CompletedHandHistoryInvariantError()
    }
    const response = HandHistoryResponseSchema.safeParse({
      protocolVersion: 1,
      view,
      history: {
        sessionId: history.sessionId,
        handId: history.handId,
        handNumber: history.handNumber,
        startedAt: history.startedAt,
        completedAt: history.completedAt,
        participantSeatNumbers: [...history.participantSeatNumbers],
        buttonSeatNumber: history.buttonSeatNumber,
        smallBlindSeatNumber: history.smallBlindSeatNumber,
        bigBlindSeatNumber: history.bigBlindSeatNumber,
        participants: history.participants.map((participant) => ({
          seatNumber: participant.seatNumber,
          playerId: participant.playerId,
          isUser: participant.isUser,
          displayName: participant.displayName,
          avatarColor: participant.avatarColor,
          position: participant.position,
          startingStack: participant.startingStack,
          endingStack: participant.endingStack,
          totalContribution: participant.totalContribution,
          netChange: participant.netChange,
        })),
        phases: [
          ...(
            history.phases.slice(0, -1) as readonly HistoryBettingStreetPhase[]
          ).map(projectBettingPhase),
          projectResultPhase(history, terminal, view),
        ],
      },
    })
    if (!response.success) throw new CompletedHandHistoryInvariantError()
    return deepFreeze(response.data)
  } catch (error) {
    if (error instanceof CompletedHandHistoryInvariantError) throw error
    throw new CompletedHandHistoryInvariantError()
  }
}
