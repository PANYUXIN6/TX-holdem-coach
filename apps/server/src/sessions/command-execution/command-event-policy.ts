import type { LedgerCommand } from '../../persistence/command-ledger-repository.js'
import type { CompletedHandResult } from '../../poker/hand-result.js'
import type { PrivateEventV2 } from '../authoritative-state/private-event-v2.js'
import type { PrivateTableState } from '../authoritative-state/private-table-state.js'
import { getPrivateEventHandId } from '../authoritative-state/private-event-v2.js'
import { parsePlayerActionRelationPlan } from './player-action-handler.js'

export function isEventSequenceAllowedForCommand(
  commandType: LedgerCommand['type'],
  events: readonly PrivateEventV2[],
): boolean {
  if (events.length === 0) return false
  switch (commandType) {
    case 'playerAction':
      return (
        (events.length === 1 && events[0]?.type === 'actionCommitted') ||
        (events.length === 2 &&
          events[0]?.type === 'actionCommitted' &&
          events[1]?.type === 'handCompleted') ||
        (events.length === 3 &&
          events[0]?.type === 'actionCommitted' &&
          events[1]?.type === 'uncalledBetReturned' &&
          events[2]?.type === 'handCompleted')
      )
    case 'aiAction':
    case 'startNextHand':
    case 'retryAgent':
      return false
    case 'rebuy':
      return events.length === 1 && events[0]?.type === 'userRebuy'
    case 'endSession':
      return (
        events.length === 1 &&
        events[0]?.type === 'sessionEnded' &&
        events[0].reason === 'userRequested'
      )
  }
}

export interface CommandMutationConsistencyInput {
  readonly command: LedgerCommand
  readonly stateEffectKind: 'stateChanged' | 'stateUnchanged'
  readonly stateBefore: PrivateTableState
  readonly stateAfter: PrivateTableState
  readonly lifecycleAfter: 'active' | 'ended'
  readonly currentHandIdAfter: string | null
  readonly playerCoordinationAfter: {
    readonly agentRunState: 'idle' | 'thinking' | 'paused'
    readonly activePlayerRunId: string | null
    readonly activeDecisionRequestId: string | null
  }
  readonly events: readonly PrivateEventV2[]
  readonly relationPlan: unknown
}

function equalValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function stateContentEquals(
  left: PrivateTableState,
  right: PrivateTableState,
): boolean {
  return (
    equalValue(left.poker, right.poker) &&
    left.completedHandCount === right.completedHandCount &&
    equalValue(left.seatAccounting, right.seatAccounting) &&
    equalValue(left.lastCompletedHandSummary, right.lastCompletedHandSummary)
  )
}

function haveSameSeatNumberSet(
  reference: readonly { readonly seatNumber: number }[],
  ...others: readonly (readonly { readonly seatNumber: number }[])[]
): boolean {
  const referenceSeatNumbers = new Set(reference.map((seat) => seat.seatNumber))
  return others.every(
    (seats) =>
      seats.length === reference.length &&
      new Set(seats.map((seat) => seat.seatNumber)).size ===
        referenceSeatNumbers.size &&
      seats.every((seat) => referenceSeatNumbers.has(seat.seatNumber)),
  )
}

function rebuyMirrors(input: CommandMutationConsistencyInput): boolean {
  const event = input.events[0]
  if (
    input.stateEffectKind !== 'stateChanged' ||
    input.lifecycleAfter !== 'active' ||
    input.currentHandIdAfter !== null ||
    input.stateBefore.poker.pokerPhase !== 'betweenHands' ||
    input.stateAfter.poker.pokerPhase !== 'betweenHands' ||
    event?.type !== 'userRebuy' ||
    input.command.type !== 'rebuy' ||
    event.amount !== input.command.payload.amount ||
    input.stateBefore.completedHandCount !==
      input.stateAfter.completedHandCount ||
    !equalValue(
      input.stateBefore.lastCompletedHandSummary,
      input.stateAfter.lastCompletedHandSummary,
    ) ||
    input.stateBefore.poker.buttonSeatNumber !==
      input.stateAfter.poker.buttonSeatNumber ||
    !equalValue(input.stateBefore.poker.blinds, input.stateAfter.poker.blinds)
  ) {
    return false
  }
  const beforeAccountingBySeat = new Map(
    input.stateBefore.seatAccounting.map((seat) => [
      seat.seatNumber,
      seat.cumulativeBuyIn,
    ]),
  )
  const afterAccountingBySeat = new Map(
    input.stateAfter.seatAccounting.map((seat) => [
      seat.seatNumber,
      seat.cumulativeBuyIn,
    ]),
  )
  if (
    !haveSameSeatNumberSet(
      input.stateBefore.poker.seats,
      input.stateAfter.poker.seats,
      input.stateBefore.seatAccounting,
      input.stateAfter.seatAccounting,
    ) ||
    beforeAccountingBySeat.get(0) !== event.cumulativeBuyInBefore ||
    afterAccountingBySeat.get(0) !== event.cumulativeBuyInAfter
  ) {
    return false
  }
  const afterSeatByNumber = new Map(
    input.stateAfter.poker.seats.map((seat) => [seat.seatNumber, seat]),
  )
  return input.stateBefore.poker.seats.every((beforeSeat) => {
    const afterSeat = afterSeatByNumber.get(beforeSeat.seatNumber)
    if (afterSeat === undefined) return false
    if (beforeSeat.seatNumber === 0) {
      return (
        beforeSeat.stack === event.stackBefore &&
        afterSeat.stack === event.stackAfter &&
        afterSeat.status === 'active' &&
        equalValue(
          { ...beforeSeat, stack: event.stackAfter, status: 'active' },
          afterSeat,
        )
      )
    }
    return (
      equalValue(beforeSeat, afterSeat) &&
      beforeAccountingBySeat.get(beforeSeat.seatNumber) ===
        afterAccountingBySeat.get(beforeSeat.seatNumber)
    )
  })
}

