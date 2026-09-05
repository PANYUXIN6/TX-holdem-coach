import {
  HandHistoryListItemSchema,
  type HandHistoryListItem,
} from '@tx-holdem-coach/contracts'
import type { CompletedHandHistoryListFact } from './completed-hand-history-list.js'
import { CompletedHandHistoryInvariantError } from './errors.js'

function copyCard(card: { readonly rank: string; readonly suit: string }) {
  return { rank: card.rank, suit: card.suit }
}

function invalid(): never {
  throw new CompletedHandHistoryInvariantError()
}

export function projectCompletedHandHistoryListItem(
  fact: CompletedHandHistoryListFact,
): HandHistoryListItem {
  try {
    const userSeat = fact.result.seats.find((seat) => seat.seatNumber === 0)
    const userHand = fact.result.participantHands.find(
      (participant) => participant.seatNumber === 0,
    )
    const userPosition = fact.result.positions.find(
      (position) => position.seatNumber === 0,
    )
    if (
      userSeat === undefined ||
      !userSeat.isUser ||
      userHand === undefined ||
      userPosition === undefined
    ) {
      return invalid()
    }
    const winnerSeatNumbers = [
      ...new Set(
        fact.result.pots.flatMap((pot) =>
          pot.awards.map((award) => award.seatNumber),
        ),
      ),
    ].sort((left, right) => left - right)
    const userAwardAmount = fact.result.pots.reduce(
      (total, pot) =>
        total +
        pot.awards
          .filter((award) => award.seatNumber === 0)
          .reduce((awardTotal, award) => awardTotal + award.amount, 0),
      0,
    )
    const response = HandHistoryListItemSchema.safeParse({
      handId: fact.handId,
      sessionId: fact.sessionId,
      handNumber: fact.handNumber,
      startedAt: fact.startedAt,
      completedAt: fact.completedAt,
      user: {
        position: userPosition.position,
        holeCards: userHand.holeCards.map(copyCard),
        startingHandCategory: userSeat.startingHandCategory,
        netChange: userSeat.netChange,
      },
      board: fact.result.board.map(copyCard),
      result: {
        terminationReason: fact.result.terminationReason,
        winnerSeatNumbers,
        userAwardAmount,
      },
      aiParticipants: fact.aiParticipants.map((participant) => ({
        seatNumber: participant.seatNumber,
        personaId: participant.personaId,
        personaVersion: participant.personaVersion,
        displayName: participant.displayName,
        avatarColor: participant.avatarColor,
        configSnapshotKey: participant.configSnapshotKey,
      })),
    })
    if (!response.success) return invalid()
    return response.data
  } catch (error) {
    if (error instanceof CompletedHandHistoryInvariantError) throw error
    return invalid()
  }
}
