import { CardSchema, PokerActionSchema } from '@tx-holdem-coach/contracts'
import { z } from 'zod'
import type {
  AuthoritativeCompletedHandHistory,
  CompletedHandHistoryFacts,
  HistoryBettingStreet,
  HistoryBettingStreetPhase,
  HistoryShowdownPhase,
} from './completed-hand-history.js'
import { projectParticipantPresentation } from '../participant-presentation.js'
import {
  completedHandResultMirrorsCheckpoint,
  completedHandResultMirrorsTerminalAction,
} from '../hand-audit/completed-hand-mirrors.js'
import { CompletedHandHistoryInvariantError } from './errors.js'

const SafeNonnegativeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
const SafeIntegerSchema = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER)
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
const StartingHandCategorySchema = z
  .string()
  .regex(/^([2-9TJQKA])([2-9TJQKA])(?:[so])?$/)
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
  displayName: z.enum([
    '高牌',
    '一对',
    '两对',
    '三条',
    '顺子',
    '同花',
    '葫芦',
    '四条',
    '同花顺',
    '皇家同花顺',
  ]),
})
const HistoryParticipantSchema = z.strictObject({
  seatNumber: SeatNumberSchema,
  playerId: z.uuid(),
  isUser: z.boolean(),
  displayName: z.string().min(1),
  avatarColor: z.string().min(1),
  position: LogicalPositionSchema,
  startingStack: SafeNonnegativeIntegerSchema,
  endingStack: SafeNonnegativeIntegerSchema,
  totalContribution: SafeNonnegativeIntegerSchema,
  netChange: SafeIntegerSchema,
  startingHandCategory: StartingHandCategorySchema,
})
const HistoryActionSchema = z.strictObject({
  actionNumber: SafeNonnegativeIntegerSchema.positive(),
  eventSeq: SafeNonnegativeIntegerSchema,
  actorSeatNumber: SeatNumberSchema,
  playerId: z.uuid(),
  position: LogicalPositionSchema,
  action: PokerActionSchema,
  committedAmount: SafeNonnegativeIntegerSchema,
  streetContributionAfterAction: SafeNonnegativeIntegerSchema,
  stackAfterAction: SafeNonnegativeIntegerSchema,
  potBeforeAction: SafeNonnegativeIntegerSchema,
  potAfterAction: SafeNonnegativeIntegerSchema,
})
const HistoryBettingStreetPhaseSchema = z.strictObject({
  phase: z.enum(['preflop', 'flop', 'turn', 'river']),
  communityCards: z.array(CardSchema),
  actions: z.array(HistoryActionSchema),
})
const HistoryUncalledBetReturnSchema = z.strictObject({
  eventSeq: SafeNonnegativeIntegerSchema,
  seatNumber: SeatNumberSchema,
  amount: SafeNonnegativeIntegerSchema.positive(),
})
const HistoryPrivateHandSchema = z.strictObject({
  seatNumber: SeatNumberSchema,
  holeCards: z.tuple([CardSchema, CardSchema]),
  handEvaluation: HandEvaluationSchema.nullable(),
})
const SettledPotSchema = z.strictObject({
  potIndex: SafeNonnegativeIntegerSchema,
  kind: z.enum(['main', 'side']),
  amount: SafeNonnegativeIntegerSchema.positive(),
  contributingSeatNumbers: z.array(SeatNumberSchema).min(1),
  eligibleSeatNumbers: z.array(SeatNumberSchema).min(1),
  winningSeatNumbers: z.array(SeatNumberSchema).min(1),
  awards: z
    .array(
      z.strictObject({
        seatNumber: SeatNumberSchema,
        baseAmount: SafeNonnegativeIntegerSchema,
        oddChipAmount: z.union([z.literal(0), z.literal(1)]),
        amount: SafeNonnegativeIntegerSchema,
      }),
    )
    .min(1),
})
const HistoryShowdownPhaseSchema = z.strictObject({
  phase: z.literal('showdown'),
  terminationReason: z.enum(['showdown', 'complete']),
  handCompletedEventSeq: SafeNonnegativeIntegerSchema,
  communityCards: z.array(CardSchema),
  uncalledBetReturns: z.array(HistoryUncalledBetReturnSchema),
  privateHands: z.array(HistoryPrivateHandSchema),
  pots: z.array(SettledPotSchema).min(1),
})
const HistoryPhaseSchema = z.discriminatedUnion('phase', [
  HistoryBettingStreetPhaseSchema,
  HistoryShowdownPhaseSchema,
])

