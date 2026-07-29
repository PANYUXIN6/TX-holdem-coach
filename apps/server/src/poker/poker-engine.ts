import { postBlinds } from './blind-posting.js'
import { dealPreflop, shuffleStandardDeck } from './dealing.js'
import {
  createActionCommittedEventDraft,
  createCompletedHandResult,
  createHandStartedEventDraft,
  createHandCompletedEventDraft,
  createStartedHandFacts,
  createUncalledBetReturnedEventDraft,
  type ActionProgressionFacts,
  type ActionStatisticsFacts,
  type ActionTableSnapshot,
  type CompletedHandResult,
  type PokerDomainEventDraft,
  type StartedHandFacts,
} from './hand-result.js'
import { getLegalActions } from './betting.js'
import { PokerCommandSchema, type PokerCommand } from './commands.js'
import { progressPokerAction } from './hand-progression.js'
import {
  assignLogicalPositions,
  findPreflopFirstActionableSeatNumber,
  getBlindSeatNumbers,
  resolveButtonSeatNumberForHand,
  selectInitialButtonSeatNumber,
} from './positioning.js'
import type { RandomSource } from './random-source.js'
import { settleTerminalHand } from './settlement.js'
import { createPokerTableState, type PokerTableState } from './state.js'
import { z } from 'zod'

export interface StartPokerHandResult {
  readonly state: PokerTableState
  readonly eventDrafts: readonly PokerDomainEventDraft[]
  readonly startedHand: StartedHandFacts
}

export interface PokerEngineResult {
  readonly state: PokerTableState
  readonly eventDrafts: readonly PokerDomainEventDraft[]
  readonly completedHand: CompletedHandResult | null
}

const STREET_ORDER = [
  'postingBlinds',
  'preflop',
  'flop',
  'turn',
  'river',
  'showdown',
  'complete',
] as const

function actionSnapshot(state: PokerTableState): ActionTableSnapshot {
  const hand = state.hand
  if (state.pokerPhase !== 'inHand' || hand === null) {
    throw new RangeError('动作快照必须来自进行中的手牌。')
  }
  return {
    street: hand.street,
    board: hand.board,
    currentActorSeatNumber: hand.currentActorSeatNumber,
    pot: hand.pot,
    seats: state.seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      status: seat.status,
      stack: seat.stack,
      streetContribution: seat.streetContribution,
      totalContribution: seat.totalContribution,
    })),
  }
}

function progressionFacts(
  before: PokerTableState,
  after: PokerTableState,
): ActionProgressionFacts {
  const beforeHand = before.hand
  const afterHand = after.hand
  if (beforeHand === null || afterHand === null) {
    throw new RangeError('动作推进必须保留结算前手牌事实。')
  }
  const start = STREET_ORDER.indexOf(beforeHand.street)
  const end = STREET_ORDER.indexOf(afterHand.street)
  if (start === -1 || end === -1 || end < start) {
    throw new RangeError('动作推进街道必须单向前进。')
  }
  return {
    streetTransitions:
      afterHand.street === 'complete'
        ? ['complete']
        : STREET_ORDER.slice(start + 1, end + 1),
    burnedCardsAdded: afterHand.burnedCards.slice(
      beforeHand.burnedCards.length,
    ),
    boardCardsAdded: afterHand.board.slice(beforeHand.board.length),
    terminationReason:
      afterHand.street === 'showdown' || afterHand.street === 'complete'
        ? afterHand.street
        : null,
  }
}

