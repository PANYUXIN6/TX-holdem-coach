import { describe, expect, test, vi } from 'vitest'
import { createApp, type ApiRuntime } from '../../src/app.js'
import { getProviderSettingsResponse, ServerConfig } from '../../src/config.js'
import { loadAndValidatePersonaCatalog } from '../../src/personas/catalog.js'
import { createProviderCheckTransport } from '../../src/providers/provider-check-transport.js'
import { createProviderHealthService } from '../../src/providers/provider-health-service.js'

const origin = 'http://localhost:5173'
const baseUrl = 'http://127.0.0.1:8787'
const sessionId = '2a0dc0dd-843a-4e53-a62e-e5ac22f90a3e'

function runtime() {
  const providerResponse = getProviderSettingsResponse(
    new ServerConfig({ port: 8787, databaseUrl: 'postgresql://runtime' }),
  )
  const update = vi.fn(async () => ({
    protocolVersion: 1 as const,
    settings: {
      attemptTimeoutSeconds: 20,
      decisionDeadlineSeconds: 45,
    },
  }))
  const deleteEndedSession = vi.fn(async () => ({
    protocolVersion: 1 as const,
    deletedSessionId: sessionId,
    invalidatedRunCount: 0,
  }))
  return {
    value: {
      health: {
        read: async () => ({
          protocolVersion: 1 as const,
          status: 'ok' as const,
          database: 'available' as const,
        }),
      },
      providerHealth: {
        read: () => providerResponse,
        check: async () => providerResponse,
      },
      playerAgentSettings: {
        read: async () => ({
          protocolVersion: 1 as const,
          settings: {
            attemptTimeoutSeconds: 15,
            decisionDeadlineSeconds: 45,
          },
        }),
        update,
      },
      personaCatalog: loadAndValidatePersonaCatalog(),
      deletion: {
        deleteEndedSession,
        clearAll: async () => ({
          protocolVersion: 1 as const,
          deletedSessionCount: 0,
          invalidatedRunCount: 0,
        }),
      },
    } satisfies ApiRuntime,
    update,
    deleteEndedSession,
  }
}

function createTestApp(
  value: ApiRuntime,
  logRequest?: (entry: {
    readonly requestId: string
    readonly method: string
    readonly route: string
    readonly status: number
    readonly errorCode?: string
    readonly durationMs: number
  }) => void,
) {
  return createApp(value, {
    port: 8787,
    allowedOrigins: new Set([origin]),
    ...(logRequest === undefined ? {} : { logRequest }),
  })
}

