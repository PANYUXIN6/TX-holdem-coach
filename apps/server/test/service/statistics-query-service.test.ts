import { describe, expect, test, vi } from 'vitest'
import { createStatisticsQueryService } from '../../src/sessions/statistics/statistics-query-service.js'
import {
  createDirectWinCompletedHandHistoryFacts,
  createShowdownCompletedHandHistoryFacts,
} from '../fixtures/completed-hand-history-fixture.js'

function handFact(
  history: ReturnType<typeof createDirectWinCompletedHandHistoryFacts>,
) {
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

const handsQuery = {
  scope: 'hands' as const,
  subject: 'user' as const,
  from: null,
  to: null,
  sessionId: null,
  position: null,
  personaId: null,
  personaVersion: null,
  personaName: null,
  configSnapshotKey: null,
  groupBy: 'position' as const,
}

const sessionsQuery = {
  scope: 'sessions' as const,
  subject: 'user' as const,
  from: null,
  to: null,
  sessionId: null,
  personaId: null,
  personaVersion: null,
  personaName: null,
  configSnapshotKey: null,
  groupBy: 'none' as const,
}

describe('statistics query service', () => {
  test('streams authenticated hands into totals and fixed position buckets', async () => {
    const first = handFact(createDirectWinCompletedHandHistoryFacts())
    const second = handFact(createShowdownCompletedHandHistoryFacts())
    const scanHandFacts = vi.fn(async (_query, consume) => {
      await consume(first)
      await consume(second)
    })
    const service = createStatisticsQueryService({
      reader: { scanHandFacts, scanSessionFacts: async () => undefined },
    })

    await expect(service.read(handsQuery)).resolves.toMatchObject({
      scope: 'hands',
      query: handsQuery,
      timeBasis: 'handStartedAt',
      totals: {
        handCount: 2,
        distinctHandCount: 2,
        vpip: { numerator: 0, denominator: 2, percentage: 0 },
      },
      byPosition: [
        { position: 'UTG' },
        { position: 'UTG+1' },
        { position: 'MP' },
        { position: 'LJ' },
        { position: 'HJ' },
        { position: 'CO' },
        { position: 'BTN', metrics: { handCount: 2 } },
        { position: 'SB' },
        { position: 'BB' },
      ],
    })
    expect(scanHandFacts).toHaveBeenCalledWith(handsQuery, expect.any(Function))
  })

  test('uses the ended-session reader only for session accounting', async () => {
    const history = createDirectWinCompletedHandHistoryFacts()
    const scanSessionFacts = vi.fn(async (_query, consume) =>
      consume({
        sessionId: history.sessionId,
        lifecycleStatus: 'ended',
        currentHandId: null,
        stateVersion: 1,
        state: history.checkpoint.stateBeforeStartCommand,
        roster: history.roster,
        aiParticipants: handFact(history).aiParticipants,
      }),
    )
    const service = createStatisticsQueryService({
      reader: { scanHandFacts: async () => undefined, scanSessionFacts },
    })

    await expect(service.read(sessionsQuery)).resolves.toEqual({
      scope: 'sessions',
      query: sessionsQuery,
      timeBasis: 'sessionEndedAt',
      totals: {
        sessionCount: 1,
        participantSessionCount: 1,
        finalChips: 1_000,
        cumulativeBuyIn: 1_000,
        sessionNetChange: 0,
      },
    })
    expect(scanSessionFacts).toHaveBeenCalledWith(
      sessionsQuery,
      expect.any(Function),
    )
  })
})
