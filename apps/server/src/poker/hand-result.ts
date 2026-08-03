import {
  CardSchema,
  LegalActionsSchema,
  type Card,
  type CardRank,
  type LegalActions,
} from '@tx-holdem-coach/contracts'
import { z } from 'zod'
import { PokerCommandSchema, type PokerCommand } from './commands.js'
import type { LogicalPosition } from './positioning.js'
import type { HandEvaluation } from './hand-evaluator.js'
import type {
  SettlementFacts,
  SettlementParticipantContext,
  SettlementTerminationReason,
  SettledHandEvaluation,
  SettledPot,
  UncalledBetReturn,
} from './settlement.js'
import type { PokerTableState } from './state.js'

export interface SeatPosition {
  readonly seatNumber: number
  readonly position: LogicalPosition
}
export interface SeatStack {
  readonly seatNumber: number
  readonly stack: number
}
export interface StartedHandFacts {
  readonly handId: string
  readonly handNumber: number
  readonly participantSeatNumbers: readonly number[]
  readonly buttonSeatNumber: number
  readonly smallBlindSeatNumber: number
  readonly bigBlindSeatNumber: number
  readonly positions: readonly SeatPosition[]
  readonly startingStacks: readonly SeatStack[]
}
export type StartingHandCategory =
  | `${CardRank}${CardRank}`
  | `${CardRank}${CardRank}s`
  | `${CardRank}${CardRank}o`
export interface CompletedHandSeatResult {
  readonly seatNumber: number
  readonly playerId: string
  readonly isUser: boolean
  readonly startingStack: number
  readonly endingStack: number
  readonly totalContribution: number
  readonly netChange: number
  readonly startingHandCategory: StartingHandCategory
}
export interface CompletedHandSummary {
  readonly handId: string
  readonly terminationReason: SettlementTerminationReason
  readonly participantSeatNumbers: readonly number[]
  readonly buttonSeatNumber: number
  readonly smallBlindSeatNumber: number
  readonly bigBlindSeatNumber: number
  readonly positions: readonly SeatPosition[]
  readonly board: readonly Card[]
  readonly seats: readonly CompletedHandSeatResult[]
  readonly uncalledBetReturns: readonly UncalledBetReturn[]
  readonly pots: readonly SettledPot[]
  readonly participantHands: readonly CompletedHandParticipantHand[]
}
export interface CompletedHandParticipantHand {
  readonly seatNumber: number
  readonly holeCards: readonly [Card, Card]
  readonly handEvaluation: HandEvaluation | null
}
export interface CompletedHandResult extends Omit<
  CompletedHandSummary,
  'board'
> {
  readonly remainingDeck: readonly Card[]
  readonly burnedCards: readonly Card[]
  readonly board: readonly Card[]
  readonly holeCards: readonly SettlementParticipantContext[]
  readonly handEvaluations: readonly SettledHandEvaluation[]
  readonly summary: CompletedHandSummary
}
type PokerHandStreet = NonNullable<PokerTableState['hand']>['street']
export interface ActionSeatSnapshot {
  readonly seatNumber: number
  readonly status: 'active' | 'folded' | 'allIn' | 'out'
  readonly stack: number
  readonly streetContribution: number
  readonly totalContribution: number
}
export interface ActionTableSnapshot {
  readonly street: PokerHandStreet
  readonly board: readonly Card[]
  readonly currentActorSeatNumber: number | null
  readonly pot: number
  readonly seats: readonly ActionSeatSnapshot[]
}
export interface ActionProgressionFacts {
  readonly streetTransitions: readonly PokerHandStreet[]
  readonly burnedCardsAdded: readonly Card[]
  readonly boardCardsAdded: readonly Card[]
  readonly terminationReason: SettlementTerminationReason | null
}
export interface ActionStatisticsFacts {
  readonly isVoluntaryPreflopContribution: boolean
  readonly isPreflopRaise: boolean
  readonly isVoluntaryPreflopFullRaise: boolean
  readonly canMakeFullRaiseBeforeAction: boolean
}
export type PokerDomainEventDraft =
  | { readonly type: 'handStarted'; readonly startedHand: StartedHandFacts }
  | {
      readonly type: 'actionCommitted'
      readonly handId: string
      readonly actorSeatNumber: number
      readonly command: PokerCommand
      readonly legalActionsBefore: LegalActions
      readonly before: ActionTableSnapshot
      readonly after: ActionTableSnapshot
      readonly progression: ActionProgressionFacts
      readonly statistics: ActionStatisticsFacts
    }
  | {
      readonly type: 'uncalledBetReturned'
      readonly handId: string
      readonly returns: readonly UncalledBetReturn[]
    }
  | {
      readonly type: 'handCompleted'
      readonly handId: string
      readonly terminationReason: SettlementTerminationReason
      readonly summary: CompletedHandSummary
    }
