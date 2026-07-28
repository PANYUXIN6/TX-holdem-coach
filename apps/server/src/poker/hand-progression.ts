import { applyBettingAction } from './betting.js'
import type { PokerCommand } from './commands.js'
import {
  dealFlop,
  dealRiver,
  dealTurn,
  reconstructDealtHand,
  runoutRemainingBoard,
  type DealtHand,
} from './dealing.js'
import {
  clockwiseParticipantSeatNumbersAfter,
  findPostflopFirstActionableSeatNumber,
} from './positioning.js'
import { createPokerTableState, type PokerTableState } from './state.js'

type Hand = NonNullable<PokerTableState['hand']>
type BettingRound = NonNullable<Hand['bettingRound']>

function participantSeatNumbers(hand: Hand): readonly number[] {
  return hand.holeCards.map((holeCards) => holeCards.seatNumber)
}

function participantSeats(
  hand: Hand,
  seats: PokerTableState['seats'],
): PokerTableState['seats'] {
  const participants = new Set(participantSeatNumbers(hand))
  return seats.filter((seat) => participants.has(seat.seatNumber))
}

function contenderSeats(
  hand: Hand,
  seats: PokerTableState['seats'],
): PokerTableState['seats'] {
  return participantSeats(hand, seats).filter(
    (seat) => seat.status === 'active' || seat.status === 'allIn',
  )
}

function actionableSeats(
  hand: Hand,
  seats: PokerTableState['seats'],
): PokerTableState['seats'] {
  return contenderSeats(hand, seats).filter(
    (seat) => seat.status === 'active' && seat.stack > 0,
  )
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
  seats: PokerTableState['seats'],
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

  if (next === null) {
    return {
      hand: terminalHand(state, hand, 'showdown', false),
      seats,
    }
  }

  const resetSeats = seats.map((seat) => ({
    ...seat,
    streetContribution: 0,
  }))
  const participantNumbers = participantSeatNumbers(hand)
  const nextActorSeatNumber = findPostflopFirstActionableSeatNumber({
    buttonSeatNumber: state.buttonSeatNumber,
    participantSeatNumbers: participantNumbers,
    seats: participantSeats(hand, resetSeats),
  })

  if (nextActorSeatNumber === null) {
    throw new RangeError('新街必须存在可行动玩家。')
  }

  return {
    seats: resetSeats,
    hand: {
      ...hand,
      ...projectedCards(next.dealt),
      street: next.street,
      currentActorSeatNumber: nextActorSeatNumber,
      bettingRound: {
        currentBet: 0,
        minimumFullRaiseIncrement: 20,
        seatStates: participantNumbers.map((seatNumber) => ({
          seatNumber,
          betLevelAfterLastAction: null,
        })),
      },
    },
  }
}

function stillOwesAction(
  seatNumber: number,
  seats: PokerTableState['seats'],
  bettingRound: BettingRound,
): boolean {
  const seat = seats.find((candidate) => candidate.seatNumber === seatNumber)
  const roundState = bettingRound.seatStates.find(
    (candidate) => candidate.seatNumber === seatNumber,
  )

  return (
    seat?.status === 'active' &&
    seat.stack > 0 &&
    (roundState?.betLevelAfterLastAction === null ||
      seat.streetContribution < bettingRound.currentBet)
  )
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
  const contenders = contenderSeats(handAfterAction, transition.seats)

  if (contenders.length === 0) {
    throw new RangeError('手牌不得没有竞争者。')
  }

  let seats = transition.seats
  let nextHand: Hand

  if (contenders.length === 1) {
    nextHand = terminalHand(state, handAfterAction, 'complete', false)
  } else {
    const actionable = actionableSeats(handAfterAction, transition.seats)

    if (actionable.length === 0) {
      nextHand = terminalHand(
        state,
        handAfterAction,
        'showdown',
        handAfterAction.board.length < 5,
      )
    } else if (actionable.length === 1) {
      const actor = actionable[0] as (typeof actionable)[number]
      const matchableLevel = Math.max(
        ...contenders
          .filter((seat) => seat.seatNumber !== actor.seatNumber)
          .map((seat) => seat.streetContribution),
      )
      const pendingCall = Math.max(0, matchableLevel - actor.streetContribution)

      nextHand =
        pendingCall > 0
          ? { ...handAfterAction, currentActorSeatNumber: actor.seatNumber }
          : terminalHand(
              state,
              handAfterAction,
              'showdown',
              handAfterAction.board.length < 5,
            )
    } else {
      const clockwiseSeatNumbers = clockwiseParticipantSeatNumbersAfter(
        transition.actorSeatNumber,
        participantSeatNumbers(handAfterAction),
      )
      const nextActorSeatNumber = clockwiseSeatNumbers.find((seatNumber) =>
        stillOwesAction(seatNumber, transition.seats, transition.bettingRound),
      )

      if (nextActorSeatNumber !== undefined) {
        nextHand = {
          ...handAfterAction,
          currentActorSeatNumber: nextActorSeatNumber,
        }
      } else {
        const advanced = advanceStreet(state, handAfterAction, transition.seats)
        seats = advanced.seats
        nextHand = advanced.hand
      }
    }
  }

  return createPokerTableState({
    ...state,
    seats,
    hand: nextHand,
  })
}