function actionStatistics(
  state: PokerTableState,
  command: PokerCommand,
  legalActionsBefore: ReturnType<typeof getLegalActions>,
): ActionStatisticsFacts {
  const hand = state.hand
  if (hand === null || hand.bettingRound === null) {
    throw new RangeError('动作统计必须来自稳定下注街道。')
  }
  if (hand.street !== 'preflop') {
    return {
      isVoluntaryPreflopContribution: false,
      isPreflopRaise: false,
      isVoluntaryPreflopFullRaise: false,
      canMakeFullRaiseBeforeAction: false,
    }
  }
  const allIn = legalActionsBefore.find((action) => action.type === 'allIn')
  const canMakeFullRaiseBeforeAction =
    legalActionsBefore.some(
      (action) => action.type === 'bet' || action.type === 'raise',
    ) ||
    (allIn !== undefined &&
      allIn.target - hand.bettingRound.currentBet >=
        hand.bettingRound.minimumFullRaiseIncrement)
  const target =
    command.action.type === 'bet' || command.action.type === 'raise'
      ? command.action.targetStreetCommitment
      : command.action.type === 'allIn'
        ? (allIn?.target ??
          (() => {
            throw new RangeError('全下命令必须有合法目标。')
          })())
        : hand.bettingRound.currentBet
  const raiseAmount = target - hand.bettingRound.currentBet
  const isPreflopRaise = raiseAmount > 0
  return {
    isVoluntaryPreflopContribution: ['call', 'bet', 'raise', 'allIn'].includes(
      command.action.type,
    ),
    isPreflopRaise,
    isVoluntaryPreflopFullRaise:
      isPreflopRaise &&
      raiseAmount >= hand.bettingRound.minimumFullRaiseIncrement,
    canMakeFullRaiseBeforeAction,
  }
}

function assertReadySeats(state: PokerTableState): void {
  if (state.pokerPhase !== 'betweenHands' || state.hand !== null) {
    throw new RangeError('只有两手之间才能开始新手牌。')
  }
  if (
    state.seats.length < 6 ||
    state.seats.length > 9 ||
    state.seats.some(
      (seat) =>
        seat.status !== 'active' ||
        seat.stack <= 0 ||
        seat.streetContribution !== 0 ||
        seat.totalContribution !== 0,
    )
  ) {
    throw new RangeError(
      '开手前必须恰有 6 到 9 个正筹码 active 座位且投入为零。',
    )
  }
}

export function initializePokerTable(
  seats: readonly PokerTableState['seats'][number][],
  randomSource: RandomSource,
): PokerTableState {
  const provisionalButtonSeatNumber = seats[0]?.seatNumber
  if (provisionalButtonSeatNumber === undefined) {
    throw new RangeError('初始化牌桌必须提供座位。')
  }
  const normalizedSeats = seats.map((seat) => ({
    ...seat,
    status: seat.stack > 0 ? 'active' : 'out',
    streetContribution: 0,
    totalContribution: 0,
  }))
  createPokerTableState({
    pokerPhase: 'betweenHands',
    seats: normalizedSeats,
    buttonSeatNumber: provisionalButtonSeatNumber,
    blinds: { smallBlind: 10, bigBlind: 20 },
    hand: null,
  })
  const buttonSeatNumber = selectInitialButtonSeatNumber(
    normalizedSeats.map((seat) => seat.seatNumber),
    randomSource,
  )
  return createPokerTableState({
    pokerPhase: 'betweenHands',
    seats: normalizedSeats,
    buttonSeatNumber,
    blinds: { smallBlind: 10, bigBlind: 20 },
    hand: null,
  })
}