export interface CreateCompletedHandResultInput {
  readonly facts: SettlementFacts
  readonly state: PokerTableState
  readonly smallBlindSeatNumber: number
  readonly bigBlindSeatNumber: number
  readonly positions: readonly SeatPosition[]
}
export interface CreateActionCommittedEventInput {
  readonly handId: string
  readonly actorSeatNumber: number
  readonly command: PokerCommand
  readonly legalActionsBefore: LegalActions
  readonly before: ActionTableSnapshot
  readonly after: ActionTableSnapshot
  readonly progression: ActionProgressionFacts
  readonly statistics: ActionStatisticsFacts
}

const RANK_STRENGTH: Readonly<Record<CardRank, number>> = {
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 7,
  '8': 8,
  '9': 9,
  T: 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
}

const SafeIntegerSchema = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER)
const SafeNonnegativeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
const SafePositiveIntegerSchema = SafeNonnegativeIntegerSchema.positive()
const SeatNumberSchema = z.number().int().min(0).max(8)
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
const HandEvaluationSchema = z.strictObject({
  category: z.enum([
    'highCard',
    'onePair',
    'twoPair',
    'threeOfAKind',
    'straight',
    'flush',
    'fullHouse',
    'fourOfAKind',
    'straightFlush',
  ]),
  comparisonGrade: z.tuple([
    SafeNonnegativeIntegerSchema,
    SafeNonnegativeIntegerSchema,
    SafeNonnegativeIntegerSchema,
    SafeNonnegativeIntegerSchema,
    SafeNonnegativeIntegerSchema,
    SafeNonnegativeIntegerSchema,
  ]),
  bestFive: z.tuple([
    CardSchema,
    CardSchema,
    CardSchema,
    CardSchema,
    CardSchema,
  ]),
  displayName: z.string().min(1),
})

function isStartingHandCategory(value: unknown): value is StartingHandCategory {
  if (typeof value !== 'string') return false
  const match = /^([2-9TJQKA])([2-9TJQKA])([so])?$/.exec(value)
  if (match === null) return false
  const firstRank = match[1] as CardRank
  const secondRank = match[2] as CardRank
  const suffix = match[3]
  return firstRank === secondRank
    ? suffix === undefined
    : suffix !== undefined &&
        RANK_STRENGTH[firstRank] > RANK_STRENGTH[secondRank]
}

const StartingHandCategorySchema = z.custom<StartingHandCategory>(
  isStartingHandCategory,
)
const SeatPositionSchema = z.strictObject({
  seatNumber: SeatNumberSchema,
  position: LogicalPositionSchema,
})
const CompletedHandSeatResultSchema = z.strictObject({
  seatNumber: SeatNumberSchema,
  playerId: z.uuid(),
  isUser: z.boolean(),
  startingStack: SafeNonnegativeIntegerSchema,
  endingStack: SafeNonnegativeIntegerSchema,
  totalContribution: SafeNonnegativeIntegerSchema,
  netChange: SafeIntegerSchema,
  startingHandCategory: StartingHandCategorySchema,
})
const UncalledBetReturnSchema = z.strictObject({
  seatNumber: SeatNumberSchema,
  amount: SafePositiveIntegerSchema,
})
const PotAwardSchema = z.strictObject({
  seatNumber: SeatNumberSchema,
  baseAmount: SafeNonnegativeIntegerSchema,
  oddChipAmount: z.union([z.literal(0), z.literal(1)]),
  amount: SafeNonnegativeIntegerSchema,
})
const SettledPotSchema = z.strictObject({
  potIndex: SafeNonnegativeIntegerSchema,
  kind: z.enum(['main', 'side']),
  amount: SafePositiveIntegerSchema,
  contributingSeatNumbers: z.array(SeatNumberSchema).min(1),
  eligibleSeatNumbers: z.array(SeatNumberSchema).min(1),
  winningSeatNumbers: z.array(SeatNumberSchema).min(1),
  awards: z.array(PotAwardSchema).min(1),
})
const CompletedHandParticipantHandSchema = z.strictObject({
  seatNumber: SeatNumberSchema,
  holeCards: z.tuple([CardSchema, CardSchema]),
  handEvaluation: HandEvaluationSchema.nullable(),
})

