import type {
  HandStatisticsMetrics,
  StatisticsRate,
  StatisticsSubject,
} from '@tx-holdem-coach/contracts'
import type { ActionStatisticsFacts } from '../../poker/hand-result.js'
import type { LogicalPosition } from '../../poker/positioning.js'
import type { CompletedHandHistoryFacts } from '../hand-history/completed-hand-history.js'
import { projectAuthoritativeCompletedHandHistory } from '../hand-history/completed-hand-history-projector.js'
import { StatisticsInvariantError } from './errors.js'

export interface HistoricalStatisticsPersonaSnapshot {
  readonly seatNumber: number
  readonly personaId: string
  readonly personaVersion: number
  readonly displayName: string
  readonly configSnapshotKey: string
}

export interface StatisticsHandFact {
  readonly history: CompletedHandHistoryFacts
  readonly aiParticipants: readonly HistoricalStatisticsPersonaSnapshot[]
}

export interface HandStatisticsSelection {
  readonly subject: StatisticsSubject
  readonly position: LogicalPosition | null
  readonly personaId: string | null
  readonly personaVersion: number | null
  readonly personaName: string | null
  readonly configSnapshotKey: string | null
}

export interface HandStatisticsContribution {
  readonly position: LogicalPosition
  readonly handNetChange: bigint
  readonly vpip: boolean
  readonly pfr: boolean
  readonly threeBet: {
    readonly numerator: bigint
    readonly denominator: bigint
  }
  readonly sawFlop: boolean
  readonly showdown: boolean
  readonly wonShowdown: boolean
}

interface ThreeBetAction {
  readonly eventSeq: number
  readonly actorSeatNumber: number
  readonly street: string
  readonly statistics: ActionStatisticsFacts
}

interface HandStatisticsCounters {
  handCount: bigint
  distinctHandCount: bigint
  handNetChange: bigint
  vpipNumerator: bigint
  pfrNumerator: bigint
  threeBetNumerator: bigint
  threeBetDenominator: bigint
  showdownCount: bigint
  wtsdDenominator: bigint
  wsdNumerator: bigint
}

const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER)
const MIN_SAFE_INTEGER = BigInt(Number.MIN_SAFE_INTEGER)

function invalid(): never {
  throw new StatisticsInvariantError()
}

function isSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value)
}

function safeNumber(value: bigint): number {
  if (value < MIN_SAFE_INTEGER || value > MAX_SAFE_INTEGER) return invalid()
  return Number(value)
}

function toRate(numerator: bigint, denominator: bigint): StatisticsRate {
  if (numerator < 0n || denominator < 0n || numerator > denominator) {
    return invalid()
  }
  const numeratorNumber = safeNumber(numerator)
  const denominatorNumber = safeNumber(denominator)
  if (denominator === 0n) {
    return {
      numerator: numeratorNumber,
      denominator: denominatorNumber,
      percentage: null,
    }
  }
  const hundredths = (numerator * 10_000n + denominator / 2n) / denominator
  return {
    numerator: numeratorNumber,
    denominator: denominatorNumber,
    percentage: Number(hundredths) / 100,
  }
}

function emptyCounters(): HandStatisticsCounters {
  return {
    handCount: 0n,
    distinctHandCount: 0n,
    handNetChange: 0n,
    vpipNumerator: 0n,
    pfrNumerator: 0n,
    threeBetNumerator: 0n,
    threeBetDenominator: 0n,
    showdownCount: 0n,
    wtsdDenominator: 0n,
    wsdNumerator: 0n,
  }
}