function endSessionMirrors(input: CommandMutationConsistencyInput): boolean {
  if (input.lifecycleAfter !== 'ended' || input.currentHandIdAfter !== null) {
    return false
  }
  if (input.events.length === 1) {
    const event = input.events[0]
    return (
      event?.type === 'sessionEnded' &&
      event.reason === 'userRequested' &&
      input.stateEffectKind === 'stateUnchanged' &&
      input.stateBefore.poker.pokerPhase === 'betweenHands' &&
      stateContentEquals(input.stateBefore, input.stateAfter)
    )
  }
  return false
}

function actionSnapshotMirrors(
  snapshot: Extract<PrivateEventV2, { type: 'actionCommitted' }>['before'],
  state: PrivateTableState['poker'],
): boolean {
  const hand = state.hand
  return (
    hand !== null &&
    snapshot.street === hand.street &&
    equalValue(snapshot.board, hand.board) &&
    snapshot.currentActorSeatNumber === hand.currentActorSeatNumber &&
    snapshot.pot === hand.pot &&
    equalValue(
      snapshot.seats,
      state.seats.map((seat) => ({
        seatNumber: seat.seatNumber,
        status: seat.status,
        stack: seat.stack,
        streetContribution: seat.streetContribution,
        totalContribution: seat.totalContribution,
      })),
    )
  )
}

function rosterAndTableMirrors(
  before: PrivateTableState,
  after: PrivateTableState,
): boolean {
  return (
    before.poker.buttonSeatNumber === after.poker.buttonSeatNumber &&
    equalValue(before.poker.blinds, after.poker.blinds) &&
    haveSameSeatNumberSet(
      before.poker.seats,
      after.poker.seats,
      before.seatAccounting,
      after.seatAccounting,
    ) &&
    before.poker.seats.every((beforeSeat) => {
      const afterSeat = after.poker.seats.find(
        (seat) => seat.seatNumber === beforeSeat.seatNumber,
      )
      return (
        afterSeat !== undefined &&
        afterSeat.playerId === beforeSeat.playerId &&
        afterSeat.isUser === beforeSeat.isUser
      )
    }) &&
    equalValue(before.seatAccounting, after.seatAccounting)
  )
}

function terminalActionSnapshotMirrors(
  event: Extract<PrivateEventV2, { type: 'actionCommitted' }>,
  result: CompletedHandResult,
): boolean {
  const beforeBySeat = new Map(
    event.before.seats.map((seat) => [seat.seatNumber, seat]),
  )
  const resultBySeat = new Map(
    result.seats.map((seat) => [seat.seatNumber, seat]),
  )
  const expectedActorStatus =
    event.command.action.type === 'fold'
      ? 'folded'
      : event.command.action.type === 'allIn'
        ? 'allIn'
        : 'active'
  return (
    event.after.street === result.terminationReason &&
    event.after.currentActorSeatNumber === null &&
    equalValue(event.after.board, result.board) &&
    event.after.pot ===
      result.seats.reduce((total, seat) => total + seat.totalContribution, 0) &&
    event.after.seats.length === result.seats.length &&
    event.after.seats.every((afterSeat) => {
      const beforeSeat = beforeBySeat.get(afterSeat.seatNumber)
      const resultSeat = resultBySeat.get(afterSeat.seatNumber)
      if (beforeSeat === undefined || resultSeat === undefined) return false
      const contributionDelta =
        resultSeat.totalContribution - beforeSeat.totalContribution
      return (
        contributionDelta >= 0 &&
        afterSeat.totalContribution === resultSeat.totalContribution &&
        afterSeat.streetContribution ===
          beforeSeat.streetContribution + contributionDelta &&
        afterSeat.stack === beforeSeat.stack - contributionDelta &&
        afterSeat.status ===
          (afterSeat.seatNumber === event.actorSeatNumber
            ? expectedActorStatus
            : beforeSeat.status)
      )
    })
  )
}

