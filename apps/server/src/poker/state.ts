import { CardSchema } from '@tx-holdem-coach/contracts'
import { z } from 'zod'

const SeatNumberSchema = z.number().int().min(0).max(8)
const ChipAmountSchema = z.number().int().nonnegative()
const PlayerIdSchema = z.uuid()
const PokerPhaseSchema = z.enum(['setup', 'betweenHands', 'inHand'])
const SeatStatusSchema = z.enum(['active', 'folded', 'allIn', 'out'])
const HandStreetSchema = z.enum([
  'postingBlinds',
  'preflop',
  'flop',
  'turn',
  'river',
  'showdown',
  'complete',
])
const ActionStreetSchema = z.enum(['preflop', 'flop', 'turn', 'river'])

const PokerSeatSchema = z.strictObject({
  seatNumber: SeatNumberSchema,
  playerId: PlayerIdSchema,
  isUser: z.boolean(),
  stack: ChipAmountSchema,
  status: SeatStatusSchema,
  streetContribution: ChipAmountSchema,
  totalContribution: ChipAmountSchema,
})

const HoleCardsSchema = z.strictObject({
  seatNumber: SeatNumberSchema,
  cards: z.array(CardSchema),
})

const PokerHandSchema = z.strictObject({
  handId: z.uuid(),
  street: HandStreetSchema,
  remainingDeck: z.array(CardSchema),
  burnedCards: z.array(CardSchema),
  board: z.array(CardSchema),
  holeCards: z.array(HoleCardsSchema),
  currentActorSeatNumber: SeatNumberSchema.nullable(),
  pot: ChipAmountSchema,
})

const PokerStateSchema = z
  .strictObject({
    stateVersion: z.number().int().nonnegative(),
    pokerPhase: PokerPhaseSchema,
    seats: z.array(PokerSeatSchema).min(6).max(9),
    buttonSeatNumber: SeatNumberSchema,
    blinds: z.strictObject({
      smallBlind: z.literal(10),
      bigBlind: z.literal(20),
    }),
    hand: PokerHandSchema.nullable(),
  })
  .superRefine((state, context) => {
    const seatNumbers = new Set<number>()
    const playerIds = new Set<string>()

    state.seats.forEach((seat, index) => {
      if (seatNumbers.has(seat.seatNumber)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: '座位号不得重复。',
          path: ['seats', index, 'seatNumber'],
        })
      }

      seatNumbers.add(seat.seatNumber)

      if (seat.isUser && seat.seatNumber !== 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: '本地用户必须固定在座位 0。',
          path: ['seats', index, 'seatNumber'],
        })
      }

      if (!seat.isUser && seat.seatNumber === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'AI 不得占用座位 0。',
          path: ['seats', index, 'seatNumber'],
        })
      }

      if (playerIds.has(seat.playerId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: '玩家标识不得重复。',
          path: ['seats', index, 'playerId'],
        })
      }

      playerIds.add(seat.playerId)

      if (seat.totalContribution < seat.streetContribution) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: '本手总投入不得小于本街投入。',
          path: ['seats', index, 'totalContribution'],
        })
      }

      if (
        state.pokerPhase !== 'inHand' &&
        (seat.streetContribution !== 0 || seat.totalContribution !== 0)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: '非进行中的牌局投入必须为零。',
          path: ['seats', index],
        })
      }
    })

    if (state.seats.filter((seat) => seat.isUser).length !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '必须恰好有一个本地用户座位。',
        path: ['seats'],
      })
    }

    if (!seatNumbers.has(state.buttonSeatNumber)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '按钮必须引用已有座位。',
        path: ['buttonSeatNumber'],
      })
    }

    if (state.pokerPhase === 'inHand' && state.hand === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '进行中的牌局必须包含当前手牌。',
        path: ['hand'],
      })
    }

    if (state.pokerPhase !== 'inHand' && state.hand !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '非进行中的牌局不得包含当前手牌。',
        path: ['hand'],
      })
    }

    if (state.hand !== null) {
      const isActionStreet = ActionStreetSchema.safeParse(
        state.hand.street,
      ).success

      if (isActionStreet && state.hand.currentActorSeatNumber === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: '下注街道必须包含当前行动者。',
          path: ['hand', 'currentActorSeatNumber'],
        })
      }

      if (!isActionStreet && state.hand.currentActorSeatNumber !== null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: '下盲或结算街道不得包含当前行动者。',
          path: ['hand', 'currentActorSeatNumber'],
        })
      }

      const dealtCards = new Set<string>()
      const holeCardSeats = new Set<number>()
      const validateUniqueCard = (
        card: { rank: string; suit: string },
        path: Array<string | number>,
      ) => {
        const cardKey = `${card.rank}:${card.suit}`

        if (dealtCards.has(cardKey)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: '当前手牌中的牌张不得重复。',
            path,
          })
        }

        dealtCards.add(cardKey)
      }

      state.hand.remainingDeck.forEach((card, index) => {
        validateUniqueCard(card, ['hand', 'remainingDeck', index])
      })
      state.hand.burnedCards.forEach((card, index) => {
        validateUniqueCard(card, ['hand', 'burnedCards', index])
      })
      state.hand.board.forEach((card, index) => {
        validateUniqueCard(card, ['hand', 'board', index])
      })
      state.hand.holeCards.forEach((holeCards, holeCardsIndex) => {
        if (holeCardSeats.has(holeCards.seatNumber)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: '底牌座位不得重复。',
            path: ['hand', 'holeCards', holeCardsIndex, 'seatNumber'],
          })
        }

        holeCardSeats.add(holeCards.seatNumber)

        if (!seatNumbers.has(holeCards.seatNumber)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: '底牌必须引用已有座位。',
            path: ['hand', 'holeCards', holeCardsIndex, 'seatNumber'],
          })
        }

        holeCards.cards.forEach((card, cardIndex) => {
          validateUniqueCard(card, [
            'hand',
            'holeCards',
            holeCardsIndex,
            'cards',
            cardIndex,
          ])
        })
      })

      if (state.hand.currentActorSeatNumber !== null) {
        const currentActor = state.seats.find(
          (seat) => seat.seatNumber === state.hand?.currentActorSeatNumber,
        )

        if (currentActor === undefined) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: '当前行动者必须引用已有座位。',
            path: ['hand', 'currentActorSeatNumber'],
          })
        }

        if (
          currentActor !== undefined &&
          (currentActor.status !== 'active' || currentActor.stack === 0)
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: '当前行动者必须可以行动。',
            path: ['hand', 'currentActorSeatNumber'],
          })
        }
      }
    }
  })

export type PokerStateInput = z.input<typeof PokerStateSchema>

type DeepReadonly<Value> = Value extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : Value extends object
    ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
    : Value

export type PokerState = DeepReadonly<z.output<typeof PokerStateSchema>>

function deepFreeze<Value>(value: Value): DeepReadonly<Value> {
  if (value !== null && typeof value === 'object') {
    for (const nestedValue of Object.values(value)) {
      deepFreeze(nestedValue)
    }

    Object.freeze(value)
  }

  return value as DeepReadonly<Value>
}

export function createPokerState(input: unknown): PokerState {
  return deepFreeze(structuredClone(PokerStateSchema.parse(input)))
}
