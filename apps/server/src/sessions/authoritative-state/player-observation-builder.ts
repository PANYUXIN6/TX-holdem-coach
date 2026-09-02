import { LegalActionsSchema, type Card } from '@tx-holdem-coach/contracts'
import { getLegalActions } from '../../poker/betting.js'
import {
  createCommittedActionProof,
  createInitialBettingProjection,
  projectActionContinuation,
  projectBettingTransition,
  type BettingProjectionState,
} from '../../poker/betting-projection.js'
import { PokerCommandSchema } from '../../poker/commands.js'
import { assignLogicalPositions } from '../../poker/positioning.js'
import type { PlayerDecisionIdentity } from './decision-identity.js'
import type { PrivateEvent } from './private-event.js'
import type { PrivateTableState } from './private-table-state.js'
import {
  PlayerObservationBoundaryError,
  type PlayerVisibleStateData,
} from './player-visible-state.js'

export interface PlayerObservationEvent {
  readonly handId: string
  readonly eventSeq: number
  readonly stateVersionBefore: number
  readonly stateVersionAfter: number
  readonly event: PrivateEvent
}

export interface PlayerObservationActor {
  readonly participantId: string
  readonly seatNumber: number
  readonly participantType: 'agent'
}

export interface BuildPlayerObservationInput {
  readonly state: PrivateTableState
  readonly events: readonly PlayerObservationEvent[]
  readonly identity: PlayerDecisionIdentity
  readonly actor: PlayerObservationActor
  readonly asOfEventSeq: number
}

declare const playerObservationDraftBrand: unique symbol

export type PlayerObservationDraft = PlayerVisibleStateData & {
  readonly [playerObservationDraftBrand]: never
}

const playerObservationDrafts = new WeakSet<object>()

function deepFreezeDraft<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreezeDraft(nested)
    Object.freeze(value)
  }
  return value
}

export function isPlayerObservationDraft(
  value: unknown,
): value is PlayerObservationDraft {
  return (
    typeof value === 'object' &&
    value !== null &&
    playerObservationDrafts.has(value)
  )
}

function reject(): never {
  throw new PlayerObservationBoundaryError()
}

function copyCard(card: Card): Card {
  return { rank: card.rank, suit: card.suit }
}

function isActionStreet(
  street: string,
): street is 'preflop' | 'flop' | 'turn' | 'river' {
  return (
    street === 'preflop' ||
    street === 'flop' ||
    street === 'turn' ||
    street === 'river'
  )
}

function sameCards(left: readonly Card[], right: readonly Card[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (card, index) =>
        card.rank === right[index]?.rank && card.suit === right[index]?.suit,
    )
  )
}

function startedPositionsAreAuthoritative(
  buttonSeatNumber: number,
  participantSeatNumbers: readonly number[],
  positions: readonly {
    readonly seatNumber: number
    readonly position: string
  }[],
): boolean {
  try {
    const expectedPositions = assignLogicalPositions(
      buttonSeatNumber,
      participantSeatNumbers,
    )
    const positionBySeat = new Map(
      positions.map((position) => [position.seatNumber, position.position]),
    )
    return (
      positions.length === expectedPositions.length &&
      expectedPositions.every(
        (expected) =>
          positionBySeat.get(expected.seatNumber) === expected.position,
      )
    )
  } catch {
    return false
  }
}

function snapshotMirrorsProjection(
  snapshot: Extract<PrivateEvent, { type: 'actionCommitted' }>['before'],
  projection: BettingProjectionState,
): boolean {
  return (
    snapshot.street === projection.street &&
    snapshot.currentActorSeatNumber === projection.currentActorSeatNumber &&
    snapshot.pot === projection.pot &&
    snapshot.seats.length === projection.seats.length &&
    snapshot.seats.every((seat, index) => {
      const expected = projection.seats[index]
      return (
        expected !== undefined &&
        seat.seatNumber === expected.seatNumber &&
        seat.status === expected.status &&
        seat.stack === expected.stack &&
        seat.streetContribution === expected.streetContribution &&
        seat.totalContribution === expected.totalContribution
      )
    })
  )
}

