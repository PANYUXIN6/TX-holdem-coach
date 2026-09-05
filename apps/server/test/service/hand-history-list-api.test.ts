import { describe, expect, test, vi } from 'vitest'
import { createApp, type ApiRuntime } from '../../src/http/create-app.js'

const origin = 'http://localhost:5173'
const baseUrl = 'http://127.0.0.1:8787'

function createTestApp(handHistoryList: unknown) {
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
      handHistoryList,
    } as unknown as ApiRuntime,
    { port: 8787, allowedOrigins: new Set([origin]) },
  )
}

describe('completed hand history list HTTP API', () => {
  test('accepts only the collection query contract and preserves HEAD and preflight', async () => {
    const list = vi.fn(async () => ({ items: [], nextCursor: null }))
    const app = createTestApp({ list })

    const response = await app.request(
      `${baseUrl}/api/hands?limit=1&sort=oldest`,
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      items: [],
      nextCursor: null,
    })
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1, sort: 'oldest', after: null }),
    )

    const head = await app.request(`${baseUrl}/api/hands`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    await expect(head.text()).resolves.toBe('')
    const preflight = await app.request(`${baseUrl}/api/hands`, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'GET',
      },
    })
    expect(preflight.status).toBe(204)

    list.mockClear()
    for (const query of ['?limit=01', '?limit=1&limit=2', '?view=public']) {
      const invalid = await app.request(`${baseUrl}/api/hands${query}`)
      expect(invalid.status).toBe(400)
      await expect(invalid.json()).resolves.toMatchObject({
        code: 'INVALID_REQUEST',
      })
    }
    expect(list).not.toHaveBeenCalled()
  })
})