function cardKey(card: Card): string {
  return `${card.rank}:${card.suit}`
}

export const CompletedHandSummarySchema: z.ZodType<CompletedHandSummary> = z
  .strictObject({
    handId: z.uuid(),
    terminationReason: z.enum(['showdown', 'complete']),
    participantSeatNumbers: z.array(SeatNumberSchema).min(6).max(9),
    buttonSeatNumber: SeatNumberSchema,
    smallBlindSeatNumber: SeatNumberSchema,
    bigBlindSeatNumber: SeatNumberSchema,
    positions: z.array(SeatPositionSchema),
    board: z.array(CardSchema).max(5),
    seats: z.array(CompletedHandSeatResultSchema),
    uncalledBetReturns: z.array(UncalledBetReturnSchema).max(1),
    pots: z.array(SettledPotSchema).min(1),
    participantHands: z.array(CompletedHandParticipantHandSchema),
  })
  .superRefine((summary, context) => {
    const participants = summary.participantSeatNumbers
    const participantSet = new Set(participants)
    const isAscending = (values: readonly number[]) =>
      values.every(
        (value, index) => index === 0 || value > (values[index - 1] as number),
      )
    const requireExactParticipantSeats = (
      values: readonly { readonly seatNumber: number }[],
      path: 'positions' | 'seats' | 'participantHands',
    ) => {
      if (
        values.length !== participants.length ||
        new Set(values.map((value) => value.seatNumber)).size !==
          participants.length ||
        values.some((value) => !participantSet.has(value.seatNumber))
      ) {
        context.addIssue({
          code: 'custom',
          message: '座位集合必须与本手参与座位完全一致。',
          path: [path],
        })
      }
    }

    if (
      participantSet.size !== participants.length ||
      !isAscending(participants)
    ) {
      context.addIssue({
        code: 'custom',
        message: '本手参与座位必须唯一并按座位号升序。',
        path: ['participantSeatNumbers'],
      })
    }

    const blindSeats = [
      summary.buttonSeatNumber,
      summary.smallBlindSeatNumber,
      summary.bigBlindSeatNumber,
    ]
    if (
      new Set(blindSeats).size !== blindSeats.length ||
      blindSeats.some((seatNumber) => !participantSet.has(seatNumber))
    ) {
      context.addIssue({
        code: 'custom',
        message: '按钮和庄盲必须是不同的参与座位。',
        path: ['buttonSeatNumber'],
      })
    }

    requireExactParticipantSeats(summary.positions, 'positions')
    requireExactParticipantSeats(summary.seats, 'seats')
    requireExactParticipantSeats(summary.participantHands, 'participantHands')

    for (const [path, values] of [
      ['positions', summary.positions],
      ['seats', summary.seats],
      ['participantHands', summary.participantHands],
      ['uncalledBetReturns', summary.uncalledBetReturns],
    ] as const) {
      if (!isAscending(values.map((value) => value.seatNumber))) {
        context.addIssue({
          code: 'custom',
          message: '座位数组必须按座位号升序。',
          path: [path],
        })
      }
    }

    if (
      new Set(summary.positions.map((position) => position.position)).size !==
      summary.positions.length
    ) {
      context.addIssue({
        code: 'custom',
        message: '每个参与座位必须具有唯一逻辑位置。',
        path: ['positions'],
      })
    }
    const positionBySeat = new Map(
      summary.positions.map((position) => [
        position.seatNumber,
        position.position,
      ]),
    )
    if (
      positionBySeat.get(summary.buttonSeatNumber) !== 'BTN' ||
      positionBySeat.get(summary.smallBlindSeatNumber) !== 'SB' ||
      positionBySeat.get(summary.bigBlindSeatNumber) !== 'BB'
    ) {
      context.addIssue({
        code: 'custom',
        message: '按钮和庄盲座位必须与逻辑位置镜像一致。',
        path: ['positions'],
      })
    }

    if (
      new Set(summary.seats.map((seat) => seat.playerId)).size !==
        summary.seats.length ||
      summary.seats.filter((seat) => seat.isUser).length !== 1 ||
      summary.seats.some((seat) => seat.isUser !== (seat.seatNumber === 0))
    ) {
      context.addIssue({
        code: 'custom',
        message: '完成手座位结果必须保留唯一玩家和固定用户座位。',
        path: ['seats'],
      })
    }
    const participantHandBySeat = new Map(
      summary.participantHands.map((hand) => [hand.seatNumber, hand]),
    )
    summary.seats.forEach((seat, index) => {
      const participantHand = participantHandBySeat.get(seat.seatNumber)
      if (
        BigInt(seat.netChange) !==
          BigInt(seat.endingStack) - BigInt(seat.startingStack) ||
        participantHand === undefined ||
        seat.startingHandCategory !==
          classifyStartingHand(participantHand.holeCards)
      ) {
        context.addIssue({
          code: 'custom',
          message: '完成手座位结果必须与筹码和底牌事实镜像一致。',
          path: ['seats', index],
        })
      }
    })

    if (
      new Set(summary.uncalledBetReturns.map((item) => item.seatNumber))
        .size !== summary.uncalledBetReturns.length ||
      summary.uncalledBetReturns.some(
        (item) => !participantSet.has(item.seatNumber),
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: '未跟注返还必须来自唯一的参与座位。',
        path: ['uncalledBetReturns'],
      })
    }

    const boardAndHoleCardKeys = [
      ...summary.board,
      ...summary.participantHands.flatMap((hand) => hand.holeCards),
    ].map(cardKey)
    if (new Set(boardAndHoleCardKeys).size !== boardAndHoleCardKeys.length) {
      context.addIssue({
        code: 'custom',
        message: '公共牌和参与者底牌不得重复。',
        path: ['participantHands'],
      })
    }

    const evaluatedSeatNumbers = new Set<number>()
    summary.participantHands.forEach((hand, index) => {
      const evaluation = hand.handEvaluation
      if (evaluation === null) return
      evaluatedSeatNumbers.add(hand.seatNumber)
      const availableCards = new Set(
        [...summary.board, ...hand.holeCards].map(cardKey),
      )
      const bestFiveKeys = evaluation.bestFive.map(cardKey)
      if (
        new Set(bestFiveKeys).size !== bestFiveKeys.length ||
        bestFiveKeys.some((key) => !availableCards.has(key))
      ) {
        context.addIssue({
          code: 'custom',
          message: '最佳五张牌必须来自该参与者可用牌且不得重复。',
          path: ['participantHands', index, 'handEvaluation', 'bestFive'],
        })
      }
    })

    if (summary.terminationReason === 'complete') {
      if (evaluatedSeatNumbers.size !== 0) {
        context.addIssue({
          code: 'custom',
          message: '未摊牌完成手不得包含牌型评估。',
          path: ['participantHands'],
        })
      }
    } else {
      const eligibleSeatNumbers = new Set(
        summary.pots.flatMap((pot) => pot.eligibleSeatNumbers),
      )
      if (
        summary.board.length !== 5 ||
        evaluatedSeatNumbers.size !== eligibleSeatNumbers.size ||
        [...eligibleSeatNumbers].some(
          (seatNumber) => !evaluatedSeatNumbers.has(seatNumber),
        )
      ) {
        context.addIssue({
          code: 'custom',
          message: '摊牌评估必须与全部有资格参与底池的座位一致。',
          path: ['participantHands'],
        })
      }
    }

    summary.pots.forEach((pot, potIndex) => {
      const isUniqueParticipantSubset = (values: readonly number[]) =>
        new Set(values).size === values.length &&
        values.every((seatNumber) => participantSet.has(seatNumber))
      const contributingSet = new Set(pot.contributingSeatNumbers)
      const eligibleSet = new Set(pot.eligibleSeatNumbers)
      if (
        pot.potIndex !== potIndex ||
        pot.kind !== (potIndex === 0 ? 'main' : 'side') ||
        !isUniqueParticipantSubset(pot.contributingSeatNumbers) ||
        !isUniqueParticipantSubset(pot.eligibleSeatNumbers) ||
        !isUniqueParticipantSubset(pot.winningSeatNumbers) ||
        pot.eligibleSeatNumbers.some(
          (seatNumber) => !contributingSet.has(seatNumber),
        ) ||
        pot.winningSeatNumbers.some(
          (seatNumber) => !eligibleSet.has(seatNumber),
        )
      ) {
        context.addIssue({
          code: 'custom',
          message: '底池座位集合和顺序必须一致。',
          path: ['pots', potIndex],
        })
      }
      if (
        !isAscending(pot.contributingSeatNumbers) ||
        !isAscending(pot.eligibleSeatNumbers) ||
        !isAscending(pot.winningSeatNumbers) ||
        new Set(pot.awards.map((award) => award.seatNumber)).size !==
          pot.winningSeatNumbers.length ||
        pot.awards.some(
          (award) => !pot.winningSeatNumbers.includes(award.seatNumber),
        )
      ) {
        context.addIssue({
          code: 'custom',
          message: '底池参与者、赢家和派奖集合必须规范。',
          path: ['pots', potIndex],
        })
      }
      pot.awards.forEach((award, awardIndex) => {
        if (
          BigInt(award.amount) !==
          BigInt(award.baseAmount) + BigInt(award.oddChipAmount)
        ) {
          context.addIssue({
            code: 'custom',
            message: '派奖金额必须等于基础金额与奇数筹码之和。',
            path: ['pots', potIndex, 'awards', awardIndex, 'amount'],
          })
        }
      })
      if (
        pot.awards.reduce(
          (total, award) => total + BigInt(award.amount),
          0n,
        ) !== BigInt(pot.amount)
      ) {
        context.addIssue({
          code: 'custom',
          message: '底池派奖总额必须等于底池金额。',
          path: ['pots', potIndex, 'amount'],
        })
      }
    })
  })
function freeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
function copy<Value>(value: Value): Value {
  return freeze(structuredClone(value))
}
function sortSeats<Value extends { readonly seatNumber: number }>(
  values: readonly Value[],
): Value[] {
  return [...values].sort((a, b) => a.seatNumber - b.seatNumber)
}
function assertParticipants(seats: readonly number[]): void {
  if (
    seats.length < 6 ||
    seats.length > 9 ||
    new Set(seats).size !== seats.length
  )
    throw new RangeError('参与座位必须是 6 到 9 个不重复座位。')
}

export function classifyStartingHand(
  cards: readonly [Card, Card],
): StartingHandCategory {
  const [first, second] = cards
  const [high, low] =
    RANK_STRENGTH[first.rank] >= RANK_STRENGTH[second.rank]
      ? [first, second]
      : [second, first]
  return (
    high.rank === low.rank
      ? `${high.rank}${low.rank}`
      : `${high.rank}${low.rank}${high.suit === low.suit ? 's' : 'o'}`
  ) as StartingHandCategory
}

export function createStartedHandFacts(
  input: StartedHandFacts,
): StartedHandFacts {
  assertParticipants(input.participantSeatNumbers)
  if (!Number.isInteger(input.handNumber) || input.handNumber < 1)
    throw new RangeError('手牌序号必须是正整数。')
  const participants = new Set(input.participantSeatNumbers)
  if (
    ![
      input.buttonSeatNumber,
      input.smallBlindSeatNumber,
      input.bigBlindSeatNumber,
    ].every((seat) => participants.has(seat)) ||
    new Set([
      input.buttonSeatNumber,
      input.smallBlindSeatNumber,
      input.bigBlindSeatNumber,
    ]).size !== 3
  )
    throw new RangeError('按钮和庄盲必须是不同的参与座位。')
  for (const values of [input.positions, input.startingStacks])
    if (
      values.length !== participants.size ||
      new Set(values.map((value) => value.seatNumber)).size !==
        participants.size ||
      values.some((value) => !participants.has(value.seatNumber))
    )
      throw new RangeError('位置和起始筹码必须与参与座位一一对应。')
  return copy({
    ...input,
    participantSeatNumbers: [...participants].sort((a, b) => a - b),
    positions: sortSeats(input.positions),
    startingStacks: sortSeats(input.startingStacks),
  })
}

