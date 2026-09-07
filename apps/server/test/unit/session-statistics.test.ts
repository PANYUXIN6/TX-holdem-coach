import { describe, expect, test } from 'vitest'
import { createPrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'
import {
  buildSessionStatisticsContributions,
  createSessionStatisticsAccumulator,
  type StatisticsSessionFact,
} from '../../src/sessions/statistics/session-statistics.js'
import { StatisticsInvariantError } from '../../src/sessions/statistics/errors.js'
import { createDirectWinCompletedHandHistoryFacts } from '../fixtures/completed-hand-history-fixture.js'

function createEndedFact(): StatisticsSessionFact {
  const history = createDirectWinCompletedHandHistoryFacts()
  const baseline = history.checkpoint.stateBeforeStartCommand
  const state = createPrivateTableState({
    ...baseline,
    stateVersion: 9,
    poker: {
      ...baseline.poker,
      seats: baseline.poker.seats.map((seat) =>
        seat.seatNumber === 0
          ? { ...seat, stack: 2_700 }
          : seat.seatNumber === 1
            ? { ...seat, stack: 1_300 }
            : seat,
      ),
    },
    seatAccounting: baseline.seatAccounting.map((accounting) =>
      accounting.seatNumber === 0
        ? { ...accounting, cumulativeBuyIn: 3_000 }
        : accounting,
    ),
  })
  return {
    sessionId: history.sessionId,
    lifecycleStatus: 'ended',
    currentHandId: null,
    stateVersion: 9,
    state,
    roster: history.roster,
    aiParticipants: history.roster
      .filter((participant) => !participant.isUser)
      .map((participant, index) => ({
        seatNumber: participant.seatNumber,
        personaId: `persona-${index + 1}`,
        personaVersion: 1,
        displayName: participant.displayName,
        configSnapshotKey: `${index + 1}`.repeat(64),
      })),
  }
}

const noPersonaFilters = {
  personaId: null,
  personaVersion: null,
  personaName: null,
  configSnapshotKey: null,
}

describe('fixed session statistics', () => {
  test('uses final authoritative stacks and cumulative buy-ins rather than a last-hand delta', () => {
    const contributions = buildSessionStatisticsContributions({
      fact: createEndedFact(),
      subject: 'user',
      ...noPersonaFilters,
    })
    const accumulator = createSessionStatisticsAccumulator()
    accumulator.addSession(contributions)

    expect(accumulator.totals()).toEqual({
      sessionCount: 1,
      participantSessionCount: 1,
      finalChips: 2_700,
      cumulativeBuyIn: 3_000,
      sessionNetChange: -300,
    })
  })

  test('keeps one session count while accumulating each matching AI participant', () => {
    const contributions = buildSessionStatisticsContributions({
      fact: createEndedFact(),
      subject: 'ai',
      ...noPersonaFilters,
    })
    const accumulator = createSessionStatisticsAccumulator()
    accumulator.addSession(contributions)

    expect(accumulator.totals()).toMatchObject({
      sessionCount: 1,
      participantSessionCount: 5,
      finalChips: 5_300,
      cumulativeBuyIn: 5_000,
      sessionNetChange: 300,
    })
  })

  test('selects a historical AI identity on its own, not a different matching roster member', () => {
    const contributions = buildSessionStatisticsContributions({
      fact: createEndedFact(),
      subject: 'ai',
      personaId: 'persona-1',
      personaVersion: null,
      personaName: null,
      configSnapshotKey: null,
    })
    const accumulator = createSessionStatisticsAccumulator()
    accumulator.addSession(contributions)

    expect(accumulator.totals()).toEqual({
      sessionCount: 1,
      participantSessionCount: 1,
      finalChips: 1_300,
      cumulativeBuyIn: 1_000,
      sessionNetChange: 300,
    })
  })

  test('rejects a session that is not an ended between-hands final state', () => {
    const fact = createEndedFact()
    expect(() =>
      buildSessionStatisticsContributions({
        fact: {
          ...fact,
          currentHandId: '10000000-0000-4000-8000-000000000001',
        } as unknown as StatisticsSessionFact,
        subject: 'user',
        ...noPersonaFilters,
      }),
    ).toThrow(StatisticsInvariantError)
  })
})
