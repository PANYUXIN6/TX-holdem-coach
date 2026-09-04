import {
  PublicSessionSnapshotSchema,
  type PublicCompletedHandSummary,
  type PublicSessionSnapshot,
} from '@tx-holdem-coach/contracts'
import { getLegalActions } from '../../poker/betting.js'
import type { CompletedHandSummary } from '../../poker/hand-result.js'
import type { PrivateEvent } from '../authoritative-state/private-event.js'
import type {
  CommittedPrivateEventFact,
  PublicSessionProjectionFacts,
} from './public-projection-facts.js'
import { PublicProjectionInvariantError } from './errors.js'
import { projectParticipantPresentation } from '../participant-presentation.js'

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const nestedValue of Object.values(value)) deepFreeze(nestedValue)
    Object.freeze(value)
  }
  return value
}

function fail(): never {
  throw new PublicProjectionInvariantError()
}

function mapCompletedHandSummary(
  summary: CompletedHandSummary,
): PublicCompletedHandSummary {
  const handsBySeat = new Map(
    summary.participantHands.map((hand) => [hand.seatNumber, hand]),
  )
  return {
    handId: summary.handId,
    terminationReason: summary.terminationReason,
    participantSeatNumbers: [...summary.participantSeatNumbers],
    buttonSeatNumber: summary.buttonSeatNumber,
    smallBlindSeatNumber: summary.smallBlindSeatNumber,
    bigBlindSeatNumber: summary.bigBlindSeatNumber,
    positions: summary.positions.map(({ seatNumber, position }) => ({
      seatNumber,
      position,
    })),
    board: [...summary.board],
    seatResults: summary.seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      startingStack: seat.startingStack,
      endingStack: seat.endingStack,
      totalContribution: seat.totalContribution,
      netChange: seat.netChange,
    })),
    uncalledBetReturns: summary.uncalledBetReturns.map(
      ({ seatNumber, amount }) => ({ seatNumber, amount }),
    ),
    pots: summary.pots.map((pot) => ({
      potIndex: pot.potIndex,
      kind: pot.kind,
      amount: pot.amount,
      winningSeatNumbers: [...pot.winningSeatNumbers],
      awards: pot.awards.map(({ seatNumber, amount }) => ({
        seatNumber,
        amount,
      })),
    })),
    revealedHands: summary.participantSeatNumbers.map((seatNumber) => {
      const hand = handsBySeat.get(seatNumber)
      if (hand === undefined) fail()
      const visible =
        seatNumber === 0 ||
        (summary.terminationReason === 'showdown' &&
          hand.handEvaluation !== null)
      return {
        seatNumber,
        holeCards: visible ? [...hand.holeCards] : null,
        handEvaluation:
          visible && hand.handEvaluation !== null
            ? {
                category: hand.handEvaluation.category,
                bestFive: [...hand.handEvaluation.bestFive],
              }
            : null,
      }
    }),
  }
}

function mergeCurrentHandEvents(
  facts: PublicSessionProjectionFacts,
): readonly CommittedPrivateEventFact[] {
  const handId = facts.state.poker.hand?.handId
  if (handId === undefined) {
    if (facts.committedCurrentHandEvents.length !== 0) fail()
    return []
  }
  const firstNewEventSeq = facts.eventSeq - facts.newPrivateEvents.length + 1
  if (firstNewEventSeq < 0) fail()
  const committed = facts.committedCurrentHandEvents.map((fact) => ({
    ...fact,
  }))
  const appended = facts.newPrivateEvents
    .map((event, index) => ({
      eventSeq: firstNewEventSeq + index,
      handId:
        event.type === 'handStarted'
          ? event.startedHand.handId
          : 'handId' in event
            ? event.handId
            : '',
      event,
    }))
    .filter((fact) => fact.handId === handId)
  const merged = [...committed, ...appended]
  let previous = -1
  for (const fact of merged) {
    if (
      fact.handId !== handId ||
      fact.eventSeq <= previous ||
      fact.eventSeq > facts.eventSeq ||
      (facts.newPrivateEvents.length > 0 &&
        fact.eventSeq >= firstNewEventSeq &&
        committed.includes(fact))
    ) {
      fail()
    }
    previous = fact.eventSeq
  }
  return merged
}

