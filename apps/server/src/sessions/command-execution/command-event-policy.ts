import type { LedgerCommand } from '../../persistence/command-ledger-repository.js'
import type { PrivateEventV2 } from '../authoritative-state/private-event-v2.js'
import type { PrivateTableState } from '../authoritative-state/private-table-state.js'

export function isEventSequenceAllowedForCommand(
  commandType: LedgerCommand['type'],
  events: readonly PrivateEventV2[],
): boolean {
  if (events.length === 0) return false
  switch (commandType) {
    case 'playerAction':
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
    case 'aiAction':
      return false
    case 'retryAgent':
      return false
  }
}