export function startPokerHand(
  state: PokerTableState,
  input: {
    readonly handId: string
    readonly completedHandCountBeforeStart: number
    readonly randomSource: RandomSource
  },
): StartPokerHandResult {
  assertReadySeats(state)
  z.uuid().parse(input.handId)
  const participantSeatNumbers = state.seats.map((seat) => seat.seatNumber)
  const buttonSeatNumber = resolveButtonSeatNumberForHand({
    currentButtonSeatNumber: state.buttonSeatNumber,
    participantSeatNumbers,
    completedHandCountBeforeStart: input.completedHandCountBeforeStart,
  })
  const startingStacks = state.seats.map((seat) => ({
    seatNumber: seat.seatNumber,
    stack: seat.stack,
  }))
  const dealt = dealPreflop({
    shuffledDeck: shuffleStandardDeck(input.randomSource),
    buttonSeatNumber,
    participantSeatNumbers,
  })
  const blinds = postBlinds({
    seats: state.seats,
    buttonSeatNumber,
    participantSeatNumbers,
  })
  const currentActorSeatNumber = findPreflopFirstActionableSeatNumber({
    buttonSeatNumber,
    participantSeatNumbers,
    seats: blinds.seats,
  })
  if (currentActorSeatNumber === null) {
    throw new RangeError('开手后必须存在翻前首个行动者。')
  }
  const { smallBlindSeatNumber, bigBlindSeatNumber } = getBlindSeatNumbers(
    buttonSeatNumber,
    participantSeatNumbers,
  )
  const startedHand = createStartedHandFacts({
    handId: input.handId,
    handNumber: input.completedHandCountBeforeStart + 1,
    participantSeatNumbers,
    buttonSeatNumber,
    smallBlindSeatNumber,
    bigBlindSeatNumber,
    positions: assignLogicalPositions(buttonSeatNumber, participantSeatNumbers),
    startingStacks,
  })
  const nextState = createPokerTableState({
    ...state,
    pokerPhase: 'inHand',
    buttonSeatNumber,
    seats: blinds.seats,
    hand: {
      handId: input.handId,
      street: 'preflop',
      remainingDeck: dealt.remainingDeck,
      burnedCards: dealt.burnedCards,
      board: dealt.board,
      holeCards: dealt.holeCards,
      currentActorSeatNumber,
      pot: blinds.potDelta,
      bettingRound: {
        currentBet: blinds.preflopCurrentBet,
        minimumFullRaiseIncrement: blinds.minimumFullRaiseIncrement,
        seatStates: dealt.holeCards.map(({ seatNumber }) => ({
          seatNumber,
          betLevelAfterLastAction: null,
        })),
      },
    },
  })
  return Object.freeze({
    state: nextState,
    eventDrafts: Object.freeze([createHandStartedEventDraft(startedHand)]),
    startedHand,
  })
}

export function applyPokerAction(
  state: PokerTableState,
  command: PokerCommand,
): PokerEngineResult {
  const parsedCommand = PokerCommandSchema.parse(command)
  const legalActionsBefore = getLegalActions(state)
  const before = actionSnapshot(state)
  const statistics = actionStatistics(state, parsedCommand, legalActionsBefore)
  const progressedState = progressPokerAction(state, parsedCommand)
  const after = actionSnapshot(progressedState)
  const actionCommitted = createActionCommittedEventDraft({
    handId:
      state.hand?.handId ??
      (() => {
        throw new RangeError('动作必须属于进行中的手牌。')
      })(),
    actorSeatNumber: parsedCommand.actorSeatNumber,
    command: parsedCommand,
    legalActionsBefore,
    before,
    after,
    progression: progressionFacts(state, progressedState),
    statistics,
  })
  const terminationReason = progressedState.hand?.street
  if (terminationReason !== 'showdown' && terminationReason !== 'complete') {
    return Object.freeze({
      state: progressedState,
      eventDrafts: Object.freeze([actionCommitted]),
      completedHand: null,
    })
  }

  const settlement = settleTerminalHand(progressedState)
  const participantSeatNumbers = settlement.facts.hand.participants.map(
    (participant) => participant.seatNumber,
  )
  const { smallBlindSeatNumber, bigBlindSeatNumber } = getBlindSeatNumbers(
    settlement.facts.hand.buttonSeatNumber,
    participantSeatNumbers,
  )
  const completedHand = createCompletedHandResult({
    facts: settlement.facts,
    state: settlement.state,
    smallBlindSeatNumber,
    bigBlindSeatNumber,
    positions: assignLogicalPositions(
      settlement.facts.hand.buttonSeatNumber,
      participantSeatNumbers,
    ),
  })
  const eventDrafts: PokerDomainEventDraft[] = [actionCommitted]
  if (settlement.facts.uncalledBetReturns.length > 0) {
    eventDrafts.push(
      createUncalledBetReturnedEventDraft(
        completedHand.handId,
        settlement.facts.uncalledBetReturns,
      ),
    )
  }
  eventDrafts.push(createHandCompletedEventDraft(completedHand))
  return Object.freeze({
    state: settlement.state,
    eventDrafts: Object.freeze(eventDrafts),
    completedHand,
  })
}
