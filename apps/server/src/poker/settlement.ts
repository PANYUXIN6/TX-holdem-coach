import type { Card } from '@tx-holdem-coach/contracts'
import { projectContributionLayers } from './contribution-layers.js'
import { handEvaluator, type HandEvaluation } from './hand-evaluator.js'
import { projectShowdownAwards } from './showdown-awards.js'
import { createPokerTableState, type PokerTableState } from './state.js'

export type SettlementTerminationReason = 'showdown' | 'complete'

export interface SettlementSeatContext {
  readonly seatNumber: number
  readonly playerId: string
  readonly isUser: boolean
  readonly statusAtTermination: 'active' | 'folded' | 'allIn' | 'out'
  readonly startingStack: number
  readonly streetContribution: number
  readonly totalContribution: number
}

export interface SettlementParticipantContext {
  readonly seatNumber: number
  readonly holeCards: readonly [Card, Card]
}

export interface SettlementHandContext {
  readonly handId: string
  readonly terminationReason: SettlementTerminationReason
  readonly buttonSeatNumber: number
  readonly remainingDeck: readonly Card[]
  readonly burnedCards: readonly Card[]
  readonly board: readonly Card[]
  readonly pot: number
  readonly seats: readonly SettlementSeatContext[]
  readonly participants: readonly SettlementParticipantContext[]
}

export interface UncalledBetReturn {
  readonly seatNumber: number
  readonly amount: number
}

export interface PotAward {
  readonly seatNumber: number
  readonly baseAmount: number
  readonly oddChipAmount: 0 | 1
  readonly amount: number
}

export interface SettledPot {
  readonly potIndex: number
  readonly kind: 'main' | 'side'
  readonly amount: number
  readonly contributingSeatNumbers: readonly number[]
  readonly eligibleSeatNumbers: readonly number[]
  readonly winningSeatNumbers: readonly number[]
  readonly awards: readonly PotAward[]
}

export interface SettledHandEvaluation {
  readonly seatNumber: number
  readonly evaluation: HandEvaluation
}

export interface SettlementFacts {
  readonly hand: SettlementHandContext
  readonly uncalledBetReturns: readonly UncalledBetReturn[]
  readonly pots: readonly SettledPot[]
  readonly handEvaluations: readonly SettledHandEvaluation[]
}

export interface SettlementResult {
  readonly state: PokerTableState
  readonly facts: SettlementFacts
}

type Hand = NonNullable<PokerTableState['hand']>
type Seat = PokerTableState['seats'][number]

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const nestedValue of Object.values(value)) {
      deepFreeze(nestedValue)
    }

    Object.freeze(value)
  }

  return value
}

function participantSeatNumbers(hand: Hand): readonly number[] {
  return hand.holeCards.map((holeCards) => holeCards.seatNumber)
}

function isEligible(seat: Seat): boolean {
  return seat.status === 'active' || seat.status === 'allIn'
}

function assertTerminalState(state: PokerTableState): Hand {
  const hand = state.hand

  if (
    state.pokerPhase !== 'inHand' ||
    hand === null ||
    !['showdown', 'complete'].includes(hand.street) ||
    hand.currentActorSeatNumber !== null ||
    hand.bettingRound !== null
  ) {
    throw new RangeError('只有稳定的 showdown 或 complete 状态可以结算。')
  }

  const participants = participantSeatNumbers(hand)
  const participantSet = new Set(participants)
  const totalContributions = state.seats.reduce(
    (total, seat) => total + seat.totalContribution,
    0,
  )

  if (hand.pot !== totalContributions) {
    throw new RangeError('终止状态底池必须等于全部座位的本手总投入。')
  }

  const contenders = state.seats.filter(
    (seat) => participantSet.has(seat.seatNumber) && isEligible(seat),
  )

  if (
    hand.street === 'showdown' &&
    (hand.board.length !== 5 || contenders.length < 2)
  ) {
    throw new RangeError('showdown 必须有五张公共牌和至少两名竞争者。')
  }

  if (hand.street === 'complete' && contenders.length !== 1) {
    throw new RangeError('complete 必须恰有一名未弃牌竞争者。')
  }

  return hand
}

function createHandContext(
  state: PokerTableState,
  hand: Hand,
): SettlementHandContext {
  const participants = hand.holeCards
    .map((holeCards) => {
      const [firstCard, secondCard] = holeCards.cards
      if (
        firstCard === undefined ||
        secondCard === undefined ||
        holeCards.cards.length !== 2
      ) {
        throw new RangeError('每个参与座位必须恰有两张底牌。')
      }

      return {
        seatNumber: holeCards.seatNumber,
        holeCards: [firstCard, secondCard] as const,
      }
    })
    .sort((left, right) => left.seatNumber - right.seatNumber)

  return {
    handId: hand.handId,
    terminationReason:
      hand.street === 'showdown' || hand.street === 'complete'
        ? hand.street
        : (() => {
            throw new RangeError('结算手牌必须有终止原因。')
          })(),
    buttonSeatNumber: state.buttonSeatNumber,
    remainingDeck: hand.remainingDeck,
    burnedCards: hand.burnedCards,
    board: hand.board,
    pot: hand.pot,
    seats: state.seats
      .map((seat) => ({
        seatNumber: seat.seatNumber,
        playerId: seat.playerId,
        isUser: seat.isUser,
        statusAtTermination: seat.status,
        startingStack: seat.stack + seat.totalContribution,
        streetContribution: seat.streetContribution,
        totalContribution: seat.totalContribution,
      }))
      .sort((left, right) => left.seatNumber - right.seatNumber),
    participants,
  }
}

