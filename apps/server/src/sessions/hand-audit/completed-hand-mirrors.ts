import { isDeepStrictEqual } from 'node:util'
import type {
  CompletedHandResult,
  PokerDomainEventDraft,
} from '../../poker/hand-result.js'
import type { HandStartCheckpoint } from './hand-start-checkpoint.js'

function equalValues(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Checks the cross-payload identity mirrors shared by completed-hand readers
 * and writers. It deliberately returns a boolean so each boundary can map a
 * mismatch to its own stable error category.
 */
export function completedHandResultMirrorsCheckpoint(
  checkpoint: HandStartCheckpoint,
  result: CompletedHandResult,
): boolean {
  const startedHand = checkpoint.startedHand
  const resultSeatByNumber = new Map(
    result.seats.map((seat) => [seat.seatNumber, seat]),
  )
  const checkpointSeatByNumber = new Map(
    checkpoint.stateBeforeStartCommand.poker.seats.map((seat) => [
      seat.seatNumber,
      seat,
    ]),
  )
  return !(
    result.handId !== startedHand.handId ||
    result.buttonSeatNumber !== startedHand.buttonSeatNumber ||
    result.smallBlindSeatNumber !== startedHand.smallBlindSeatNumber ||
    result.bigBlindSeatNumber !== startedHand.bigBlindSeatNumber ||
    !equalValues(
      result.participantSeatNumbers,
      startedHand.participantSeatNumbers,
    ) ||
    !equalValues(result.positions, startedHand.positions) ||
    startedHand.startingStacks.some(
      (startingStack) =>
        resultSeatByNumber.get(startingStack.seatNumber)?.startingStack !==
        startingStack.stack,
    ) ||
    result.seats.some((seat) => {
      const checkpointSeat = checkpointSeatByNumber.get(seat.seatNumber)
      return (
        checkpointSeat === undefined ||
        checkpointSeat.playerId !== seat.playerId ||
        checkpointSeat.isUser !== seat.isUser
      )
    })
  )
}

/**
 * Checks the terminal action snapshot against the completed result before
 * returns and settlement redistribute the pot. Both command persistence and
 * completed-hand readers need this exact pre-settlement mirror.
 */
export function completedHandResultMirrorsTerminalAction(
  event: Extract<PokerDomainEventDraft, { readonly type: 'actionCommitted' }>,
  result: CompletedHandResult,
): boolean {
  const beforeBySeat = new Map(
    event.before.seats.map((seat) => [seat.seatNumber, seat]),
  )
  const resultBySeat = new Map(
    result.seats.map((seat) => [seat.seatNumber, seat]),
  )
  const expectedActorStatus =
    event.command.action.type === 'fold'
      ? 'folded'
      : event.command.action.type === 'allIn'
        ? 'allIn'
        : 'active'
  return (
    event.after.street === result.terminationReason &&
    event.after.currentActorSeatNumber === null &&
    isDeepStrictEqual(event.after.board, result.board) &&
    event.after.pot ===
      result.seats.reduce((total, seat) => total + seat.totalContribution, 0) &&
    event.after.seats.length === result.seats.length &&
    event.after.seats.every((afterSeat) => {
      const beforeSeat = beforeBySeat.get(afterSeat.seatNumber)
      const resultSeat = resultBySeat.get(afterSeat.seatNumber)
      if (beforeSeat === undefined || resultSeat === undefined) return false
      const contributionDelta =
        resultSeat.totalContribution - beforeSeat.totalContribution
      return (
        contributionDelta >= 0 &&
        afterSeat.totalContribution === resultSeat.totalContribution &&
        afterSeat.streetContribution ===
          beforeSeat.streetContribution + contributionDelta &&
        afterSeat.stack === beforeSeat.stack - contributionDelta &&
        afterSeat.stack ===
          resultSeat.startingStack - resultSeat.totalContribution &&
        afterSeat.status ===
          (afterSeat.seatNumber === event.actorSeatNumber
            ? expectedActorStatus
            : beforeSeat.status)
      )
    })
  )
}
