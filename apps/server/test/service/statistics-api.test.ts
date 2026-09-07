import { describe, expect, test, vi } from 'vitest'
import { createApp, type ApiRuntime } from '../../src/http/create-app.js'

const origin = 'http://localhost:5173'
const baseUrl = 'http://127.0.0.1:8787'

function createTestApp(statistics: unknown) {
  return createApp(
    {
      health: { read: async () => ({}) },
      providerHealth: { read: () => ({}), check: async () => ({}) },
      playerAgentSettings: { read: async () => ({}), update: async () => ({}) },
      personaCatalog: {},
      deletion: {
        deleteEndedSession: async () => ({}),
        clearAll: async () => ({}),
      },
      sessionHttp: {},
      sessionEvents: {},
      handHistory: { read: async () => null },
      handHistoryList: { list: async () => ({ items: [], nextCursor: null }) },
      statistics,
    } as unknown as ApiRuntime,
    { port: 8787, allowedOrigins: new Set([origin]) },
  )
}

describe('fixed statistics HTTP API', () => {
  test('accepts only the strict statistics query, including HEAD and preflight', async () => {
    const read = vi.fn(async (query) =>
      query.scope === 'sessions'
        ? {
            scope: 'sessions' as const,
            query,
            timeBasis: 'sessionEndedAt' as const,
            totals: {
              sessionCount: 0,
              participantSessionCount: 0,
              finalChips: 0,
              cumulativeBuyIn: 0,
              sessionNetChange: 0,
            },
          }
        : {
            scope: 'hands' as const,
            query,
            timeBasis: 'handStartedAt' as const,
            totals: {
              handCount: 0,
              distinctHandCount: 0,
              handNetChange: 0,
              vpip: { numerator: 0, denominator: 0, percentage: null },
              pfr: { numerator: 0, denominator: 0, percentage: null },
              threeBet: { numerator: 0, denominator: 0, percentage: null },
              wtsd: { numerator: 0, denominator: 0, percentage: null },
              wsd: { numerator: 0, denominator: 0, percentage: null },
            },
            byPosition: [],
          },
    )
    const app = createTestApp({ read })

    const response = await app.request(
      `${baseUrl}/api/statistics?scope=sessions&subject=ai`,
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      scope: 'sessions',
      totals: { sessionCount: 0 },
    })
    expect(read).toHaveBeenCalledWith({
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

    const head = await app.request(`${baseUrl}/api/statistics`, {
      method: 'HEAD',
    })
    expect(head.status).toBe(200)
    await expect(head.text()).resolves.toBe('')
    const preflight = await app.request(`${baseUrl}/api/statistics`, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'GET',
      },
    })
    expect(preflight.status).toBe(204)

    read.mockClear()
    for (const query of [
      '?scope=sessions&position=BTN',
      '?subject=user&subject=ai',
      '?unknown=value',
      '?personaName=%FF',
    ]) {
      const invalid = await app.request(`${baseUrl}/api/statistics${query}`)
      expect(invalid.status).toBe(400)
      await expect(invalid.json()).resolves.toMatchObject({
        code: 'INVALID_REQUEST',
      })
    }
    expect(read).not.toHaveBeenCalled()
  })
})
