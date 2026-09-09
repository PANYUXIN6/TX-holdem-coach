import {
  SessionManagementItemSchema,
  type SessionManagementItem,
} from '@tx-holdem-coach/contracts'
import type { SessionManagementFact } from './session-management.js'
import { SessionManagementInvariantError } from './errors.js'

function invalid(): never {
  throw new SessionManagementInvariantError()
}

export function projectSessionManagementItem(
  fact: SessionManagementFact,
): SessionManagementItem {
  try {
    if (fact.lifecycle === 'readonlyDiagnostic') {
      return SessionManagementItemSchema.parse({
        sessionId: fact.sessionId,
        lifecycle: fact.lifecycle,
        createdAt: fact.createdAt,
        endedAt: fact.endedAt,
        completedHandCount: fact.completedHandCount,
        currentHandId: null,
        roster: fact.roster,
        accounting: {
          status: 'unavailable',
          reason: 'readonlyDiagnostic',
        },
      })
    }
    if (
      fact.state === null ||
      fact.initialStacks === null ||
      fact.state.stateVersion !== fact.stateVersion ||
      fact.state.completedHandCount !== fact.completedHandCount ||
      (fact.state.poker.hand?.handId ?? null) !== fact.currentHandId ||
      (fact.lifecycle === 'ended' &&
        (fact.currentHandId !== null ||
          fact.state.poker.pokerPhase !== 'betweenHands' ||
          fact.state.poker.hand !== null))
    ) {
      return invalid()
    }
    const stateSeats = new Map(
      fact.state.poker.seats.map((seat) => [seat.seatNumber, seat]),
    )
    const accounting = new Map(
      fact.state.seatAccounting.map((seat) => [seat.seatNumber, seat]),
    )
    const initialStacks = new Map(
      fact.initialStacks.map((seat) => [seat.seatNumber, seat]),
    )
    if (
      stateSeats.size !== fact.roster.length ||
      accounting.size !== fact.roster.length ||
      initialStacks.size !== fact.roster.length
    ) {
      return invalid()
    }
    const seats = fact.roster.map((roster) => {
      const stateSeat = stateSeats.get(roster.seatNumber)
      const account = accounting.get(roster.seatNumber)
      const initial = initialStacks.get(roster.seatNumber)
      if (
        stateSeat === undefined ||
        account === undefined ||
        initial === undefined ||
        initial.participantId !== roster.participantId ||
        stateSeat.playerId !== roster.participantId
      ) {
        return invalid()
      }
      const initialChips = initial.stack
      const net = BigInt(stateSeat.stack) - BigInt(account.cumulativeBuyIn)
      if (
        net < BigInt(Number.MIN_SAFE_INTEGER) ||
        net > BigInt(Number.MAX_SAFE_INTEGER)
      ) {
        return invalid()
      }
      return {
        participantId: roster.participantId,
        seatNumber: roster.seatNumber,
        initialChips,
        currentChips: stateSeat.stack,
        cumulativeBuyIn: account.cumulativeBuyIn,
        finalChips: fact.lifecycle === 'ended' ? stateSeat.stack : null,
        sessionNetChange: fact.lifecycle === 'ended' ? Number(net) : null,
      }
    })
    return SessionManagementItemSchema.parse({
      sessionId: fact.sessionId,
      lifecycle: fact.lifecycle,
      createdAt: fact.createdAt,
      endedAt: fact.endedAt,
      completedHandCount: fact.completedHandCount,
      currentHandId: fact.currentHandId,
      roster: fact.roster,
      accounting: {
        status: 'available',
        stateVersion: fact.stateVersion,
        seats,
      },
    })
  } catch (error) {
    if (error instanceof SessionManagementInvariantError) throw error
    return invalid()
  }
}