function currentStateMirrorsProjection(
  state: PrivateTableState,
  projection: BettingProjectionState,
): boolean {
  const hand = state.poker.hand
  return (
    hand !== null &&
    hand.bettingRound !== null &&
    hand.street === projection.street &&
    hand.currentActorSeatNumber === projection.currentActorSeatNumber &&
    hand.pot === projection.pot &&
    state.poker.seats.length === projection.seats.length &&
    state.poker.seats.every((seat, index) => {
      const expected = projection.seats[index]
      return (
        expected !== undefined &&
        seat.seatNumber === expected.seatNumber &&
        seat.status === expected.status &&
        seat.stack === expected.stack &&
        seat.streetContribution === expected.streetContribution &&
        seat.totalContribution === expected.totalContribution
      )
    }) &&
    hand.bettingRound.currentBet === projection.bettingRound.currentBet &&
    hand.bettingRound.minimumFullRaiseIncrement ===
      projection.bettingRound.minimumFullRaiseIncrement &&
    hand.bettingRound.seatStates.length ===
      projection.bettingRound.seatStates.length &&
    hand.bettingRound.seatStates.every((seatState) => {
      const expected = projection.bettingRound.seatStates.find(
        (candidate) => candidate.seatNumber === seatState.seatNumber,
      )
      return (
        expected !== undefined &&
        seatState.betLevelAfterLastAction === expected.betLevelAfterLastAction
      )
    })
  )
}

