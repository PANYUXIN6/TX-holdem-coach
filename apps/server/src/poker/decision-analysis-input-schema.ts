import { z } from 'zod'
import {
  CardSchema,
  LegalActionsSchema,
  PokerActionSchema,
  PublicLogicalPositionSchema,
  SeatNumberSchema,
} from '@tx-holdem-coach/contracts'
import { POKER_RULE_SET_VERSION } from './poker-rule-set.js'
const chips = z.number().int().nonnegative().safe()
export const DecisionAnalysisSeatSchema = z.strictObject({
  seatNumber: SeatNumberSchema,
  stack: chips,
  status: z.enum(['active', 'folded', 'allIn', 'out']),
  streetContribution: chips,
  totalContribution: chips,
})
export const DecisionAnalysisInputSchema = z.strictObject({
  pokerRuleSetVersion: z.literal(POKER_RULE_SET_VERSION),
  buttonSeatNumber: SeatNumberSchema,
  participantSeatNumbers: z.array(SeatNumberSchema).min(6).max(9),
  heroSeatNumber: SeatNumberSchema,
  street: z.enum(['preflop', 'flop', 'turn', 'river']),
  positions: z
    .array(
      z.strictObject({
        seatNumber: SeatNumberSchema,
        position: PublicLogicalPositionSchema,
      }),
    )
    .min(6)
    .max(9),
  startingStacks: z
    .array(z.strictObject({ seatNumber: SeatNumberSchema, stack: chips }))
    .min(6)
    .max(9),
  smallBlindSeatNumber: SeatNumberSchema,
  bigBlindSeatNumber: SeatNumberSchema,
  heroHoleCards: z.tuple([CardSchema, CardSchema]),
  board: z.array(CardSchema).max(5),
  pot: chips,
  seats: z.array(DecisionAnalysisSeatSchema).min(6).max(9),
  bettingRound: z.strictObject({
    currentBet: chips,
    minimumFullRaiseIncrement: chips.positive(),
    seatStates: z
      .array(
        z.strictObject({
          seatNumber: SeatNumberSchema,
          betLevelAfterLastAction: chips.nullable(),
        }),
      )
      .min(6)
      .max(9),
  }),
  legalActions: LegalActionsSchema,
  publicActions: z.array(
    z.strictObject({
      eventSeq: chips,
      streetBefore: z.enum(['preflop', 'flop', 'turn', 'river']),
      actorSeatNumber: SeatNumberSchema,
      action: PokerActionSchema,
      amountToCallBefore: chips,
      contributionDelta: chips,
      targetStreetCommitmentAfter: chips,
      totalContributionAfter: chips,
      potBefore: chips,
      currentBetBefore: chips,
      currentBetAfter: chips,
      minimumFullRaiseIncrementBefore: chips,
      minimumFullRaiseIncrementAfter: chips,
      isVoluntaryPreflopContribution: z.boolean(),
      isFullRaise: z.boolean(),
    }),
  ),
})