function determineEvaluations(
  hand: Hand,
  seats: readonly Seat[],
): ReadonlyMap<number, HandEvaluation> {
  if (hand.street === 'complete') {
    return new Map()
  }

  const holeCardsBySeatNumber = new Map(
    hand.holeCards.map((holeCards) => [holeCards.seatNumber, holeCards.cards]),
  )
  const evaluations = new Map<number, HandEvaluation>()

  for (const seat of seats) {
    if (!isEligible(seat) || seat.totalContribution === 0) {
      continue
    }

    const holeCards = holeCardsBySeatNumber.get(seat.seatNumber)
    if (holeCards === undefined || holeCards.length !== 2) {
      throw new RangeError('有资格参与摊牌的座位必须有两张底牌。')
    }

    evaluations.set(
      seat.seatNumber,
      handEvaluator.evaluate([...hand.board, ...holeCards]),
    )
  }

  return evaluations
}

export function settleTerminalHand(state: PokerTableState): SettlementResult {
  const hand = assertTerminalState(state)
  const handContext = createHandContext(state, hand)
  const participantSet = new Set(participantSeatNumbers(hand))
  const inputFunds =
    state.seats.reduce((total, seat) => total + seat.stack, 0) + hand.pot
  const mutableSeats = state.seats.map((seat) => ({ ...seat }))
  const participantSeats = mutableSeats.filter((seat) =>
    participantSet.has(seat.seatNumber),
  )
  const initialContributionProjection = projectContributionLayers({
    pot: hand.pot,
    seats: participantSeats,
  })
  const uncalledCandidate =
    initialContributionProjection.uncalledContributionCandidate
  const uncalledBetReturn =
    uncalledCandidate === null
      ? null
      : {
          seatNumber: uncalledCandidate.seatNumber,
          amount: uncalledCandidate.amount,
        }
  let remainingPot = hand.pot

  if (uncalledBetReturn !== null) {
    const seat = mutableSeats.find(
      (candidate) => candidate.seatNumber === uncalledBetReturn.seatNumber,
    )
    if (
      seat === undefined ||
      !isEligible(seat) ||
      uncalledBetReturn.amount > seat.streetContribution
    ) {
      throw new RangeError('终止状态包含无法合法返还的未跟注超额投入。')
    }

    seat.stack += uncalledBetReturn.amount
    seat.streetContribution -= uncalledBetReturn.amount
    seat.totalContribution -= uncalledBetReturn.amount
    remainingPot -= uncalledBetReturn.amount
  }

  const evaluations = determineEvaluations(hand, mutableSeats)
  const contributionProjection = projectContributionLayers({
    pot: remainingPot,
    seats: mutableSeats.filter((seat) => participantSet.has(seat.seatNumber)),
  })
  const pots = projectShowdownAwards({
    layers: contributionProjection.layers,
    evaluations,
    buttonSeatNumber: state.buttonSeatNumber,
  })
  for (const pot of pots) {
    for (const award of pot.awards) {
      const seat = mutableSeats.find(
        (candidate) => candidate.seatNumber === award.seatNumber,
      )
      if (seat === undefined) throw new RangeError('赢家座位不存在。')
      seat.stack += award.amount
    }
  }

  if (pots.reduce((total, pot) => total + pot.amount, 0) !== remainingPot) {
    throw new RangeError('返还后的规范池总额必须等于结算前剩余底池。')
  }

  const settledState = createPokerTableState({
    ...state,
    pokerPhase: 'betweenHands',
    hand: null,
    seats: mutableSeats.map((seat) => ({
      ...seat,
      status: seat.status === 'out' ? 'out' : seat.stack > 0 ? 'active' : 'out',
      streetContribution: 0,
      totalContribution: 0,
    })),
  })
  const outputFunds = settledState.seats.reduce(
    (total, seat) => total + seat.stack,
    0,
  )

  if (outputFunds !== inputFunds) {
    throw new RangeError('结算后筹码必须严格守恒。')
  }

  const facts: SettlementFacts = structuredClone({
    hand: handContext,
    uncalledBetReturns: uncalledBetReturn === null ? [] : [uncalledBetReturn],
    pots,
    handEvaluations: [...evaluations.entries()]
      .sort(([left], [right]) => left - right)
      .map(([seatNumber, evaluation]) => ({ seatNumber, evaluation })),
  })

  return deepFreeze({ state: settledState, facts })
}