function matchesPersona(
  persona: HistoricalStatisticsPersonaSnapshot,
  selection: HandStatisticsSelection,
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

function selectTargetSeats(
  fact: StatisticsHandFact,
  selection: HandStatisticsSelection,
): readonly number[] {
  const matchedAiSeats = fact.aiParticipants
    .filter((persona) => matchesPersona(persona, selection))
    .map((persona) => persona.seatNumber)
  const hasPersonaFilter =
    selection.personaId !== null ||
    selection.personaVersion !== null ||
    selection.personaName !== null ||
    selection.configSnapshotKey !== null
  if (selection.subject === 'user') {
    return hasPersonaFilter && matchedAiSeats.length === 0 ? [] : [0]
  }
  return matchedAiSeats
}

function validatePersonas(fact: StatisticsHandFact): void {
  const resultBySeat = new Map(
    fact.history.result.seats.map((seat) => [seat.seatNumber, seat]),
  )
  const aiRoster = fact.history.roster.filter((entry) => !entry.isUser)
  if (
    fact.aiParticipants.length !== aiRoster.length ||
    new Set(fact.aiParticipants.map((entry) => entry.seatNumber)).size !==
      fact.aiParticipants.length
  ) {
    return invalid()
  }
  for (const persona of fact.aiParticipants) {
    const resultSeat = resultBySeat.get(persona.seatNumber)
    const rosterSeat = aiRoster.find(
      (entry) => entry.seatNumber === persona.seatNumber,
    )
    if (
      resultSeat === undefined ||
      resultSeat.isUser ||
      rosterSeat === undefined ||
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

export function projectThreeBetCounts(
  actions: readonly ThreeBetAction[],
  targetSeatNumber: number,
): { readonly numerator: bigint; readonly denominator: bigint } {
  const sorted = [...actions].sort(
    (left, right) => left.eventSeq - right.eventSeq,
  )
  let previousEventSeq = -1
  let priorFullRaises = 0
  let numerator = 0n
  let denominator = 0n
  for (const action of sorted) {
    if (
      !Number.isSafeInteger(action.eventSeq) ||
      action.eventSeq < 0 ||
      action.eventSeq <= previousEventSeq
    ) {
      return invalid()
    }
    previousEventSeq = action.eventSeq
    if (action.street !== 'preflop') continue
    const isTargetOpportunity =
      action.actorSeatNumber === targetSeatNumber &&
      priorFullRaises === 1 &&
      action.statistics.canMakeFullRaiseBeforeAction
    if (isTargetOpportunity) {
      denominator += 1n
      if (action.statistics.isVoluntaryPreflopFullRaise) numerator += 1n
    }
    if (action.statistics.isVoluntaryPreflopFullRaise) priorFullRaises += 1
  }
  return { numerator, denominator }
}

function sawFlopSeatNumbers(fact: StatisticsHandFact): ReadonlySet<number> {
  const participantSeats = new Set(
    fact.history.result.participantHands.map((hand) => hand.seatNumber),
  )
  let transitions = 0
  const sawFlop = new Set<number>()
  for (const entry of fact.history.events) {
    if (entry.event.type !== 'actionCommitted') continue
    const { before, after } = entry.event
    if (before.board.length >= 3 || after.board.length < 3) continue
    transitions += 1
    for (const seat of after.seats) {
      if (
        !participantSeats.has(seat.seatNumber) ||
        !['active', 'allIn'].includes(seat.status)
      ) {
        continue
      }
      sawFlop.add(seat.seatNumber)
    }
  }
  if (
    transitions > 1 ||
    (fact.history.result.board.length >= 3 && transitions !== 1) ||
    (fact.history.result.board.length < 3 && transitions !== 0)
  ) {
    return invalid()
  }
  return sawFlop
}

export function buildHandStatisticsContributions(
  selection: HandStatisticsSelection & { readonly fact: StatisticsHandFact },
): readonly HandStatisticsContribution[] {
  try {
    validatePersonas(selection.fact)
    const authoritative = projectAuthoritativeCompletedHandHistory(
      selection.fact.history,
    )
    const participantBySeat = new Map(
      authoritative.participants.map((participant) => [
        participant.seatNumber,
        participant,
      ]),
    )
    const resultBySeat = new Map(
      selection.fact.history.result.seats.map((seat) => [
        seat.seatNumber,
        seat,
      ]),
    )
    const actionEvents = selection.fact.history.events.flatMap((entry) =>
      entry.event.type === 'actionCommitted'
        ? [
            {
              eventSeq: entry.eventSeq,
              actorSeatNumber: entry.event.actorSeatNumber,
              street: entry.event.before.street,
              statistics: entry.event.statistics,
            } satisfies ThreeBetAction,
          ]
        : [],
    )
    const sawFlop = sawFlopSeatNumbers(selection.fact)
    const showdownSeats = new Set(
      selection.fact.history.result.handEvaluations.map(
        (evaluation) => evaluation.seatNumber,
      ),
    )
    if ([...showdownSeats].some((seatNumber) => !sawFlop.has(seatNumber))) {
      return invalid()
    }
    return selectTargetSeats(selection.fact, selection).flatMap(
      (seatNumber) => {
        const participant = participantBySeat.get(seatNumber)
        const result = resultBySeat.get(seatNumber)
        if (
          participant === undefined ||
          result === undefined ||
          !isSafeInteger(result.netChange) ||
          (selection.position !== null &&
            participant.position !== selection.position)
        ) {
          return []
        }
        const showdown = showdownSeats.has(seatNumber)
        const wonShowdown =
          showdown &&
          selection.fact.history.result.pots.some((pot) =>
            pot.awards.some(
              (award) => award.seatNumber === seatNumber && award.amount > 0,
            ),
          )
        return [
          {
            position: participant.position,
            handNetChange: BigInt(result.netChange),
            vpip: actionEvents.some(
              (action) =>
                action.actorSeatNumber === seatNumber &&
                action.street === 'preflop' &&
                action.statistics.isVoluntaryPreflopContribution,
            ),
            pfr: actionEvents.some(
              (action) =>
                action.actorSeatNumber === seatNumber &&
                action.street === 'preflop' &&
                action.statistics.isPreflopRaise,
            ),
            threeBet: projectThreeBetCounts(actionEvents, seatNumber),
            sawFlop: sawFlop.has(seatNumber),
            showdown,
            wonShowdown,
          },
        ] satisfies readonly HandStatisticsContribution[]
      },
    )
  } catch (error) {
    if (error instanceof StatisticsInvariantError) throw error
    return invalid()
  }
}

export interface HandStatisticsAccumulator {
  addHand(contributions: readonly HandStatisticsContribution[]): void
  metrics(): HandStatisticsMetrics
}

export function createHandStatisticsAccumulator(): HandStatisticsAccumulator {
  const counters = emptyCounters()
  const accumulator: HandStatisticsAccumulator = {
    addHand(contributions: readonly HandStatisticsContribution[]) {
      if (contributions.length === 0) return
      counters.distinctHandCount += 1n
      for (const contribution of contributions) {
        counters.handCount += 1n
        counters.handNetChange += contribution.handNetChange
        if (contribution.vpip) counters.vpipNumerator += 1n
        if (contribution.pfr) counters.pfrNumerator += 1n
        counters.threeBetNumerator += contribution.threeBet.numerator
        counters.threeBetDenominator += contribution.threeBet.denominator
        if (contribution.sawFlop) counters.wtsdDenominator += 1n
        if (contribution.showdown) {
          counters.showdownCount += 1n
          if (contribution.wonShowdown) counters.wsdNumerator += 1n
        }
      }
    },
    metrics() {
      return {
        handCount: safeNumber(counters.handCount),
        distinctHandCount: safeNumber(counters.distinctHandCount),
        handNetChange: safeNumber(counters.handNetChange),
        vpip: toRate(counters.vpipNumerator, counters.handCount),
        pfr: toRate(counters.pfrNumerator, counters.handCount),
        threeBet: toRate(
          counters.threeBetNumerator,
          counters.threeBetDenominator,
        ),
        wtsd: toRate(counters.showdownCount, counters.wtsdDenominator),
        wsd: toRate(counters.wsdNumerator, counters.showdownCount),
      }
    },
  }
  return Object.freeze(accumulator)
}
