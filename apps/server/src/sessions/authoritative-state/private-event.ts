import { CardSchema, LegalActionsSchema } from '@tx-holdem-coach/contracts'
import { z } from 'zod'
import {
  CompletedHandSummarySchema,
  createActionCommittedEventDraft,
  createHandStartedEventDraft,
  createUncalledBetReturnedEventDraft,
  type PokerDomainEventDraft,
} from '../../poker/hand-result.js'
import { PokerCommandSchema } from '../../poker/commands.js'
import { AuthoritativeStateValidationError } from './errors.js'

const SeatNumberSchema = z.number().int().min(0).max(8)
const SafeNonnegativeIntegerSchema = z.number().int().nonnegative()
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
const HandStreetSchema = z.enum([
  'postingBlinds',
  'preflop',
  'flop',
  'turn',
  'river',
  'showdown',
  'complete',
])
const ActionSeatSnapshotSchema = z.strictObject({
  seatNumber: SeatNumberSchema,
  status: z.enum(['active', 'folded', 'allIn', 'out']),
  stack: SafeNonnegativeIntegerSchema,
  streetContribution: SafeNonnegativeIntegerSchema,
  totalContribution: SafeNonnegativeIntegerSchema,
})
const BoardSchema = z
  .array(CardSchema)
  .max(5)
  .superRefine((cards, context) => {
    const cardKeys = cards.map((card) => `${card.rank}:${card.suit}`)
    if (new Set(cardKeys).size !== cardKeys.length) {
      context.addIssue({
        code: 'custom',
        message: '行动快照公共牌不得重复。',
      })
    }
  })
const ActionTableSnapshotSchema = z.strictObject({
  street: HandStreetSchema,
  board: BoardSchema,
  currentActorSeatNumber: SeatNumberSchema.nullable(),
  pot: SafeNonnegativeIntegerSchema,
  seats: z.array(ActionSeatSnapshotSchema),
})

const HandStartedEventSchema = z
  .strictObject({
    type: z.literal('handStarted'),
    startedHand: z.strictObject({
      handId: z.uuid(),
      handNumber: SafeNonnegativeIntegerSchema,
      participantSeatNumbers: z.array(SeatNumberSchema),
      buttonSeatNumber: SeatNumberSchema,
      smallBlindSeatNumber: SeatNumberSchema,
      bigBlindSeatNumber: SeatNumberSchema,
      positions: z.array(
        z.strictObject({
          seatNumber: SeatNumberSchema,
          position: LogicalPositionSchema,
        }),
      ),
      startingStacks: z.array(
        z.strictObject({
          seatNumber: SeatNumberSchema,
          stack: SafeNonnegativeIntegerSchema,
        }),
      ),
    }),
  })
  .superRefine((event, context) => {
    const positions = event.startedHand.positions
    const positionBySeat = new Map(
      positions.map((position) => [position.seatNumber, position.position]),
    )
    if (
      new Set(positions.map((position) => position.position)).size !==
        positions.length ||
      positionBySeat.get(event.startedHand.buttonSeatNumber) !== 'BTN' ||
      positionBySeat.get(event.startedHand.smallBlindSeatNumber) !== 'SB' ||
      positionBySeat.get(event.startedHand.bigBlindSeatNumber) !== 'BB'
    ) {
      context.addIssue({
        code: 'custom',
        message: '开手位置必须唯一并与按钮和庄盲镜像一致。',
        path: ['startedHand', 'positions'],
      })
    }
  })

const ActionCommittedEventSchema = z.strictObject({
  type: z.literal('actionCommitted'),
  handId: z.uuid(),
  actorSeatNumber: SeatNumberSchema,
  command: PokerCommandSchema,
  legalActionsBefore: LegalActionsSchema,
  before: ActionTableSnapshotSchema,
  after: ActionTableSnapshotSchema,
  progression: z.strictObject({
    streetTransitions: z.array(HandStreetSchema),
    burnedCardsAdded: z.array(CardSchema),
    boardCardsAdded: z.array(CardSchema),
    terminationReason: z.enum(['showdown', 'complete']).nullable(),
  }),
  statistics: z.strictObject({
    isVoluntaryPreflopContribution: z.boolean(),
    isPreflopRaise: z.boolean(),
    isVoluntaryPreflopFullRaise: z.boolean(),
    canMakeFullRaiseBeforeAction: z.boolean(),
  }),
})

const UncalledBetReturnedEventSchema = z.strictObject({
  type: z.literal('uncalledBetReturned'),
  handId: z.uuid(),
  returns: z.array(
    z.strictObject({
      seatNumber: SeatNumberSchema,
      amount: SafeNonnegativeIntegerSchema.positive(),
    }),
  ),
})

const HandCompletedEventSchema = z
  .strictObject({
    type: z.literal('handCompleted'),
    handId: z.uuid(),
    terminationReason: z.enum(['showdown', 'complete']),
    summary: CompletedHandSummarySchema,
  })
  .superRefine((event, context) => {
    if (
      event.handId !== event.summary.handId ||
      event.terminationReason !== event.summary.terminationReason
    ) {
      context.addIssue({
        code: 'custom',
        message: '完成手事件必须与摘要镜像一致。',
        path: ['summary'],
      })
    }
  })

const PrivateEventV1Schema = z.discriminatedUnion('type', [
  HandStartedEventSchema,
  ActionCommittedEventSchema,
  UncalledBetReturnedEventSchema,
  HandCompletedEventSchema,
])

export type PrivateEventV1 = PokerDomainEventDraft

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const nestedValue of Object.values(value)) {
      deepFreeze(nestedValue)
    }
    Object.freeze(value)
  }
  return value
}

export function createPrivateEventV1(input: unknown): PrivateEventV1 {
  try {
    const parsed = PrivateEventV1Schema.parse(input)
    if (parsed.type === 'handStarted') {
      return createHandStartedEventDraft(parsed.startedHand)
    }
    if (parsed.type === 'actionCommitted') {
      return createActionCommittedEventDraft(parsed)
    }
    if (parsed.type === 'uncalledBetReturned') {
      return createUncalledBetReturnedEventDraft(parsed.handId, parsed.returns)
    }
    return deepFreeze(structuredClone(parsed))
  } catch {
    throw new AuthoritativeStateValidationError()
  }
}