function playerActionMirrors(input: CommandMutationConsistencyInput): boolean {
  const beforeHand = input.stateBefore.poker.hand
  const actionEvent = input.events[0]
  const relationPlan = parsePlayerActionRelationPlan(input.relationPlan)
  if (
    input.command.type !== 'playerAction' ||
    input.stateEffectKind !== 'stateChanged' ||
    input.lifecycleAfter !== 'active' ||
    input.stateBefore.poker.pokerPhase !== 'inHand' ||
    beforeHand === null ||
    actionEvent?.type !== 'actionCommitted' ||
    relationPlan === null ||
    beforeHand.currentActorSeatNumber !== 0 ||
    actionEvent.actorSeatNumber !== beforeHand.currentActorSeatNumber ||
    actionEvent.handId.toLowerCase() !== beforeHand.handId.toLowerCase() ||
    !equalValue(actionEvent.command, {
      actorSeatNumber: 0,
      action: input.command.payload.action,
    }) ||
    input.playerCoordinationAfter.agentRunState !== 'idle' ||
    input.playerCoordinationAfter.activePlayerRunId !== null ||
    input.playerCoordinationAfter.activeDecisionRequestId !== null ||
    !actionSnapshotMirrors(actionEvent.before, input.stateBefore.poker) ||
    !rosterAndTableMirrors(input.stateBefore, input.stateAfter) ||
    input.events.some(
      (event) =>
        getPrivateEventHandId(event)?.toLowerCase() !==
        beforeHand.handId.toLowerCase(),
    )
  ) {
    return false
  }

  if (input.events.length === 1) {
    const afterHand = input.stateAfter.poker.hand
    return (
      relationPlan.kind === 'continueHand' &&
      relationPlan.handId.toLowerCase() === beforeHand.handId.toLowerCase() &&
      input.stateAfter.poker.pokerPhase === 'inHand' &&
      afterHand !== null &&
      afterHand.handId.toLowerCase() === beforeHand.handId.toLowerCase() &&
      input.currentHandIdAfter?.toLowerCase() ===
        beforeHand.handId.toLowerCase() &&
      input.stateAfter.completedHandCount ===
        input.stateBefore.completedHandCount &&
      equalValue(
        input.stateAfter.lastCompletedHandSummary,
        input.stateBefore.lastCompletedHandSummary,
      ) &&
      actionSnapshotMirrors(actionEvent.after, input.stateAfter.poker)
    )
  }

  const completionEvent = input.events.at(-1)
  const possibleReturnEvent = input.events[1]
  const returnEvent =
    possibleReturnEvent?.type === 'uncalledBetReturned'
      ? possibleReturnEvent
      : null
  if (
    relationPlan.kind !== 'completeHand' ||
    completionEvent?.type !== 'handCompleted' ||
    (input.events.length === 3 && returnEvent === null) ||
    input.stateAfter.poker.pokerPhase !== 'betweenHands' ||
    input.stateAfter.poker.hand !== null ||
    input.currentHandIdAfter !== null ||
    relationPlan.sessionId.toLowerCase() !==
      input.command.sessionId.toLowerCase() ||
    relationPlan.handId.toLowerCase() !== beforeHand.handId.toLowerCase() ||
    relationPlan.result.handId.toLowerCase() !==
      beforeHand.handId.toLowerCase() ||
    input.stateAfter.completedHandCount !==
      input.stateBefore.completedHandCount + 1 ||
    !Number.isSafeInteger(input.stateAfter.completedHandCount) ||
    !terminalActionSnapshotMirrors(actionEvent, relationPlan.result) ||
    actionEvent.progression.terminationReason !==
      relationPlan.result.terminationReason ||
    completionEvent.terminationReason !==
      relationPlan.result.terminationReason ||
    !equalValue(completionEvent.summary, relationPlan.result.summary) ||
    !equalValue(
      input.stateAfter.lastCompletedHandSummary,
      relationPlan.result.summary,
    ) ||
    !equalValue(
      returnEvent?.returns ?? [],
      relationPlan.result.uncalledBetReturns,
    )
  ) {
    return false
  }

  return relationPlan.result.seats.every((resultSeat) => {
    const finalSeat = input.stateAfter.poker.seats.find(
      (seat) => seat.seatNumber === resultSeat.seatNumber,
    )
    return (
      finalSeat !== undefined &&
      finalSeat.playerId === resultSeat.playerId &&
      finalSeat.isUser === resultSeat.isUser &&
      finalSeat.stack === resultSeat.endingStack &&
      finalSeat.streetContribution === 0 &&
      finalSeat.totalContribution === 0
    )
  })
}

export function isCommandMutationConsistent(
  input: CommandMutationConsistencyInput,
): boolean {
  if (!isEventSequenceAllowedForCommand(input.command.type, input.events)) {
    return false
  }
  switch (input.command.type) {
    case 'startNextHand':
      return false
    case 'rebuy':
      return rebuyMirrors(input)
    case 'endSession':
      return endSessionMirrors(input)
    case 'playerAction':
      return playerActionMirrors(input)
    case 'aiAction':
      return false
    case 'retryAgent':
      return false
  }
}
