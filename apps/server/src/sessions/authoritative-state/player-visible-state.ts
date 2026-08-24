import {
  CardSchema,
  LegalActionsSchema,
  type Card,
  type LegalAction,
} from '@tx-holdem-coach/contracts'
import { z } from 'zod'
import type { PokerCommand } from '../../poker/commands.js'
import { PokerCommandSchema } from '../../poker/commands.js'
import type { LogicalPosition } from '../../poker/positioning.js'

const SafeNonnegativeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
const ActionStreetSchema = z.enum(['preflop', 'flop', 'turn', 'river'])
const LogicalPositionSchema = z.enum([
  'UTG',
  'UTG+1',
  'MP',
  'LJ',
  'HJ',
  'CO',
  'BTN',
  'SB',
  'BB',
])

const PlayerVisibleSeatSchema = z.strictObject({
  seatNumber: z.number().int().min(0).max(8),
  participantId: z.string().uuid(),
  isUser: z.boolean(),
  stack: SafeNonnegativeIntegerSchema,
  status: z.enum(['active', 'folded', 'allIn', 'out']),
  streetContribution: SafeNonnegativeIntegerSchema,
  totalContribution: SafeNonnegativeIntegerSchema,
})

const PlayerVisibleActionSchema = z.strictObject({
  eventSeq: SafeNonnegativeIntegerSchema,
  stateVersionBefore: SafeNonnegativeIntegerSchema,
  stateVersionAfter: SafeNonnegativeIntegerSchema,
  streetBefore: ActionStreetSchema,
  actorSeatNumber: z.number().int().min(0).max(8),
  action: PokerCommandSchema,
  amountToCallBefore: SafeNonnegativeIntegerSchema,
  contributionDelta: SafeNonnegativeIntegerSchema,
  targetStreetCommitmentAfter: SafeNonnegativeIntegerSchema,
  totalContributionAfter: SafeNonnegativeIntegerSchema,
  potBefore: SafeNonnegativeIntegerSchema,
  currentBetBefore: SafeNonnegativeIntegerSchema,
  currentBetAfter: SafeNonnegativeIntegerSchema,
  minimumFullRaiseIncrementBefore: SafeNonnegativeIntegerSchema.min(20),
  minimumFullRaiseIncrementAfter: SafeNonnegativeIntegerSchema.min(20),
  isVoluntaryPreflopContribution: z.boolean(),
  isFullRaise: z.boolean(),
})

export const PlayerVisibleStateDataSchema = z.strictObject({
  observationSchemaVersion: z.literal(1),
  identity: z.strictObject({
    sessionId: z.string().uuid(),
    handId: z.string().uuid(),
    stateVersion: SafeNonnegativeIntegerSchema,
    decisionRequestId: z.string().uuid(),
    actorParticipantId: z.string().uuid(),
    actorSeat: z.number().int().min(1).max(8),
    asOfEventSeq: SafeNonnegativeIntegerSchema,
  }),
  table: z.strictObject({
    buttonSeatNumber: z.number().int().min(0).max(8),
    blinds: z.strictObject({
      smallBlind: z.literal(10),
      bigBlind: z.literal(20),
    }),
    seats: z.array(PlayerVisibleSeatSchema).min(6).max(9),
  }),
  hand: z.strictObject({
    handNumber: SafeNonnegativeIntegerSchema,
    street: ActionStreetSchema,
    participantSeatNumbers: z
      .array(z.number().int().min(0).max(8))
      .min(6)
      .max(9),
    smallBlindSeatNumber: z.number().int().min(0).max(8),
    bigBlindSeatNumber: z.number().int().min(0).max(8),
    positions: z.array(
      z.strictObject({
        seatNumber: z.number().int().min(0).max(8),
        position: LogicalPositionSchema,
      }),
    ),
    startingStacks: z.array(
      z.strictObject({
        seatNumber: z.number().int().min(0).max(8),
        stack: SafeNonnegativeIntegerSchema.positive(),
      }),
    ),
    heroHoleCards: z.tuple([CardSchema, CardSchema]),
    board: z.array(CardSchema).max(5),
    pot: SafeNonnegativeIntegerSchema,
    currentActorSeatNumber: z.number().int().min(1).max(8),
    bettingRound: z.strictObject({
      currentBet: SafeNonnegativeIntegerSchema,
      minimumFullRaiseIncrement: SafeNonnegativeIntegerSchema.positive(),
      seatStates: z.array(
        z.strictObject({
          seatNumber: z.number().int().min(0).max(8),
          betLevelAfterLastAction: SafeNonnegativeIntegerSchema.nullable(),
        }),
      ),
    }),
    legalActions: LegalActionsSchema,
    publicActions: z.array(PlayerVisibleActionSchema),
  }),
})

type DeepReadonly<Value> = Value extends object
  ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
  : Value

export type PlayerVisibleStateData = DeepReadonly<
  z.infer<typeof PlayerVisibleStateDataSchema>
>

export interface PlayerVisibleSeat {
  readonly seatNumber: number
  readonly participantId: string
  readonly isUser: boolean
  readonly stack: number
  readonly status: 'active' | 'folded' | 'allIn' | 'out'
  readonly streetContribution: number
  readonly totalContribution: number
}

export interface PlayerVisibleAction {
  readonly eventSeq: number
  readonly stateVersionBefore: number
  readonly stateVersionAfter: number
  readonly streetBefore: 'preflop' | 'flop' | 'turn' | 'river'
  readonly actorSeatNumber: number
  readonly action: PokerCommand
  readonly amountToCallBefore: number
  readonly contributionDelta: number
  readonly targetStreetCommitmentAfter: number
  readonly totalContributionAfter: number
  readonly potBefore: number
  readonly currentBetBefore: number
  readonly currentBetAfter: number
  readonly minimumFullRaiseIncrementBefore: number
  readonly minimumFullRaiseIncrementAfter: number
  readonly isVoluntaryPreflopContribution: boolean
  readonly isFullRaise: boolean
}

declare const playerVisibleStateBrand: unique symbol

export interface PlayerVisibleState extends PlayerVisibleStateData {
  readonly observationSha256: string
  readonly [playerVisibleStateBrand]: never
}

export class PlayerObservationBoundaryError extends Error {
  public constructor() {
    super('Player 权威观察未通过信息边界。')
    this.name = 'PlayerObservationBoundaryError'
  }
}

export type PlayerVisibleCard = Card
export type PlayerVisibleLegalAction = LegalAction
export type PlayerVisibleLogicalPosition = LogicalPosition