export const AuthoritativeCompletedHandHistorySchema = z
  .strictObject({
    sessionId: z.uuid(),
    handId: z.uuid(),
    handNumber: SafeNonnegativeIntegerSchema.positive(),
    pokerRuleSetVersion: z.literal('nlhe-cash-6to9-10-20-v1'),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime(),
    participantSeatNumbers: z.array(SeatNumberSchema).min(6).max(9),
    buttonSeatNumber: SeatNumberSchema,
    smallBlindSeatNumber: SeatNumberSchema,
    bigBlindSeatNumber: SeatNumberSchema,
    participants: z.array(HistoryParticipantSchema).min(6).max(9),
    phases: z.array(HistoryPhaseSchema).min(2),
  })
  .superRefine((history, context) => {
    const terminal = history.phases.at(-1)
    if (
      terminal?.phase !== 'showdown' ||
      history.phases[0]?.phase !== 'preflop'
    ) {
      context.addIssue({
        code: 'custom',
        message: '完成手历史必须以翻前开始并以终局分组结束。',
      })
    }
  })

const STREET_ORDER = ['preflop', 'flop', 'turn', 'river'] as const

function fail(): never {
  throw new CompletedHandHistoryInvariantError()
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const nestedValue of Object.values(value)) deepFreeze(nestedValue)
    Object.freeze(value)
  }
  return value
}

