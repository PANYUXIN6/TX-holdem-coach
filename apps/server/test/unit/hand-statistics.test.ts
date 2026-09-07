import { describe, expect, test } from 'vitest'
import {
  buildHandStatisticsContributions,
  createHandStatisticsAccumulator,
  projectThreeBetCounts,
  type StatisticsHandFact,
} from '../../src/sessions/statistics/hand-statistics.js'
import { StatisticsInvariantError } from '../../src/sessions/statistics/errors.js'
import {
  createDirectWinCompletedHandHistoryFacts,
  createShowdownCompletedHandHistoryFacts,
} from '../fixtures/completed-hand-history-fixture.js'

function withHistoricalPersonas(
  history: ReturnType<typeof createDirectWinCompletedHandHistoryFacts>,
): StatisticsHandFact {
  return {
    history,
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

describe('fixed hand statistics', () => {
  test('counts a direct-win user hand once without inventing flop or showdown facts', () => {
    const fact = withHistoricalPersonas(
      createDirectWinCompletedHandHistoryFacts(),
    )
    const contributions = buildHandStatisticsContributions({
      fact,
      subject: 'user',
      position: null,
      ...noPersonaFilters,
    })
    const accumulator = createHandStatisticsAccumulator()
    accumulator.addHand(contributions)

    expect(accumulator.metrics()).toEqual({
      handCount: 1,
      distinctHandCount: 1,
      handNetChange: 0,
      vpip: { numerator: 0, denominator: 1, percentage: 0 },
      pfr: { numerator: 0, denominator: 1, percentage: 0 },
      threeBet: { numerator: 0, denominator: 0, percentage: null },
      wtsd: { numerator: 0, denominator: 0, percentage: null },
      wsd: { numerator: 0, denominator: 0, percentage: null },
    })
  })

  test('uses all authenticated actions for AI flop, showdown, and positive-award facts', () => {
    const history = createShowdownCompletedHandHistoryFacts()
    const fact = withHistoricalPersonas(history)
    const targetSeat = 3
    const expectedWonShowdown = history.result.pots.some((pot) =>
      pot.awards.some(
        (award) => award.seatNumber === targetSeat && award.amount > 0,
      ),
    )
    const expectedNetChange = history.result.seats.find(
      (seat) => seat.seatNumber === targetSeat,
    )?.netChange
    const contributions = buildHandStatisticsContributions({
      fact,
      subject: 'ai',
      position: null,
      personaId: 'persona-3',
      personaVersion: null,
      personaName: null,
      configSnapshotKey: null,
    })
    const accumulator = createHandStatisticsAccumulator()
    accumulator.addHand(contributions)

    expect(accumulator.metrics()).toMatchObject({
      handCount: 1,
      distinctHandCount: 1,
      handNetChange: expectedNetChange,
      vpip: { numerator: 1, denominator: 1, percentage: 100 },
      pfr: { numerator: 0, denominator: 1, percentage: 0 },
      wtsd: { numerator: 1, denominator: 1, percentage: 100 },
      wsd: {
        numerator: expectedWonShowdown ? 1 : 0,
        denominator: 1,
        percentage: expectedWonShowdown ? 100 : 0,
      },
    })
  })

  test('counts every legal preflop opportunity after the first full raise by event sequence', () => {
    const source = createShowdownCompletedHandHistoryFacts()
    const template = source.events.find(
      (fact) =>
        fact.event.type === 'actionCommitted' &&
        fact.event.before.street === 'preflop',
    )
    if (template?.event.type !== 'actionCommitted') {
      throw new Error('Expected a preflop action fixture.')
    }
    const action = (
      eventSeq: number,
      actorSeatNumber: number,
      statistics: typeof template.event.statistics,
    ) => ({
      eventSeq,
      actorSeatNumber,
      street: 'preflop' as const,
      statistics,
    })

    expect(
      projectThreeBetCounts(
        [
          action(10, 3, {
            isVoluntaryPreflopContribution: true,
            isPreflopRaise: true,
            isVoluntaryPreflopFullRaise: true,
            canMakeFullRaiseBeforeAction: true,
          }),
          action(20, 0, {
            isVoluntaryPreflopContribution: true,
            isPreflopRaise: false,
            isVoluntaryPreflopFullRaise: false,
            canMakeFullRaiseBeforeAction: true,
          }),
          action(30, 0, {
            isVoluntaryPreflopContribution: true,
            isPreflopRaise: true,
            isVoluntaryPreflopFullRaise: true,
            canMakeFullRaiseBeforeAction: true,
          }),
          action(40, 4, {
            isVoluntaryPreflopContribution: true,
            isPreflopRaise: true,
            isVoluntaryPreflopFullRaise: true,
            canMakeFullRaiseBeforeAction: true,
          }),
        ],
        0,
      ),
    ).toEqual({ numerator: 1n, denominator: 2n })
  })

  test('fails instead of inferring a missing first flop transition', () => {
    const history = createShowdownCompletedHandHistoryFacts()
    const broken = {
      ...history,
      events: history.events.map((fact) =>
        fact.event.type === 'actionCommitted' &&
        fact.event.before.board.length < 3 &&
        fact.event.after.board.length >= 3
          ? {
              ...fact,
              event: {
                ...fact.event,
                after: { ...fact.event.after, board: [] },
              },
            }
          : fact,
      ),
    }

    expect(() =>
      buildHandStatisticsContributions({
        fact: withHistoricalPersonas(broken),
        subject: 'user',
        position: null,
        ...noPersonaFilters,
      }),
    ).toThrow(StatisticsInvariantError)
  })
})
