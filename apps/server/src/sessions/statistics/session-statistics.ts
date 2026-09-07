import type {
  SessionStatisticsTotals,
  StatisticsSubject,
} from '@tx-holdem-coach/contracts'
import type { PrivateTableState } from '../authoritative-state/private-table-state.js'
import type { CompletedHandHistoryRosterEntry } from '../hand-history/completed-hand-history.js'
import {
  type HistoricalStatisticsPersonaSnapshot,
  type HandStatisticsSelection,
} from './hand-statistics.js'
import { StatisticsInvariantError } from './errors.js'

export interface StatisticsSessionFact {
  readonly sessionId: string
  readonly lifecycleStatus: 'ended'
  readonly currentHandId: null
  readonly stateVersion: number
  readonly state: PrivateTableState
  readonly roster: readonly CompletedHandHistoryRosterEntry[]
  readonly aiParticipants: readonly HistoricalStatisticsPersonaSnapshot[]
}

export interface SessionStatisticsContribution {
  readonly finalChips: bigint
  readonly cumulativeBuyIn: bigint
  readonly sessionNetChange: bigint
}

interface SessionStatisticsCounters {
  sessionCount: bigint
  participantSessionCount: bigint
  finalChips: bigint
  cumulativeBuyIn: bigint
  sessionNetChange: bigint
}

const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER)
const MIN_SAFE_INTEGER = BigInt(Number.MIN_SAFE_INTEGER)

function invalid(): never {
  throw new StatisticsInvariantError()
}

function safeNumber(value: bigint): number {
  if (value < MIN_SAFE_INTEGER || value > MAX_SAFE_INTEGER) return invalid()
  return Number(value)
}

function matchesPersona(
  persona: HistoricalStatisticsPersonaSnapshot,
  selection: Omit<HandStatisticsSelection, 'position'>,
): boolean {
  return (
    (selection.personaId === null ||
      persona.personaId === selection.personaId) &&
    (selection.personaVersion === null ||
      persona.personaVersion === selection.personaVersion) &&
    (selection.personaName === null ||
      persona.displayName === selection.personaName) &&
    (selection.configSnapshotKey === null ||
      persona.configSnapshotKey === selection.configSnapshotKey)
  )
}

function validateFact(fact: StatisticsSessionFact): void {
  if (
    fact.lifecycleStatus !== 'ended' ||
    fact.currentHandId !== null ||
    !Number.isSafeInteger(fact.stateVersion) ||
    fact.stateVersion < 0 ||
    fact.state.stateVersion !== fact.stateVersion ||
    fact.state.poker.pokerPhase !== 'betweenHands' ||
    fact.state.poker.hand !== null
  ) {
    return invalid()
  }
  const stateSeats = new Map(
    fact.state.poker.seats.map((seat) => [seat.seatNumber, seat]),
  )
  const accounting = new Map(
    fact.state.seatAccounting.map((entry) => [entry.seatNumber, entry]),
  )
  if (
    stateSeats.size !== fact.state.poker.seats.length ||
    accounting.size !== fact.state.seatAccounting.length ||
    fact.roster.length !== stateSeats.size ||
    fact.roster.filter((entry) => entry.isUser).length !== 1
  ) {
    return invalid()
  }
  for (const entry of fact.roster) {
    const seat = stateSeats.get(entry.seatNumber)
    if (
      seat === undefined ||
      seat.playerId !== entry.playerId ||
      seat.isUser !== entry.isUser ||
      entry.isUser !== (entry.seatNumber === 0) ||
      !accounting.has(entry.seatNumber)
    ) {
      return invalid()
    }
  }
  const aiRosterSeats = new Set(
    fact.roster
      .filter((entry) => !entry.isUser)
      .map((entry) => entry.seatNumber),
  )
  if (
    fact.aiParticipants.length !== aiRosterSeats.size ||
    new Set(fact.aiParticipants.map((entry) => entry.seatNumber)).size !==
      fact.aiParticipants.length
  ) {
    return invalid()
  }
  for (const persona of fact.aiParticipants) {
    if (
      !aiRosterSeats.has(persona.seatNumber) ||
      persona.personaId.trim().length === 0 ||
      !Number.isSafeInteger(persona.personaVersion) ||
      persona.personaVersion <= 0 ||
      persona.displayName.trim().length === 0 ||
      !/^[a-f0-9]{64}$/.test(persona.configSnapshotKey)
    ) {
      return invalid()
    }
  }
}

function selectedSeatNumbers(
  fact: StatisticsSessionFact,
  selection: Omit<HandStatisticsSelection, 'position'>,
): readonly number[] {
  const matchingAi = fact.aiParticipants
    .filter((persona) => matchesPersona(persona, selection))
    .map((persona) => persona.seatNumber)
  const hasPersonaFilter =
    selection.personaId !== null ||
    selection.personaVersion !== null ||
    selection.personaName !== null ||
    selection.configSnapshotKey !== null
  if (selection.subject === 'user') {
    return hasPersonaFilter && matchingAi.length === 0 ? [] : [0]
  }
  return matchingAi
}

export function buildSessionStatisticsContributions(
  selection: Omit<HandStatisticsSelection, 'position'> & {
    readonly fact: StatisticsSessionFact
  },
): readonly SessionStatisticsContribution[] {
  try {
    validateFact(selection.fact)
    const seatByNumber = new Map(
      selection.fact.state.poker.seats.map((seat) => [seat.seatNumber, seat]),
    )
    const accountingBySeat = new Map(
      selection.fact.state.seatAccounting.map((entry) => [
        entry.seatNumber,
        entry,
      ]),
    )
    return selectedSeatNumbers(selection.fact, selection).map((seatNumber) => {
      const seat = seatByNumber.get(seatNumber)
      const accounting = accountingBySeat.get(seatNumber)
      if (seat === undefined || accounting === undefined) return invalid()
      const finalChips = BigInt(seat.stack)
      const cumulativeBuyIn = BigInt(accounting.cumulativeBuyIn)
      return {
        finalChips,
        cumulativeBuyIn,
        sessionNetChange: finalChips - cumulativeBuyIn,
      }
    })
  } catch (error) {
    if (error instanceof StatisticsInvariantError) throw error
    return invalid()
  }
}

export interface SessionStatisticsAccumulator {
  addSession(contributions: readonly SessionStatisticsContribution[]): void
  totals(): SessionStatisticsTotals
}

export function createSessionStatisticsAccumulator(): SessionStatisticsAccumulator {
  const counters: SessionStatisticsCounters = {
    sessionCount: 0n,
    participantSessionCount: 0n,
    finalChips: 0n,
    cumulativeBuyIn: 0n,
    sessionNetChange: 0n,
  }
  const accumulator: SessionStatisticsAccumulator = {
    addSession(contributions: readonly SessionStatisticsContribution[]) {
      if (contributions.length === 0) return
      counters.sessionCount += 1n
      for (const contribution of contributions) {
        counters.participantSessionCount += 1n
        counters.finalChips += contribution.finalChips
        counters.cumulativeBuyIn += contribution.cumulativeBuyIn
        counters.sessionNetChange += contribution.sessionNetChange
      }
    },
    totals() {
      return {
        sessionCount: safeNumber(counters.sessionCount),
        participantSessionCount: safeNumber(counters.participantSessionCount),
        finalChips: safeNumber(counters.finalChips),
        cumulativeBuyIn: safeNumber(counters.cumulativeBuyIn),
        sessionNetChange: safeNumber(counters.sessionNetChange),
      }
    },
  }
  return Object.freeze(accumulator)
}
