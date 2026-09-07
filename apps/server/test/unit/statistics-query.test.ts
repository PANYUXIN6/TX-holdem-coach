import { describe, expect, test } from 'vitest'
import { normalizeStatisticsQuery } from '../../src/sessions/statistics/statistics-query.js'
import { StatisticsInvariantError } from '../../src/sessions/statistics/errors.js'

const sessionId = '10000000-0000-4000-8000-000000000001'

describe('statistics query', () => {
  test('normalizes hands defaults, history filters, and UTC microseconds', () => {
    expect(
      normalizeStatisticsQuery(
        new URLSearchParams({
          from: '2026-09-03T00:00:00.1Z',
          to: '2026-09-04T00:00:00Z',
          sessionId: sessionId.toUpperCase(),
          position: 'UTG+1',
          personaId: 'retired-persona',
          personaVersion: '2',
          personaName: '旧人物',
          configSnapshotKey: 'a'.repeat(64),
          groupBy: 'position',
        }),
      ),
    ).toEqual({
      scope: 'hands',
      subject: 'user',
      from: '2026-09-03T00:00:00.100000Z',
      to: '2026-09-04T00:00:00.000000Z',
      sessionId,
      position: 'UTG+1',
      personaId: 'retired-persona',
      personaVersion: 2,
      personaName: '旧人物',
      configSnapshotKey: 'a'.repeat(64),
      groupBy: 'position',
    })
  })

  test('normalizes the sessions branch without a hand-only position field', () => {
    expect(
      normalizeStatisticsQuery(
        new URLSearchParams({ scope: 'sessions', subject: 'ai' }),
      ),
    ).toEqual({
      scope: 'sessions',
      subject: 'ai',
      from: null,
      to: null,
      sessionId: null,
      personaId: null,
      personaVersion: null,
      personaName: null,
      configSnapshotKey: null,
      groupBy: 'none',
    })
  })

  test.each([
    new URLSearchParams({ scope: 'sessions', position: 'BTN' }),
    new URLSearchParams({ scope: 'sessions', groupBy: 'position' }),
    new URLSearchParams({ personaVersion: '1' }),
    new URLSearchParams({
      from: '2026-09-04T00:00:00Z',
      to: '2026-09-04T00:00:00Z',
    }),
    new URLSearchParams({ from: '2026-02-29T00:00:00Z' }),
    new URLSearchParams([
      ['subject', 'user'],
      ['subject', 'ai'],
    ]),
    new URLSearchParams({ unknown: 'value' }),
    new URLSearchParams({ personaName: '  ' }),
  ])(
    'rejects malformed, repeated, or incompatible parameters',
    (parameters) => {
      expect(() => normalizeStatisticsQuery(parameters)).toThrow(
        StatisticsInvariantError,
      )
    },
  )
})