export function projectPublicSessionSnapshot(
  facts: PublicSessionProjectionFacts,
): PublicSessionSnapshot {
  try {
    const { state, session } = facts
    if (
      state.stateVersion !== session.stateVersion ||
      facts.eventSeq !== session.nextEventSeq - 1 ||
      session.nextEventSeq <= 0 ||
      (state.poker.pokerPhase === 'inHand') !==
        (state.poker.hand !== null && session.currentHandId !== null) ||
      (state.poker.hand !== null &&
        state.poker.hand.handId !== session.currentHandId) ||
      (session.agentRunState === 'thinking') !==
        (session.activePlayerRunId !== null &&
          session.activeDecisionRequestId !== null)
    ) {
      fail()
    }
    const roster = [...facts.roster].sort(
      (left, right) => left.seatNumber - right.seatNumber,
    )
    const seats = [...state.poker.seats].sort(
      (left, right) => left.seatNumber - right.seatNumber,
    )
    if (
      roster.length !== seats.length ||
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
    const publicSeats = seats.map((seat, index) => {
      const identity = roster[index]!
      const presentation = projectParticipantPresentation(identity)
      return {
        seatNumber: seat.seatNumber,
        playerId: seat.playerId,
        displayName: presentation.displayName,
        avatarColor: presentation.avatarColor,
        isUser: seat.isUser,
        stack: seat.stack,
        status: seat.status,
      }
    })
    const mergedEvents = mergeCurrentHandEvents(facts)
    const hand =
      state.poker.hand === null
        ? null
        : {
            handId: state.poker.hand.handId,
            street: state.poker.hand.street,
            board: [...state.poker.hand.board],
            pot: state.poker.hand.pot,
            currentActorSeatNumber: state.poker.hand.currentActorSeatNumber,
            heroHoleCards:
              state.poker.hand.holeCards.find(
                (holeCards) => holeCards.seatNumber === 0,
              )?.cards ?? null,
            legalActions:
              session.lifecycleStatus === 'active' &&
              session.agentRunState === 'idle' &&
              state.poker.hand.currentActorSeatNumber === 0
                ? getLegalActions(state.poker)
                : [],
            actionTimeline: mergedEvents.flatMap((fact) => {
              const event: PrivateEvent = fact.event
              if (event.type !== 'actionCommitted') return []
              return [
                {
                  eventSeq: fact.eventSeq,
                  handId: event.handId,
                  streetBefore: event.before.street,
                  actorSeatNumber: event.actorSeatNumber,
                  action: event.command.action,
                  streetAfter: event.after.street,
                  boardAfter: [...event.after.board],
                  seatStatesAfter: [...event.after.seats]
                    .sort((left, right) => left.seatNumber - right.seatNumber)
                    .map((seat) => ({
                      seatNumber: seat.seatNumber,
                      status: seat.status,
                      stack: seat.stack,
                      streetContribution: seat.streetContribution,
                      totalContribution: seat.totalContribution,
                    })),
                  potAfter: event.after.pot,
                  currentActorSeatNumberAfter:
                    event.after.currentActorSeatNumber,
                },
              ]
            }),
          }
    const currentActor = publicSeats.find(
      (seat) => seat.seatNumber === hand?.currentActorSeatNumber,
    )
    const activeDecision =
      session.agentRunState === 'thinking' &&
      session.activeDecisionRequestId !== null &&
      currentActor !== undefined &&
      !currentActor.isUser
        ? {
            decisionRequestId: session.activeDecisionRequestId,
            actorSeatNumber: currentActor.seatNumber,
          }
        : null
    if (session.agentRunState === 'thinking' && activeDecision === null) fail()

    const snapshot = PublicSessionSnapshotSchema.parse({
      sessionId: session.sessionId,
      stateVersion: state.stateVersion,
      eventSeq: facts.eventSeq,
      pokerPhase: state.poker.pokerPhase,
      lifecycleStatus: session.lifecycleStatus,
      agentRunState: session.agentRunState,
      activeDecision,
      seats: publicSeats,
      hand,
      lastCompletedHandSummary:
        state.poker.pokerPhase === 'betweenHands' &&
        state.lastCompletedHandSummary !== null
          ? mapCompletedHandSummary(state.lastCompletedHandSummary)
          : null,
    })
    return deepFreeze(snapshot)
  } catch (error) {
    if (error instanceof PublicProjectionInvariantError) throw error
    throw new PublicProjectionInvariantError()
  }
}