export function createCompletedHandResult(
  input: CreateCompletedHandResultInput,
): CompletedHandResult {
  if (input.state.pokerPhase !== 'betweenHands' || input.state.hand !== null)
    throw new RangeError('完成手结果必须使用结算后的 betweenHands 状态。')
  const facts = copy(input.facts)
  const participants = facts.hand.participants.map((item) => item.seatNumber)
  assertParticipants(participants)
  const participantSet = new Set(participants)
  const settlementSeatNumbers = facts.hand.seats.map((item) => item.seatNumber)
  const finalSeatNumbers = input.state.seats.map((item) => item.seatNumber)
  const hasExactlyParticipants = (seatNumbers: readonly number[]) =>
    seatNumbers.length === participants.length &&
    new Set(seatNumbers).size === participants.length &&
    seatNumbers.every((seatNumber) => participantSet.has(seatNumber))
  if (
    !hasExactlyParticipants(settlementSeatNumbers) ||
    !hasExactlyParticipants(finalSeatNumbers) ||
    input.state.buttonSeatNumber !== facts.hand.buttonSeatNumber ||
    !participantSet.has(facts.hand.buttonSeatNumber) ||
    new Set([
      facts.hand.buttonSeatNumber,
      input.smallBlindSeatNumber,
      input.bigBlindSeatNumber,
    ]).size !== 3 ||
    !participantSet.has(input.smallBlindSeatNumber) ||
    !participantSet.has(input.bigBlindSeatNumber) ||
    input.positions.length !== participants.length ||
    new Set(input.positions.map((item) => item.seatNumber)).size !==
      participants.length ||
    input.positions.some((item) => !participantSet.has(item.seatNumber))
  )
    throw new RangeError('完成手庄盲和位置必须与参与座位一一对应。')
  const finalSeats = new Map(
    input.state.seats.map((seat) => [seat.seatNumber, seat]),
  )
  const cards = new Map(
    facts.hand.participants.map((item) => [item.seatNumber, item.holeCards]),
  )
  const evaluations = new Map(
    facts.handEvaluations.map((item) => [item.seatNumber, item.evaluation]),
  )
  const terminationStatuses = new Map(
    facts.hand.seats.map((seat) => [seat.seatNumber, seat.statusAtTermination]),
  )
  if (
    evaluations.size !== facts.handEvaluations.length ||
    [...evaluations.keys()].some(
      (seatNumber) =>
        !participantSet.has(seatNumber) ||
        !['active', 'allIn'].includes(
          terminationStatuses.get(seatNumber) ?? '',
        ),
    ) ||
    (facts.hand.terminationReason === 'complete' && evaluations.size !== 0)
  ) {
    throw new RangeError('结算牌型评估必须与终止参与座位一致。')
  }
  const seats = facts.hand.seats.map((seat) => {
    const finalSeat = finalSeats.get(seat.seatNumber)
    const holeCards = cards.get(seat.seatNumber)
    if (
      finalSeat === undefined ||
      holeCards === undefined ||
      finalSeat.playerId !== seat.playerId ||
      finalSeat.isUser !== seat.isUser
    )
      throw new RangeError('结算事实与最终状态必须包含相同参与座位。')
    return {
      seatNumber: seat.seatNumber,
      playerId: seat.playerId,
      isUser: seat.isUser,
      startingStack: seat.startingStack,
      endingStack: finalSeat.stack,
      totalContribution: seat.totalContribution,
      netChange: finalSeat.stack - seat.startingStack,
      startingHandCategory: classifyStartingHand(holeCards),
    }
  })
  const result = {
    handId: facts.hand.handId,
    terminationReason: facts.hand.terminationReason,
    participantSeatNumbers: [...participants].sort((a, b) => a - b),
    buttonSeatNumber: facts.hand.buttonSeatNumber,
    smallBlindSeatNumber: input.smallBlindSeatNumber,
    bigBlindSeatNumber: input.bigBlindSeatNumber,
    positions: sortSeats(input.positions),
    remainingDeck: facts.hand.remainingDeck,
    burnedCards: facts.hand.burnedCards,
    board: facts.hand.board,
    holeCards: sortSeats(facts.hand.participants),
    seats: sortSeats(seats),
    uncalledBetReturns: sortSeats(facts.uncalledBetReturns),
    pots: facts.pots,
    handEvaluations: sortSeats(facts.handEvaluations),
  }
  const participantHands = sortSeats(
    facts.hand.participants.map((participant) => ({
      seatNumber: participant.seatNumber,
      holeCards: participant.holeCards,
      handEvaluation: evaluations.get(participant.seatNumber) ?? null,
    })),
  )
  const summary: CompletedHandSummary = {
    handId: result.handId,
    terminationReason: result.terminationReason,
    participantSeatNumbers: result.participantSeatNumbers,
    buttonSeatNumber: result.buttonSeatNumber,
    smallBlindSeatNumber: result.smallBlindSeatNumber,
    bigBlindSeatNumber: result.bigBlindSeatNumber,
    positions: result.positions,
    board: result.board,
    seats: result.seats,
    uncalledBetReturns: result.uncalledBetReturns,
    pots: result.pots,
    participantHands,
  }
  return copy({ ...result, participantHands, summary })
}

