import { z } from 'zod'
import type { DecisionAnalysisInput } from '../../poker/decision-analysis-input.js'
import { DecisionAnalysisSeatSchema } from '../../poker/decision-analysis-input-schema.js'

const sequence = z.number().int().nonnegative().safe()
export const CoachStreetStartStateSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('notApplicable'),
    reasonCode: z.literal('preflop'),
  }),
  z.strictObject({
    status: z.literal('available'),
    street: z.enum(['flop', 'turn', 'river']),
    eventSeq: sequence,
    pot: sequence,
    seats: z.array(DecisionAnalysisSeatSchema).min(6).max(9),
  }),
])
export type CoachStreetStartState = z.infer<typeof CoachStreetStartStateSchema>
export function projectCoachVisibleState(input: DecisionAnalysisInput) {
  return {
    heroSeat: input.heroSeatNumber,
    heroHoleCards: [...input.heroHoleCards],
    board: [...input.board],
    seats: input.seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      logicalPosition: input.positions.find(
        (position) => position.seatNumber === seat.seatNumber,
      )!.position,
      stack: seat.stack,
      streetCommitment: seat.streetContribution,
      totalCommitment: seat.totalContribution,
      status: seat.status,
    })),
    buttonSeat: input.buttonSeatNumber,
    smallBlindSeat: input.smallBlindSeatNumber,
    bigBlindSeat: input.bigBlindSeatNumber,
    nominalSmallBlind: 10,
    nominalBigBlind: 20,
    actualSmallBlind: Math.min(
      10,
      input.startingStacks.find(
        (seat) => seat.seatNumber === input.smallBlindSeatNumber,
      )!.stack,
    ),
    actualBigBlind: Math.min(
      20,
      input.startingStacks.find(
        (seat) => seat.seatNumber === input.bigBlindSeatNumber,
      )!.stack,
    ),
    publicActions: input.publicActions.map((action) => ({
      eventSeq: action.eventSeq,
      street: action.streetBefore,
      seatNumber: action.actorSeatNumber,
      action: action.action,
    })),
  }
}
export function projectCoachLegalActions(input: DecisionAnalysisInput) {
  const hero = input.seats.find(
    (seat) => seat.seatNumber === input.heroSeatNumber,
  )!
  return input.legalActions.map((action) => ({
    action: action.type,
    minimumTarget:
      action.type === 'bet' || action.type === 'raise'
        ? action.minTarget
        : action.type === 'allIn'
          ? action.target
          : action.type === 'call'
            ? hero.streetContribution + action.amount
            : null,
    maximumTarget:
      action.type === 'bet' || action.type === 'raise'
        ? action.maxTarget
        : action.type === 'allIn'
          ? action.target
          : action.type === 'call'
            ? hero.streetContribution + action.amount
            : null,
  }))
}