function equalValues(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function isSafeNonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function requireSafeDifference(left: number, right: number): number {
  const difference = left - right
  return isSafeNonnegativeInteger(difference) ? difference : fail()
}

function getFactEventHandId(
  event: CompletedHandHistoryFacts['events'][number]['event'],
): string | null {
  switch (event.type) {
    case 'handStarted':
      return event.startedHand.handId
    case 'actionCommitted':
    case 'uncalledBetReturned':
    case 'handCompleted':
    case 'handAborted':
    case 'agentStarted':
    case 'agentRepairAttempted':
    case 'agentPaused':
      return event.handId
    case 'sessionCreated':
    case 'userRebuy':
    case 'aiAutoRebuy':
    case 'sessionEnded':
      return null
  }
}

function boardForStreet(
  street: HistoryBettingStreet,
  board: readonly { readonly rank: string; readonly suit: string }[],
) {
  if (street === 'preflop') return []
  if (street === 'flop') return board.slice(0, 3)
  if (street === 'turn') return board.slice(0, 4)
  return board.slice(0, 5)
}

function requiredBoardLength(street: HistoryBettingStreet): number {
  return street === 'preflop'
    ? 0
    : street === 'flop'
      ? 3
      : street === 'turn'
        ? 4
        : 5
}

function sortedHistoryEvents(facts: CompletedHandHistoryFacts) {
  const events = [...facts.events].sort(
    (left, right) => left.eventSeq - right.eventSeq,
  )
  let previousEventSeq = -1
  for (const fact of events) {
    if (
      !isSafeNonnegativeInteger(fact.eventSeq) ||
      fact.eventSeq <= previousEventSeq
    ) {
      fail()
    }
    const eventHandId = getFactEventHandId(fact.event)
    if (eventHandId !== null && eventHandId !== facts.handId) fail()
    previousEventSeq = fact.eventSeq
  }
  return events
}

function getUniqueSeat(
  seats: readonly {
    readonly seatNumber: number
    readonly stack: number
    readonly streetContribution: number
    readonly totalContribution: number
  }[],
  seatNumber: number,
) {
  const matching = seats.filter((seat) => seat.seatNumber === seatNumber)
  return matching.length === 1 ? matching[0]! : fail()
}

function assertActionChain(
  actionEvents: readonly Extract<
    CompletedHandHistoryFacts['events'][number]['event'],
    { readonly type: 'actionCommitted' }
  >[],
  result: CompletedHandHistoryFacts['result'],
): void {
  const board = result.board
  for (const [index, event] of actionEvents.entries()) {
    const street = event.before.street
    if (!STREET_ORDER.includes(street as HistoryBettingStreet)) fail()
    const historyStreet = street as HistoryBettingStreet
    if (
      board.length < requiredBoardLength(historyStreet) ||
      !equalValues(event.before.board, boardForStreet(historyStreet, board)) ||
      event.before.board.length > event.after.board.length ||
      !equalValues(
        event.before.board,
        event.after.board.slice(0, event.before.board.length),
      ) ||
      !equalValues(
        event.progression.boardCardsAdded,
        event.after.board.slice(event.before.board.length),
      )
    ) {
      fail()
    }
    const previous = actionEvents[index - 1]
    if (
      previous !== undefined &&
      (!equalValues(previous.after.street, event.before.street) ||
        !equalValues(previous.after.board, event.before.board) ||
        previous.after.currentActorSeatNumber !==
          event.before.currentActorSeatNumber ||
        previous.after.pot !== event.before.pot ||
        !equalValues(previous.after.seats, event.before.seats))
    ) {
      fail()
    }
  }
  const finalAction = actionEvents.at(-1)
  if (
    finalAction === undefined ||
    !completedHandResultMirrorsTerminalAction(finalAction, result)
  ) {
    fail()
  }
}

function validateFacts(facts: CompletedHandHistoryFacts): void {
  const started = facts.checkpoint.startedHand
  const result = facts.result
  if (
    !isSafeNonnegativeInteger(facts.handNumber) ||
    facts.handNumber < 1 ||
    facts.handId !== started.handId ||
    facts.handId !== result.handId ||
    facts.handNumber !== started.handNumber ||
    !completedHandResultMirrorsCheckpoint(facts.checkpoint, result) ||
    !equalValues(result.summary, {
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
      participantHands: result.participantHands,
    })
  ) {
    fail()
  }
  if (![0, 3, 4, 5].includes(result.board.length)) fail()
}

function buildParticipants(facts: CompletedHandHistoryFacts) {
  const seats = [...facts.result.seats].sort(
    (left, right) => left.seatNumber - right.seatNumber,
  )
  const roster = [...facts.roster].sort(
    (left, right) => left.seatNumber - right.seatNumber,
  )
  const positions = [...facts.result.positions].sort(
    (left, right) => left.seatNumber - right.seatNumber,
  )
  const hands = [...facts.result.participantHands].sort(
    (left, right) => left.seatNumber - right.seatNumber,
  )
  if (
    seats.length !== facts.result.participantSeatNumbers.length ||
    roster.length !== seats.length ||
    positions.length !== seats.length ||
    hands.length !== seats.length ||
    !equalValues(
      seats.map((seat) => seat.seatNumber),
      facts.result.participantSeatNumbers,
    ) ||
    new Set(seats.map((seat) => seat.seatNumber)).size !== seats.length ||
    new Set(roster.map((entry) => entry.seatNumber)).size !== roster.length ||
    new Set(positions.map((entry) => entry.seatNumber)).size !==
      positions.length ||
    new Set(hands.map((entry) => entry.seatNumber)).size !== hands.length ||
    roster.filter((entry) => entry.isUser).length !== 1 ||
    roster.some((entry, index) => {
      const seat = seats[index]
      return (
        seat === undefined ||
        entry.seatNumber !== seat.seatNumber ||
        entry.playerId !== seat.playerId ||
        entry.isUser !== seat.isUser ||
        entry.isUser !== (entry.seatNumber === 0)
      )
    })
  ) {
    fail()
  }
  return seats.map((seat, index) => {
    const identity = roster[index]!
    const position = positions[index]
    if (position?.seatNumber !== seat.seatNumber) fail()
    const presentation = projectParticipantPresentation(identity)
    return {
      seatNumber: seat.seatNumber,
      playerId: seat.playerId,
      isUser: seat.isUser,
      displayName: presentation.displayName,
      avatarColor: presentation.avatarColor,
      position: position.position,
      startingStack: seat.startingStack,
      endingStack: seat.endingStack,
      totalContribution: seat.totalContribution,
      netChange: seat.netChange,
      startingHandCategory: seat.startingHandCategory,
    }
  })
}

function buildBettingPhases(
  facts: CompletedHandHistoryFacts,
  participants: ReturnType<typeof buildParticipants>,
  actionFacts: readonly {
    readonly eventSeq: number
    readonly event: Extract<
      CompletedHandHistoryFacts['events'][number]['event'],
      { readonly type: 'actionCommitted' }
    >
  }[],
): HistoryBettingStreetPhase[] {
  const participantBySeat = new Map(
    participants.map((participant) => [participant.seatNumber, participant]),
  )
  const actionsByStreet = new Map<HistoryBettingStreet, unknown[]>(
    STREET_ORDER.map((street) => [street, []]),
  )
  actionFacts.forEach((fact, index) => {
    const event = fact.event
    const street = event.before.street as HistoryBettingStreet
    if (!STREET_ORDER.includes(street)) fail()
    const participant = participantBySeat.get(event.actorSeatNumber)
    if (participant === undefined) fail()
    const beforeActor = getUniqueSeat(event.before.seats, event.actorSeatNumber)
    const afterActor = getUniqueSeat(event.after.seats, event.actorSeatNumber)
    const committedAmount = requireSafeDifference(
      afterActor.totalContribution,
      beforeActor.totalContribution,
    )
    const streetContributionAfterAction =
      beforeActor.streetContribution + committedAmount
    if (
      !isSafeNonnegativeInteger(streetContributionAfterAction) ||
      requireSafeDifference(beforeActor.stack, afterActor.stack) !==
        committedAmount ||
      requireSafeDifference(event.after.pot, event.before.pot) !==
        committedAmount ||
      ((event.command.action.type === 'fold' ||
        event.command.action.type === 'check') &&
        committedAmount !== 0)
    ) {
      fail()
    }
    const actions = actionsByStreet.get(street)
    if (actions === undefined) fail()
    actions.push({
      actionNumber: index + 1,
      eventSeq: fact.eventSeq,
      actorSeatNumber: event.actorSeatNumber,
      playerId: participant.playerId,
      position: participant.position,
      action: event.command.action,
      committedAmount,
      streetContributionAfterAction,
      stackAfterAction: afterActor.stack,
      potBeforeAction: event.before.pot,
      potAfterAction: event.after.pot,
    })
  })
  return STREET_ORDER.flatMap((street) => {
    if (facts.result.board.length < requiredBoardLength(street)) return []
    const actions = actionsByStreet.get(street)
    if (actions === undefined) fail()
    return [
      {
        phase: street,
        communityCards: boardForStreet(street, facts.result.board),
        actions,
      } as HistoryBettingStreetPhase,
    ]
  })
}

export function projectAuthoritativeCompletedHandHistory(
  facts: CompletedHandHistoryFacts,
): AuthoritativeCompletedHandHistory {
  try {
    validateFacts(facts)
    const sortedEvents = sortedHistoryEvents(facts)
    const historicalEvents = sortedEvents.filter(
      (fact) =>
        fact.event.type === 'actionCommitted' ||
        fact.event.type === 'uncalledBetReturned' ||
        fact.event.type === 'handCompleted',
    )
    const actionFacts = historicalEvents.filter(
      (
        fact,
      ): fact is typeof fact & {
        readonly event: Extract<
          typeof fact.event,
          { readonly type: 'actionCommitted' }
        >
      } => fact.event.type === 'actionCommitted',
    )
    const returnFacts = historicalEvents.filter(
      (
        fact,
      ): fact is typeof fact & {
        readonly event: Extract<
          typeof fact.event,
          { readonly type: 'uncalledBetReturned' }
        >
      } => fact.event.type === 'uncalledBetReturned',
    )
    const completionFacts = historicalEvents.filter(
      (
        fact,
      ): fact is typeof fact & {
        readonly event: Extract<
          typeof fact.event,
          { readonly type: 'handCompleted' }
        >
      } => fact.event.type === 'handCompleted',
    )
    const completion = completionFacts[0]
    if (
      actionFacts.length === 0 ||
      completionFacts.length !== 1 ||
      completion === undefined ||
      historicalEvents.at(-1) !== completion ||
      !equalValues(completion.event.summary, facts.result.summary) ||
      completion.event.terminationReason !== facts.result.terminationReason ||
      (facts.result.uncalledBetReturns.length === 0
        ? returnFacts.length !== 0
        : returnFacts.length !== 1 ||
          !equalValues(
            returnFacts[0]?.event.returns,
            facts.result.uncalledBetReturns,
          )) ||
      (returnFacts.length === 1 &&
        (historicalEvents.indexOf(returnFacts[0]!) <=
          historicalEvents.indexOf(actionFacts.at(-1)!) ||
          historicalEvents.indexOf(returnFacts[0]!) >=
            historicalEvents.indexOf(completion)))
    ) {
      fail()
    }
    assertActionChain(
      actionFacts.map((fact) => fact.event),
      facts.result,
    )
    const participants = buildParticipants(facts)
    const bettingPhases = buildBettingPhases(facts, participants, actionFacts)
    const terminal: HistoryShowdownPhase = {
      phase: 'showdown',
      terminationReason: facts.result.terminationReason,
      handCompletedEventSeq: completion.eventSeq,
      communityCards: [...facts.result.board],
      uncalledBetReturns: returnFacts.flatMap((fact) =>
        fact.event.returns.map((entry) => ({
          eventSeq: fact.eventSeq,
          seatNumber: entry.seatNumber,
          amount: entry.amount,
        })),
      ),
      privateHands: facts.result.participantHands.map((hand) => ({
        seatNumber: hand.seatNumber,
        holeCards: hand.holeCards,
        handEvaluation: hand.handEvaluation,
      })),
      pots: facts.result.pots.map((pot) => pot),
    }
    const history = AuthoritativeCompletedHandHistorySchema.parse({
      sessionId: facts.sessionId,
      handId: facts.handId,
      handNumber: facts.handNumber,
      pokerRuleSetVersion: facts.checkpoint.pokerRuleSetVersion,
      startedAt: facts.startedAt,
      completedAt: facts.completedAt,
      participantSeatNumbers: facts.result.participantSeatNumbers,
      buttonSeatNumber: facts.result.buttonSeatNumber,
      smallBlindSeatNumber: facts.result.smallBlindSeatNumber,
      bigBlindSeatNumber: facts.result.bigBlindSeatNumber,
      participants,
      phases: [...bettingPhases, terminal],
    })
    return deepFreeze(
      structuredClone(history),
    ) as unknown as AuthoritativeCompletedHandHistory
  } catch (error) {
    if (error instanceof CompletedHandHistoryInvariantError) throw error
    throw new CompletedHandHistoryInvariantError()
  }
}