export function buildPlayerObservationDraft(
  input: BuildPlayerObservationInput,
): PlayerObservationDraft {
  const { state, identity, actor } = input
  const hand = state.poker.hand
  if (
    state.stateVersion !== identity.stateVersion ||
    state.poker.pokerPhase !== 'inHand' ||
    hand === null ||
    hand.handId !== identity.handId ||
    !isActionStreet(hand.street) ||
    hand.bettingRound === null ||
    hand.currentActorSeatNumber !== identity.actorSeat ||
    actor.participantType !== 'agent' ||
    actor.participantId !== identity.actorParticipantId ||
    actor.seatNumber !== identity.actorSeat ||
    !Number.isSafeInteger(input.asOfEventSeq) ||
    input.asOfEventSeq < 0
  ) {
    reject()
  }

  const actorSeat = state.poker.seats.find(
    (seat) => seat.seatNumber === identity.actorSeat,
  )
  const heroHoleCards = hand.holeCards.find(
    (entry) => entry.seatNumber === identity.actorSeat,
  )
  if (
    actorSeat === undefined ||
    actorSeat.playerId !== identity.actorParticipantId ||
    actorSeat.isUser ||
    actorSeat.status !== 'active' ||
    actorSeat.stack <= 0 ||
    heroHoleCards === undefined ||
    heroHoleCards.cards.length !== 2
  ) {
    reject()
  }

  const events = [...input.events].sort(
    (left, right) => left.eventSeq - right.eventSeq,
  )
  if (
    events.length === 0 ||
    events.some((row, index) => {
      const previous = index > 0 ? events[index - 1] : undefined
      return (
        row.handId !== identity.handId ||
        row.eventSeq > input.asOfEventSeq ||
        (previous !== undefined &&
          (row.eventSeq <= previous.eventSeq ||
            row.stateVersionBefore !== previous.stateVersionAfter)) ||
        row.stateVersionAfter !== row.stateVersionBefore + 1
      )
    }) ||
    events.at(-1)?.eventSeq !== input.asOfEventSeq ||
    events.at(-1)?.stateVersionAfter !== identity.stateVersion
  ) {
    reject()
  }

  const handStartedRows = events.filter(
    (row) => row.event.type === 'handStarted',
  )
  if (handStartedRows.length !== 1 || handStartedRows[0] !== events[0]) {
    reject()
  }
  const handStarted = handStartedRows[0]!.event
  if (
    handStarted.type !== 'handStarted' ||
    handStarted.startedHand.handId !== identity.handId ||
    handStarted.startedHand.handNumber !== state.completedHandCount + 1 ||
    handStarted.startedHand.buttonSeatNumber !== state.poker.buttonSeatNumber
  ) {
    reject()
  }

  const participantSeatNumbers = [
    ...handStarted.startedHand.participantSeatNumbers,
  ].sort((left, right) => left - right)
  const currentParticipantSeatNumbers = state.poker.seats
    .filter((seat) => seat.status !== 'out')
    .map((seat) => seat.seatNumber)
    .sort((left, right) => left - right)
  if (
    participantSeatNumbers.length !== currentParticipantSeatNumbers.length ||
    participantSeatNumbers.some(
      (seatNumber, index) =>
        seatNumber !== currentParticipantSeatNumbers[index],
    ) ||
    !startedPositionsAreAuthoritative(
      handStarted.startedHand.buttonSeatNumber,
      participantSeatNumbers,
      handStarted.startedHand.positions,
    )
  ) {
    reject()
  }

  const publicActions: PlayerVisibleStateData['hand']['publicActions'][number][] =
    []
  let replayState: BettingProjectionState
  let replayBoard: readonly Card[] = []
  try {
    replayState = createInitialBettingProjection({
      buttonSeatNumber: handStarted.startedHand.buttonSeatNumber,
      participantSeatNumbers,
      smallBlindSeatNumber: handStarted.startedHand.smallBlindSeatNumber,
      bigBlindSeatNumber: handStarted.startedHand.bigBlindSeatNumber,
      startingStacks: handStarted.startedHand.startingStacks,
      nonParticipantSeats: state.poker.seats
        .filter((seat) => seat.status === 'out')
        .map((seat) => ({
          seatNumber: seat.seatNumber,
          status: seat.status,
          stack: seat.stack,
          streetContribution: seat.streetContribution,
          totalContribution: seat.totalContribution,
        })),
    })
    for (const row of events.slice(1)) {
      if (
        row.event.type !== 'actionCommitted' ||
        row.event.handId !== identity.handId ||
        !isActionStreet(row.event.before.street) ||
        row.event.actorSeatNumber !== row.event.command.actorSeatNumber ||
        !snapshotMirrorsProjection(row.event.before, replayState) ||
        !sameCards(row.event.before.board, replayBoard)
      ) {
        reject()
      }
      const action = PokerCommandSchema.parse(row.event.command)
      const transition = projectBettingTransition(
        replayState,
        createCommittedActionProof(action, row.event.legalActionsBefore),
      )
      const continuation = projectActionContinuation(
        transition.state,
        transition.actorSeatNumber,
      )
      if (
        continuation.kind === 'complete' ||
        continuation.kind === 'showdown' ||
        !snapshotMirrorsProjection(row.event.after, continuation.state)
      ) {
        reject()
      }
      const expectedBoardSize = {
        preflop: 0,
        flop: 3,
        turn: 4,
        river: 5,
      }[continuation.state.street]
      if (
        row.event.after.board.length !== expectedBoardSize ||
        !row.event.after.board
          .slice(0, replayBoard.length)
          .every(
            (card, index) =>
              card.rank === replayBoard[index]?.rank &&
              card.suit === replayBoard[index]?.suit,
          ) ||
        (continuation.kind === 'sameStreet' &&
          !sameCards(row.event.after.board, replayBoard))
      ) {
        reject()
      }
      publicActions.push({
        eventSeq: row.eventSeq,
        stateVersionBefore: row.stateVersionBefore,
        stateVersionAfter: row.stateVersionAfter,
        streetBefore: row.event.before.street,
        actorSeatNumber: row.event.actorSeatNumber,
        action,
        amountToCallBefore: transition.amountToCallBefore,
        contributionDelta: transition.contributionDelta,
        targetStreetCommitmentAfter: transition.targetStreetCommitmentAfter,
        totalContributionAfter: transition.totalContributionAfter,
        potBefore: transition.potBefore,
        currentBetBefore: transition.currentBetBefore,
        currentBetAfter: transition.currentBetAfter,
        minimumFullRaiseIncrementBefore:
          transition.minimumFullRaiseIncrementBefore,
        minimumFullRaiseIncrementAfter:
          transition.minimumFullRaiseIncrementAfter,
        isVoluntaryPreflopContribution:
          transition.isVoluntaryPreflopContribution,
        isFullRaise: transition.isFullRaise,
      })
      replayState = continuation.state
      replayBoard = row.event.after.board.map(copyCard)
    }
  } catch (error) {
    if (error instanceof PlayerObservationBoundaryError) throw error
    reject()
  }
  if (
    !currentStateMirrorsProjection(state, replayState) ||
    !sameCards(hand.board, replayBoard)
  ) {
    reject()
  }

  let legalActions
  try {
    legalActions = LegalActionsSchema.parse(getLegalActions(state.poker))
  } catch {
    reject()
  }

  const draft = deepFreezeDraft({
    observationSchemaVersion: 1,
    identity: {
      sessionId: identity.sessionId,
      handId: identity.handId,
      stateVersion: identity.stateVersion,
      decisionRequestId: identity.decisionRequestId,
      actorParticipantId: identity.actorParticipantId,
      actorSeat: identity.actorSeat,
      asOfEventSeq: input.asOfEventSeq,
    },
    table: {
      buttonSeatNumber: state.poker.buttonSeatNumber,
      blinds: {
        smallBlind: state.poker.blinds.smallBlind,
        bigBlind: state.poker.blinds.bigBlind,
      },
      seats: [...state.poker.seats]
        .sort((left, right) => left.seatNumber - right.seatNumber)
        .map((seat) => ({
          seatNumber: seat.seatNumber,
          participantId: seat.playerId,
          isUser: seat.isUser,
          stack: seat.stack,
          status: seat.status,
          streetContribution: seat.streetContribution,
          totalContribution: seat.totalContribution,
        })),
    },
    hand: {
      handNumber: handStarted.startedHand.handNumber,
      street: hand.street,
      participantSeatNumbers,
      smallBlindSeatNumber: handStarted.startedHand.smallBlindSeatNumber,
      bigBlindSeatNumber: handStarted.startedHand.bigBlindSeatNumber,
      positions: [...handStarted.startedHand.positions]
        .sort((left, right) => left.seatNumber - right.seatNumber)
        .map((position) => ({
          seatNumber: position.seatNumber,
          position: position.position,
        })),
      startingStacks: [...handStarted.startedHand.startingStacks]
        .sort((left, right) => left.seatNumber - right.seatNumber)
        .map((stack) => ({ seatNumber: stack.seatNumber, stack: stack.stack })),
      heroHoleCards: [
        copyCard(heroHoleCards.cards[0]!),
        copyCard(heroHoleCards.cards[1]!),
      ],
      board: hand.board.map(copyCard),
      pot: hand.pot,
      currentActorSeatNumber: hand.currentActorSeatNumber,
      bettingRound: {
        currentBet: hand.bettingRound.currentBet,
        minimumFullRaiseIncrement: hand.bettingRound.minimumFullRaiseIncrement,
        seatStates: [...hand.bettingRound.seatStates]
          .sort((left, right) => left.seatNumber - right.seatNumber)
          .map((seatState) => ({
            seatNumber: seatState.seatNumber,
            betLevelAfterLastAction: seatState.betLevelAfterLastAction,
          })),
      },
      legalActions,
      publicActions,
    },
  } as unknown as PlayerObservationDraft)
  playerObservationDrafts.add(draft)
  return draft
}