describe('M3.5 HTTP API', () => {
  test('serves readiness with security headers and a server request id', async () => {
    const app = createTestApp(runtime().value)
    const response = await app.request(`${baseUrl}/api/health`, {
      headers: { 'X-Request-Id': 'client-controlled' },
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      protocolVersion: 1,
      status: 'ok',
      database: 'available',
    })
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-frame-options')).toBe('DENY')
    expect(response.headers.get('x-request-id')).not.toBe('client-controlled')
  })

  test('rejects foreign hosts, missing origins and oversized JSON before services', async () => {
    const fixture = runtime()
    const app = createTestApp(fixture.value)
    const foreignHost = await app.request('http://attacker.example/api/health')
    expect(foreignHost.status).toBe(403)
    expect(foreignHost.headers.get('cache-control')).toBe('no-store')
    expect(foreignHost.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)

    const unexpectedQuery = await app.request(
      `${baseUrl}/api/agent-personas?sort=name`,
    )
    expect(unexpectedQuery.status).toBe(400)

    const missingOrigin = await app.request(`${baseUrl}/api/settings/agent`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: 1,
        settings: { attemptTimeoutSeconds: 20 },
      }),
    })
    expect(missingOrigin.status).toBe(403)

    const boundaryLogs = vi.fn()
    const loggedBoundaryApp = createTestApp(fixture.value, boundaryLogs)
    await loggedBoundaryApp.request(`${baseUrl}/api/settings/agent`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: 1,
        settings: { attemptTimeoutSeconds: 20 },
      }),
    })
    expect(boundaryLogs).toHaveBeenCalledWith(
      expect.objectContaining({ route: '/api/settings/agent' }),
    )

    const wrongMediaType = await app.request(`${baseUrl}/api/settings/agent`, {
      method: 'PATCH',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json-evil',
      },
      body: '{}',
    })
    expect(wrongMediaType.status).toBe(415)

    const oversized = await app.request(`${baseUrl}/api/settings/agent`, {
      method: 'PATCH',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: 1,
        settings: {},
        pad: 'x'.repeat(66_000),
      }),
    })
    expect(oversized.status).toBe(413)

    const streamedRequest = new Request(`${baseUrl}/api/settings/agent`, {
      method: 'PATCH',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(40_000))
          controller.enqueue(new Uint8Array(40_000))
          controller.close()
        },
      }),
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })
    expect(streamedRequest.headers.has('content-length')).toBe(false)
    const streamedOversized = await app.request(streamedRequest)
    expect(streamedOversized.status).toBe(413)

    let declaredBodyCancelled = false
    const declaredOversized = await app.request(
      new Request(`${baseUrl}/api/settings/agent`, {
        method: 'PATCH',
        headers: {
          Origin: origin,
          'Content-Type': 'application/json',
          'Content-Length': '65537',
        },
        body: new ReadableStream({
          cancel() {
            declaredBodyCancelled = true
          },
        }),
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }),
    )
    expect(declaredOversized.status).toBe(413)
    expect(declaredBodyCancelled).toBe(true)
    expect(fixture.update).not.toHaveBeenCalled()
  })

  test('strictly parses settings and deletion requests before calling services', async () => {
    const fixture = runtime()
    const app = createTestApp(fixture.value)
    const settings = await app.request(`${baseUrl}/api/settings/agent`, {
      method: 'PATCH',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: 1,
        settings: { attemptTimeoutSeconds: 20 },
      }),
    })
    expect(settings.status).toBe(200)
    expect(fixture.update).toHaveBeenCalledOnce()

    const invalidDelete = await app.request(
      `${baseUrl}/api/sessions/${sessionId}`,
      {
        method: 'DELETE',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocolVersion: 1, confirmation: '删除' }),
      },
    )
    expect(invalidDelete.status).toBe(400)
    expect(fixture.deleteEndedSession).not.toHaveBeenCalled()
  })

  test('projects only public persona fields and returns strict not-found errors', async () => {
    const app = createTestApp(runtime().value)
    const response = await app.request(`${baseUrl}/api/agent-personas`)
    const body = (await response.json()) as { personas: unknown[] }
    expect(response.status).toBe(200)
    expect(body.personas).toHaveLength(8)
    expect(JSON.stringify(body)).not.toMatch(
      /strategyDescription|models|prompt/i,
    )

    const notFound = await app.request(`${baseUrl}/api/unknown`)
    expect(notFound.status).toBe(404)
    await expect(notFound.json()).resolves.toMatchObject({
      code: 'ROUTE_NOT_FOUND',
    })
  })

  test('turns invalid service output into a sanitized internal error', async () => {
    const fixture = runtime()
    const app = createTestApp({
      ...fixture.value,
      health: {
        read: async () => ({ privateDetail: 'must-not-leak' }) as never,
      },
    })

    const response = await app.request(`${baseUrl}/api/health`)
    expect(response.status).toBe(500)
    const body = await response.text()
    expect(body).toContain('INTERNAL_SERVER_ERROR')
    expect(body).not.toContain('must-not-leak')
  })

  test('logs only stable request metadata and ignores logging failures', async () => {
    const logRequest = vi.fn()
    const app = createTestApp(runtime().value, logRequest)
    const marker = 'private-body-marker'
    const response = await app.request(`${baseUrl}/api/settings/agent`, {
      method: 'PATCH',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 1, settings: {}, marker }),
    })
    expect(response.status).toBe(400)
    expect(logRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'PATCH',
        route: '/api/settings/agent',
        status: 400,
        errorCode: 'INVALID_REQUEST',
      }),
    )
    expect(JSON.stringify(logRequest.mock.calls)).not.toContain(marker)

    const dynamicSession = await app.request(
      `${baseUrl}/api/sessions/${sessionId}`,
      {
        method: 'DELETE',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          protocolVersion: 1,
          confirmation: '永久删除本场',
        }),
      },
    )
    expect(dynamicSession.status).toBe(200)

    const personaId = 'nit_fish'
    const dynamicPersona = await app.request(
      `${baseUrl}/api/agent-personas/${personaId}`,
    )
    expect(dynamicPersona.status).toBe(200)

    const activeSession = await app.request(`${baseUrl}/api/sessions/active`)
    expect(activeSession.status).toBe(404)

    const unknownPath = '/api/unknown/private-resource-id'
    const unknown = await app.request(`${baseUrl}${unknownPath}`)
    expect(unknown.status).toBe(404)
    expect(logRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        route: '/api/sessions/:sessionId',
      }),
    )
    expect(logRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        route: '/api/agent-personas/:personaId',
      }),
    )
    expect(logRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        route: 'unmatched',
      }),
    )
    expect(logRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        route: 'unmatched',
        errorCode: 'ROUTE_NOT_FOUND',
      }),
    )
    const serializedLogs = JSON.stringify(logRequest.mock.calls)
    expect(serializedLogs).not.toContain(sessionId)
    expect(serializedLogs).not.toContain(personaId)
    expect(serializedLogs).not.toContain(unknownPath)

    const healthHead = await app.request(`${baseUrl}/api/health`, {
      method: 'HEAD',
    })
    const personasHead = await app.request(`${baseUrl}/api/agent-personas`, {
      method: 'HEAD',
    })
    expect(healthHead.status).toBe(200)
    expect(personasHead.status).toBe(200)
    expect(logRequest).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'HEAD', route: '/api/health' }),
    )
    expect(logRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'HEAD',
        route: '/api/agent-personas',
      }),
    )

    const throwingLoggerApp = createTestApp(runtime().value, () => {
      throw new Error('logging failed')
    })
    const healthy = await throwingLoggerApp.request(`${baseUrl}/api/health`)
    expect(healthy.status).toBe(200)
  })

  test('cancels an undeclared oversized provider stream and returns a sanitized unavailable result', async () => {
    let cancelled = false
    const transport = createProviderCheckTransport({
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(200_000))
              controller.enqueue(new Uint8Array(62_145))
            },
            cancel() {
              cancelled = true
            },
          }),
          { status: 200 },
        ),
    })
    const providerHealth = createProviderHealthService({
      config: new ServerConfig({
        port: 8787,
        databaseUrl: 'postgresql://runtime',
        deepSeekApiKey: 'private-key',
      }),
      transport,
      now: () => '2026-08-12T00:00:00.000Z',
    })
    const app = createTestApp({
      ...runtime().value,
      providerHealth,
    })

    const response = await app.request(
      `${baseUrl}/api/settings/providers/deepseek/check`,
      {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocolVersion: 1 }),
      },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      deepSeek: {
        checkStatus: 'unavailable',
        errorCode: 'provider_unknown_error',
      },
    })
    expect(cancelled).toBe(true)
    expect(providerHealth.read().deepSeek).toMatchObject({
      checkStatus: 'unavailable',
      errorCode: 'provider_unknown_error',
    })
  })
})
