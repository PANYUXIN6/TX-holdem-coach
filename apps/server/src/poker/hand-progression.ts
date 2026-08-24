import { applyBettingAction } from './betting.js'
import {
  projectActionContinuation,
  type BettingProjectionState,
} from './betting-projection.js'
import type { PokerCommand } from './commands.js'
import {
  dealFlop,
  dealRiver,
  dealTurn,
  reconstructDealtHand,
  runoutRemainingBoard,
  type DealtHand,
} from './dealing.js'
import { createPokerTableState, type PokerTableState } from './state.js'

type Hand = NonNullable<PokerTableState['hand']>

function participantSeatNumbers(hand: Hand): readonly number[] {
  return hand.holeCards.map((holeCards) => holeCards.seatNumber)
}

function reconstructFromState(state: PokerTableState, hand: Hand): DealtHand {
  const holeCards = hand.holeCards.map((holeCards) => {
    const firstCard = holeCards.cards[0]
    const secondCard = holeCards.cards[1]

    if (
      firstCard === undefined ||
      secondCard === undefined ||
      holeCards.cards.length !== 2
    ) {
      throw new RangeError('每个参与座位必须恰有两张底牌。')
    }

    return {
      seatNumber: holeCards.seatNumber,
      cards: [firstCard, secondCard] as const,
    }
  })

  return reconstructDealtHand({
    buttonSeatNumber: state.buttonSeatNumber,
    holeCards,
    burnedCards: hand.burnedCards,
    board: hand.board,
    remainingDeck: hand.remainingDeck,
  })
}

function projectedCards(dealt: DealtHand) {
  return {
    remainingDeck: dealt.remainingDeck,
    burnedCards: dealt.burnedCards,
    board: dealt.board,
    holeCards: dealt.holeCards,
  }
}

function terminalHand(
  state: PokerTableState,
  hand: Hand,
  street: 'showdown' | 'complete',
  runout: boolean,
): Hand {
  const cards = runout
    ? projectedCards(runoutRemainingBoard(reconstructFromState(state, hand)))
    : {
        remainingDeck: hand.remainingDeck,
        burnedCards: hand.burnedCards,
        board: hand.board,
        holeCards: hand.holeCards,
      }

  return {
    ...hand,
    ...cards,
    street,
    currentActorSeatNumber: null,
    bettingRound: null,
  }
}

function advanceStreet(
  state: PokerTableState,
  hand: Hand,
  projection: BettingProjectionState,
): { readonly hand: Hand; readonly seats: PokerTableState['seats'] } {
  const dealt = reconstructFromState(state, hand)
  const next =
    hand.street === 'preflop'
      ? { street: 'flop' as const, dealt: dealFlop(dealt) }
      : hand.street === 'flop'
        ? { street: 'turn' as const, dealt: dealTurn(dealt) }
        : hand.street === 'turn'
          ? { street: 'river' as const, dealt: dealRiver(dealt) }
          : null

  if (next === null || next.street !== projection.street) {
    throw new RangeError('下注投影与发牌街道不一致。')
  }
  const projectedSeatByNumber = new Map(
    projection.seats.map((seat) => [seat.seatNumber, seat]),
  )
  const seats = state.seats.map((seat) => {
    const projected = projectedSeatByNumber.get(seat.seatNumber)
    if (projected === undefined) throw new RangeError('下注投影缺少座位。')
    return { ...seat, ...projected }
  })

  return {
    seats,
    hand: {
      ...hand,
      ...projectedCards(next.dealt),
      street: projection.street,
      currentActorSeatNumber: projection.currentActorSeatNumber,
      bettingRound: projection.bettingRound,
    },
  }
}

export function progressPokerAction(
  state: PokerTableState,
  command: PokerCommand,
): PokerTableState {
  const hand = state.hand

  if (
    state.pokerPhase !== 'inHand' ||
    hand === null ||
    hand.bettingRound === null ||
    hand.currentActorSeatNumber === null ||
    !['preflop', 'flop', 'turn', 'river'].includes(hand.street)
  ) {
    throw new RangeError('只有稳定下注街道才能执行扑克动作。')
  }

  const transition = applyBettingAction(state, command)
  const handAfterAction: Hand = {
    ...hand,
    pot: transition.pot,
    bettingRound: transition.bettingRound,
  }
  const projectionState: BettingProjectionState = {
    buttonSeatNumber: state.buttonSeatNumber,
    participantSeatNumbers: participantSeatNumbers(hand),
    street: hand.street as BettingProjectionState['street'],
    currentActorSeatNumber: transition.actorSeatNumber,
    pot: transition.pot,
    seats: transition.seats,
    bettingRound: transition.bettingRound,
  }
  const continuation = projectActionContinuation(
    projectionState,
    transition.actorSeatNumber,
  )
  let seats = transition.seats
  let nextHand: Hand
  if (continuation.kind === 'complete') {
    nextHand = terminalHand(state, handAfterAction, 'complete', false)
  } else if (continuation.kind === 'showdown') {
    nextHand = terminalHand(
      state,
      handAfterAction,
      'showdown',
      continuation.forcesRunout,
    )
  } else if (continuation.kind === 'sameStreet') {
    nextHand = {
      ...handAfterAction,
      currentActorSeatNumber: continuation.state.currentActorSeatNumber,
      bettingRound: continuation.state.bettingRound,
    }
  } else {
    const advanced = advanceStreet(state, handAfterAction, continuation.state)
    seats = advanced.seats
    nextHand = advanced.hand
  }

  return createPokerTableState({
    ...state,
    seats,
    hand: nextHand,
  })
}
