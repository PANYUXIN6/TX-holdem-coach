import type { PokerTableState } from './state.js'
import { getBlindSeatNumbers } from './positioning.js'

export type BlindPostingSeat = PokerTableState['seats'][number]

export interface PostBlindsInput {
  readonly seats: readonly BlindPostingSeat[]
  readonly buttonSeatNumber: number
  readonly participantSeatNumbers: readonly number[]
}

export interface BlindPost {
  readonly seatNumber: number
  readonly actualAmount: number
}

export interface BlindPostingResult {
  readonly seats: readonly BlindPostingSeat[]
  readonly smallBlind: BlindPost
  readonly bigBlind: BlindPost
  readonly potDelta: number
  readonly preflopCurrentBet: 20
  readonly minimumFullRaiseIncrement: 20
}

function validateStartingSeats(
  seats: readonly BlindPostingSeat[],
  participantSeatNumbers: readonly number[],
): void {
  if (!Array.isArray(seats) || seats.length !== participantSeatNumbers.length) {
    throw new RangeError('下盲座位必须与本手参与座位一一对应。')
  }

  const participantSet = new Set(participantSeatNumbers)
  const seenSeatNumbers = new Set<number>()

  for (const seat of seats) {
    if (
      seat === null ||
      typeof seat !== 'object' ||
      Array.isArray(seat) ||
      !Number.isInteger(seat.seatNumber) ||
      !participantSet.has(seat.seatNumber) ||
      seenSeatNumbers.has(seat.seatNumber)
    ) {
      throw new RangeError('下盲座位必须与本手参与座位一一对应。')
    }

    seenSeatNumbers.add(seat.seatNumber)

    if (
      seat.status !== 'active' ||
      !Number.isInteger(seat.stack) ||
      seat.stack <= 0
    ) {
      throw new RangeError('本手参与座位必须以正整数筹码和 active 状态下盲。')
    }

    if (seat.streetContribution !== 0 || seat.totalContribution !== 0) {
      throw new RangeError('下盲前所有本手投入必须为零。')
    }
  }
}

function postBlind(
  seats: readonly BlindPostingSeat[],
  seatNumber: number,
  nominalAmount: number,
): { seats: readonly BlindPostingSeat[]; post: BlindPost } {
  const blindSeat = seats.find((seat) => seat.seatNumber === seatNumber)

  if (blindSeat === undefined) {
    throw new RangeError('庄盲座位必须属于本手参与座位。')
  }

  const actualAmount = Math.min(blindSeat.stack, nominalAmount)
  const remainingStack = blindSeat.stack - actualAmount

  return {
    seats: seats.map((seat) =>
      seat.seatNumber === seatNumber
        ? {
            ...seat,
            stack: remainingStack,
            status: remainingStack === 0 ? 'allIn' : 'active',
            streetContribution: seat.streetContribution + actualAmount,
            totalContribution: seat.totalContribution + actualAmount,
          }
        : { ...seat },
    ),
    post: { seatNumber, actualAmount },
  }
}

export function postBlinds(input: PostBlindsInput): BlindPostingResult {
  const { smallBlindSeatNumber, bigBlindSeatNumber } = getBlindSeatNumbers(
    input.buttonSeatNumber,
    input.participantSeatNumbers,
  )
  validateStartingSeats(input.seats, input.participantSeatNumbers)

  const smallBlindResult = postBlind(input.seats, smallBlindSeatNumber, 10)
  const bigBlindResult = postBlind(
    smallBlindResult.seats,
    bigBlindSeatNumber,
    20,
  )

  return {
    seats: bigBlindResult.seats,
    smallBlind: smallBlindResult.post,
    bigBlind: bigBlindResult.post,
    potDelta:
      smallBlindResult.post.actualAmount + bigBlindResult.post.actualAmount,
    preflopCurrentBet: 20,
    minimumFullRaiseIncrement: 20,
  }
}
