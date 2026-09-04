import { describe, expect, test, vi } from 'vitest'
import { createApp, type ApiRuntime } from '../../src/http/create-app.js'
import { DatabaseOperationError } from '../../src/persistence/errors.js'
import { projectAuthoritativeCompletedHandHistory } from '../../src/sessions/hand-history/completed-hand-history-projector.js'
import { createCompletedHandHistoryQueryService } from '../../src/sessions/hand-history/completed-hand-history-query-service.js'
import { createDirectWinCompletedHandHistoryFacts } from '../fixtures/completed-hand-history-fixture.js'

const origin = 'http://localhost:5173'
const baseUrl = 'http://127.0.0.1:8787'

function createTestApp(handHistory: unknown) {
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
      handHistory,
    } as unknown as ApiRuntime,
    { port: 8787, allowedOrigins: new Set([origin]) },
  )
}

describe('completed hand history HTTP API', () => {
  test('uses the default public view, permits only one decoded view query, and supports HEAD and preflight', async () => {
    const history = projectAuthoritativeCompletedHandHistory(
      createDirectWinCompletedHandHistoryFacts(),
    )
    const read = vi.fn(async () => history)
    const app = createTestApp(
      createCompletedHandHistoryQueryService({ reader: { read } }),
    )
    const path = `/api/hands/${history.handId}`

    const defaultResponse = await app.request(`${baseUrl}${path}`)
    const publicResponse = await app.request(`${baseUrl}${path}?view=public`)
    const auditResponse = await app.request(
      `${baseUrl}${path}?view=auditReveal`,
    )

    expect(defaultResponse.status).toBe(200)
    await expect(defaultResponse.json()).resolves.toMatchObject({
      protocolVersion: 1,
      view: 'public',
      history: { handId: history.handId },
    })
    const repeatedDefault = await app.request(`${baseUrl}${path}`)
    expect(await publicResponse.json()).toEqual(await repeatedDefault.json())
    await expect(auditResponse.json()).resolves.toMatchObject({
      view: 'auditReveal',
    })

    const head = await app.request(`${baseUrl}${path}?view=public`, {
      method: 'HEAD',
    })
    expect(head.status).toBe(200)
    await expect(head.text()).resolves.toBe('')
    const preflight = await app.request(`${baseUrl}${path}`, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'GET',
      },
    })
    expect(preflight.status).toBe(204)

    read.mockClear()
    for (const query of [
      '?view=',
      '?view=public&view=public',
      '?view=public&extra=1',
      '?%76iew=public&view=auditReveal',
      '?view=PUBLIC',
    ]) {
      const response = await app.request(`${baseUrl}${path}${query}`)
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({
        code: 'INVALID_REQUEST',
      })
    }
    expect(read).not.toHaveBeenCalled()
  })

  test('normalizes inaccessible hands to 404 and preserves infrastructure failures', async () => {
    const handId = '10000000-0000-4000-8000-000000000001'
    const missing = createTestApp({ read: async () => null })
    const missingResponse = await missing.request(
      `${baseUrl}/api/hands/${handId}`,
    )
    expect(missingResponse.status).toBe(404)
    await expect(missingResponse.json()).resolves.toEqual({
      code: 'HAND_NOT_FOUND',
      message: '手牌不存在。',
    })

    const unavailable = createTestApp({
      read: async () => {
        throw new DatabaseOperationError()
      },
    })
    const unavailableResponse = await unavailable.request(
      `${baseUrl}/api/hands/${handId}`,
    )
    expect(unavailableResponse.status).toBe(503)
    await expect(unavailableResponse.json()).resolves.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    })
  })
})