export function createHandStartedEventDraft(
  startedHand: StartedHandFacts,
): PokerDomainEventDraft {
  return copy({
    type: 'handStarted' as const,
    startedHand: createStartedHandFacts(startedHand),
  })
}
export function createActionCommittedEventDraft(
  input: CreateActionCommittedEventInput,
): PokerDomainEventDraft {
  PokerCommandSchema.parse(input.command)
  LegalActionsSchema.parse(input.legalActionsBefore)
  if (
    input.actorSeatNumber !== input.command.actorSeatNumber ||
    input.actorSeatNumber !== input.before.currentActorSeatNumber
  ) {
    throw new RangeError('动作行动者必须与命令和行动前快照一致。')
  }
  if (
    (input.statistics.isPreflopRaise &&
      !input.statistics.isVoluntaryPreflopContribution) ||
    (input.statistics.isVoluntaryPreflopFullRaise &&
      (!input.statistics.isPreflopRaise ||
        !input.statistics.isVoluntaryPreflopContribution))
  ) {
    throw new RangeError('翻前统计事实彼此矛盾。')
  }
  const { action } = input.command
  const { statistics } = input
  if (
    input.before.street !== 'preflop' &&
    (statistics.isVoluntaryPreflopContribution ||
      statistics.isPreflopRaise ||
      statistics.isVoluntaryPreflopFullRaise ||
      statistics.canMakeFullRaiseBeforeAction)
  ) {
    throw new RangeError('非翻前动作不得携带翻前统计事实。')
  }
  if (
    input.before.street === 'preflop' &&
    (action.type === 'fold' || action.type === 'check') &&
    (statistics.isVoluntaryPreflopContribution ||
      statistics.isPreflopRaise ||
      statistics.isVoluntaryPreflopFullRaise)
  ) {
    throw new RangeError('弃牌或过牌不得携带主动翻前投入或加注事实。')
  }
  if (
    input.before.street === 'preflop' &&
    action.type === 'call' &&
    (!statistics.isVoluntaryPreflopContribution ||
      statistics.isPreflopRaise ||
      statistics.isVoluntaryPreflopFullRaise)
  ) {
    throw new RangeError('翻前跟注统计事实不一致。')
  }
  if (
    input.before.street === 'preflop' &&
    action.type === 'allIn' &&
    !statistics.isVoluntaryPreflopContribution
  ) {
    throw new RangeError('翻前全下必须记录主动投入事实。')
  }
  if (
    input.before.street === 'preflop' &&
    (action.type === 'bet' || action.type === 'raise') &&
    (!statistics.isVoluntaryPreflopContribution ||
      !statistics.isPreflopRaise ||
      !statistics.isVoluntaryPreflopFullRaise)
  ) {
    throw new RangeError('普通翻前下注或加注必须记录完整加注事实。')
  }
  for (const snapshot of [input.before, input.after])
    if (
      snapshot.seats.length === 0 ||
      new Set(snapshot.seats.map((seat) => seat.seatNumber)).size !==
        snapshot.seats.length
    )
      throw new RangeError('动作快照必须包含不重复座位。')
  return copy({
    ...input,
    type: 'actionCommitted' as const,
    before: { ...input.before, seats: sortSeats(input.before.seats) },
    after: { ...input.after, seats: sortSeats(input.after.seats) },
  })
}
export function createUncalledBetReturnedEventDraft(
  handId: string,
  returns: readonly UncalledBetReturn[],
): PokerDomainEventDraft {
  if (returns.length === 0)
    throw new RangeError('未跟注返还事件必须包含返还事实。')
  return copy({
    type: 'uncalledBetReturned' as const,
    handId,
    returns: sortSeats(returns),
  })
}
export function createHandCompletedEventDraft(
  result: CompletedHandResult,
): PokerDomainEventDraft {
  return copy({
    type: 'handCompleted' as const,
    handId: result.handId,
    terminationReason: result.terminationReason,
    summary: result.summary,
  })
}
