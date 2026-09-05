import { describe, expect, test } from 'vitest'
import {
  decodeHandHistoryListCursor,
  encodeHandHistoryListCursor,
  normalizeHandHistoryListQuery,
} from '../../src/sessions/hand-history/completed-hand-history-list-query.js'
import { CompletedHandHistoryInvariantError } from '../../src/sessions/hand-history/errors.js'

const sessionId = '10000000-0000-4000-8000-000000000001'
const handId = '20000000-0000-4000-8000-000000000001'

describe('completed hand history list query', () => {
  test('normalizes the public filters and retains microsecond cursor positions', () => {
    const query = normalizeHandHistoryListQuery(
      new URLSearchParams({
        from: '2026-09-03T00:00:00.1Z',
        to: '2026-09-04T00:00:00Z',
        sessionId: sessionId.toUpperCase(),
        position: 'UTG+1',
        result: 'even',
        startingHand: 'AKs',
        personaId: 'retired-persona',
        personaVersion: '2',
        personaName: '旧人物',
        configSnapshotKey: 'a'.repeat(64),
        sort: 'oldest',
        limit: '2',
      }),
    )

    expect(query).toEqual({
      from: '2026-09-03T00:00:00.100000Z',
      to: '2026-09-04T00:00:00.000000Z',
      sessionId,
      position: 'UTG+1',
      result: 'even',
      startingHand: 'AKs',
      personaId: 'retired-persona',
      personaVersion: 2,
      personaName: '旧人物',
      configSnapshotKey: 'a'.repeat(64),
      sort: 'oldest',
      limit: 2,
      after: null,
    })

    const cursor = encodeHandHistoryListCursor({
      query,
      after: {
        startedAt: '2026-09-03T12:00:00.123456Z',
        handId,
      },
    })
    const { limit: _limit, after: _after, ...filters } = query
    expect(decodeHandHistoryListCursor(cursor)).toEqual({
      query: filters,
      after: { startedAt: '2026-09-03T12:00:00.123456Z', handId },
    })

    expect(
      normalizeHandHistoryListQuery(
        new URLSearchParams({
          from: '2026-09-03T00:00:00.1Z',
          to: '2026-09-04T00:00:00Z',
          sessionId,
          position: 'UTG+1',
          result: 'even',
          startingHand: 'AKs',
          personaId: 'retired-persona',
          personaVersion: '2',
          personaName: '旧人物',
          configSnapshotKey: 'a'.repeat(64),
          sort: 'oldest',
          cursor,
        }),
      ),
    ).toMatchObject({ after: { startedAt: '2026-09-03T12:00:00.123456Z' } })
  })

  test.each([
    new URLSearchParams({ startingHand: 'KAo' }),
    new URLSearchParams({ from: '2026-02-29T00:00:00Z' }),
    new URLSearchParams({ personaVersion: '1' }),
    new URLSearchParams({ limit: '01' }),
    new URLSearchParams({ personaName: '   ' }),
  ])('rejects an invalid public filter', (parameters) => {
    expect(() => normalizeHandHistoryListQuery(parameters)).toThrow(
      CompletedHandHistoryInvariantError,
    )
  })
})
