import { describe, expect, test, vi } from 'vitest'
import type { CompletedHandHistoryListFact } from '../../src/sessions/hand-history/completed-hand-history-list.js'
import { createCompletedHandHistoryListQueryService } from '../../src/sessions/hand-history/completed-hand-history-list-query-service.js'
import { createDirectWinCompletedHandHistoryFacts } from '../fixtures/completed-hand-history-fixture.js'

function createListFact(
  handId: string,
  startedAt: string,
): CompletedHandHistoryListFact {
  const facts = createDirectWinCompletedHandHistoryFacts()
  return {
    sessionId: facts.sessionId,
    handId,
    handNumber: facts.handNumber,
    startedAt,
    completedAt: '2026-09-03T12:01:00.000000Z',
    result: { ...facts.result, handId },
    aiParticipants: facts.roster
      .filter((participant) => !participant.isUser)
      .map((participant, index) => ({
        seatNumber: participant.seatNumber,
        personaId: `retired-persona-${index + 1}`,
        personaVersion: 2,
        displayName: participant.displayName,
        avatarColor: participant.avatarColor,
        configSnapshotKey: `${index + 1}`.repeat(64),
      })),
  }
}

describe('completed hand history list query service', () => {
  test('projects only the returned page and creates the next cursor from its last item', async () => {
    const first = createListFact(
      '10000000-0000-4000-8000-000000000001',
      '2026-09-03T12:00:00.123456Z',
    )
    const probe = createListFact(
      '20000000-0000-4000-8000-000000000001',
      '2026-09-03T11:00:00.123456Z',
    )
    const listCompletedHandHistoryFacts = vi.fn(async () => [first, probe])
    const service = createCompletedHandHistoryListQueryService({
      reader: { listCompletedHandHistoryFacts },
    })

    const response = await service.list({
      from: null,
      to: null,
      sessionId: null,
      position: null,
      result: null,
      startingHand: null,
      personaId: null,
      personaVersion: null,
      personaName: null,
      configSnapshotKey: null,
      sort: 'newest',
      limit: 1,
      after: null,
    })

    expect(response.items[0]).toMatchObject({
      handId: first.handId,
      user: {
        startingHandCategory: first.result.seats[0]?.startingHandCategory,
      },
    })
    expect(response.items[0]?.aiParticipants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          personaId: 'retired-persona-1',
          personaVersion: 2,
        }),
      ]),
    )
    expect(response.items).toHaveLength(1)
    expect(response.nextCursor).toEqual(expect.any(String))
    expect(JSON.stringify(response)).not.toContain('checkpoint')
    expect(JSON.stringify(response)).not.toContain('playerId')
    expect(listCompletedHandHistoryFacts).toHaveBeenCalledTimes(1)
  })
})
