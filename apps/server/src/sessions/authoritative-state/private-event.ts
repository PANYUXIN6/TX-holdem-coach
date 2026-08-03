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
const HAND_STREETS = [
  'postingBlinds',
  'preflop',
  'flop',
  'turn',
  'river',
  'showdown',
  'complete',
] as const
const HandStreetSchema = z.enum(HAND_STREETS)
const ACTION_STREETS = new Set(['preflop', 'flop', 'turn', 'river'])
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
const ActionTableSnapshotSchema = z
  .strictObject({
    street: HandStreetSchema,
    board: BoardSchema,
    currentActorSeatNumber: SeatNumberSchema.nullable(),
    pot: SafeNonnegativeIntegerSchema,
    seats: z.array(ActionSeatSnapshotSchema).min(6).max(9),
  })
  .superRefine((snapshot, context) => {
    const isActionStreet = ACTION_STREETS.has(snapshot.street)
    if (
      (isActionStreet && snapshot.currentActorSeatNumber === null) ||
      (!isActionStreet && snapshot.currentActorSeatNumber !== null)
    ) {
      context.addIssue({
        code: 'custom',
        message: '快照街道必须与当前行动者是否存在一致。',
        path: ['currentActorSeatNumber'],
      })
    }
    snapshot.seats.forEach((seat, index) => {
      if (seat.totalContribution < seat.streetContribution) {
        context.addIssue({
          code: 'custom',
          message: '本手总投入不得小于本街投入。',
          path: ['seats', index, 'totalContribution'],
        })
      }
    })
    const currentActor = snapshot.seats.find(
      (seat) => seat.seatNumber === snapshot.currentActorSeatNumber,
    )
    if (
      snapshot.currentActorSeatNumber !== null &&
      currentActor === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: '当前行动者必须存在于快照座位集合。',
        path: ['currentActorSeatNumber'],
      })
    }
    if (
      currentActor !== undefined &&
      (currentActor.status !== 'active' || currentActor.stack === 0)
    ) {
      context.addIssue({
        code: 'custom',
        message: '当前行动者必须处于可行动状态。',
        path: ['currentActorSeatNumber'],
      })
    }
    const totalContributions = snapshot.seats.reduce(
      (total, seat) => total + BigInt(seat.totalContribution),
      0n,
    )
    if (BigInt(snapshot.pot) !== totalContributions) {
      context.addIssue({
        code: 'custom',
        message: '快照底池必须等于全部座位总投入之和。',
        path: ['pot'],
      })
    }
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
          stack: SafeNonnegativeIntegerSchema.positive(),
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

const ActionCommittedEventSchema = z
  .strictObject({
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
  .superRefine((event, context) => {
    const beforeSeatNumbers = new Set(
      event.before.seats.map((seat) => seat.seatNumber),
    )
    const afterSeatNumbers = new Set(
      event.after.seats.map((seat) => seat.seatNumber),
    )
    if (!beforeSeatNumbers.has(event.actorSeatNumber)) {
      context.addIssue({
        code: 'custom',
        message: '行动者必须存在于行动前快照座位集合。',
        path: ['actorSeatNumber'],
      })
    }
    if (
      event.before.seats.length !== event.after.seats.length ||
      event.before.seats.some((seat) => !afterSeatNumbers.has(seat.seatNumber))
    ) {
      context.addIssue({
        code: 'custom',
        message: '行动前后快照必须具有相同座位集合。',
        path: ['after', 'seats'],
      })
    }
    const beforeFunds =
      event.before.seats.reduce(
        (total, seat) => total + BigInt(seat.stack),
        0n,
      ) + BigInt(event.before.pot)
    const afterFunds =
      event.after.seats.reduce(
        (total, seat) => total + BigInt(seat.stack),
        0n,
      ) + BigInt(event.after.pot)
    if (beforeFunds !== afterFunds) {
      context.addIssue({
        code: 'custom',
        message: '行动前后筹码与底池总额必须守恒。',
        path: ['after'],
      })
    }
    const beforeBoard = event.before.board.map(
      (card) => `${card.rank}:${card.suit}`,
    )
    const afterBoard = event.after.board.map(
      (card) => `${card.rank}:${card.suit}`,
    )
    const boardCardsAdded = event.progression.boardCardsAdded.map(
      (card) => `${card.rank}:${card.suit}`,
    )
    const expectedBoardCardsAdded = afterBoard.slice(beforeBoard.length)
    if (
      beforeBoard.length > afterBoard.length ||
      beforeBoard.some((card, index) => card !== afterBoard[index]) ||
      boardCardsAdded.length !== expectedBoardCardsAdded.length ||
      boardCardsAdded.some(
        (card, index) => card !== expectedBoardCardsAdded[index],
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: '公共牌新增事实必须等于行动后公共牌的精确新增后缀。',
        path: ['progression', 'boardCardsAdded'],
      })
    }
    const beforeStreetIndex = HAND_STREETS.indexOf(event.before.street)
    const afterStreetIndex = HAND_STREETS.indexOf(event.after.street)
    const expectedStreetTransitions =
      event.after.street === 'complete'
        ? ['complete']
        : afterStreetIndex < beforeStreetIndex
          ? null
          : HAND_STREETS.slice(beforeStreetIndex + 1, afterStreetIndex + 1)
    if (
      expectedStreetTransitions === null ||
      event.progression.streetTransitions.length !==
        expectedStreetTransitions.length ||
      event.progression.streetTransitions.some(
        (street, index) => street !== expectedStreetTransitions[index],
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: '街道转换事实必须与行动前后街道精确一致。',
        path: ['progression', 'streetTransitions'],
      })
    }
    const expectedTerminationReason =
      event.after.street === 'showdown' || event.after.street === 'complete'
        ? event.after.street
        : null
    if (event.progression.terminationReason !== expectedTerminationReason) {
      context.addIssue({
        code: 'custom',
        message: '终止原因必须与行动后街道一致。',
        path: ['progression', 'terminationReason'],
      })
    }
  })

const UncalledBetReturnedEventSchema = z.strictObject({
  type: z.literal('uncalledBetReturned'),
  handId: z.uuid(),
  returns: z
    .array(
      z.strictObject({
        seatNumber: SeatNumberSchema,
        amount: SafeNonnegativeIntegerSchema.positive(),
      }),
    )
    .max(1),
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
