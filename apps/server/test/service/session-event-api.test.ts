import type { SseEvent } from '@tx-holdem-coach/contracts'
import { describe, expect, test, vi } from 'vitest'
import { createApp, type ApiRuntime } from '../../src/app.js'
import { getProviderSettingsResponse, ServerConfig } from '../../src/config.js'
import { loadAndValidatePersonaCatalog } from '../../src/personas/catalog.js'
import type { OpenSessionEventStream } from '../../src/sessions/public-projection/session-event-connection.js'
import { writeBeforeDeadline } from '../../src/http/session-event-routes.js'

const origin = 'http://localhost:5173'
const baseUrl = 'http://127.0.0.1:8787'
const sessionId = '22222222-2222-4222-8222-222222222222'

function calibration(): SseEvent {
  const snapshot = {
    protocolVersion: 1 as const,
    sessionId,
    stateVersion: 1,
    eventSeq: 2,
    pokerPhase: 'betweenHands' as const,
    lifecycleStatus: 'ended' as const,
    agentRunState: 'idle' as const,
    activeDecision: null,
    seats: Array.from({ length: 6 }, (_, seatNumber) => ({
      seatNumber,
      playerId: `66666666-6666-4666-8666-${seatNumber.toString().padStart(12, '0')}`,
      displayName: seatNumber === 0 ? '玩家' : `AI ${seatNumber}`,
      avatarColor: '#0f766e',
      isUser: seatNumber === 0,
      stack: 2_000,
      status: 'active' as const,
    })),
    hand: null,
    lastCompletedHandSummary: null,
  }
  return {
    protocolVersion: 1,
    eventId: '33333333-3333-4333-8333-333333333333',
    sessionId,
    eventSeq: 2,
    stateVersion: 1,
    type: 'snapshot',
    payload: { snapshot },
  }
}

function runtime(
  connection: OpenSessionEventStream,
  open = vi.fn(async () => connection),
) {
  const providerResponse = getProviderSettingsResponse(
    new ServerConfig({ port: 8787, databaseUrl: 'postgresql://runtime' }),
  )
  return {
    value: {
      health: { read: async () => ({}) },
      providerHealth: {
        read: () => providerResponse,
        check: async () => providerResponse,
      },
      playerAgentSettings: { read: async () => ({}), update: async () => ({}) },
      personaCatalog: loadAndValidatePersonaCatalog(),
      deletion: {
        deleteEndedSession: async () => ({}),
        clearAll: async () => ({}),
      },
      sessionEvents: { open },
    } as unknown as ApiRuntime,
    open,
  }
}

describe('M3.7 SSE API', () => {
  test('writes only id/data through one stream and forwards Last-Event-ID', async () => {
    const event = calibration()
    let closed = false
    let delivered = false
    const connection: OpenSessionEventStream = {
      get closed() {
        return closed
      },
      async waitForOutboundOrHeartbeat() {
        if (!delivered) {
          delivered = true
          return { kind: 'event', event }
        }
        closed = true
        return { kind: 'closed' }
      },
      close() {
        closed = true
      },
    }
    const fixture = runtime(connection)
    const logRequest = vi.fn()
    const app = createApp(fixture.value, {
      port: 8787,
      allowedOrigins: new Set([origin]),
      logRequest,
    })
    const response = await app.request(
      `${baseUrl}/api/sessions/${sessionId}/events`,
      { headers: { Origin: origin, 'Last-Event-ID': '1' } },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const body = await response.text()
    expect(body).toContain('id: 2')
    expect(body).toContain(`data: ${JSON.stringify(event)}`)
    expect(body).not.toContain('event:')
    expect(fixture.open).toHaveBeenCalledWith({
      sessionId,
      lastEventId: { kind: 'candidate', eventSeq: 1 },
      signal: expect.anything(),
    })
    expect(logRequest).toHaveBeenCalledWith(
      expect.objectContaining({ route: '/api/sessions/:sessionId/events' }),
    )
  })

  test('allows only Last-Event-ID for the event route preflight', async () => {
    const connection = {
      closed: true,
      waitForOutboundOrHeartbeat: vi.fn(),
      close: vi.fn(),
    }
    const app = createApp(runtime(connection as never).value, {
      port: 8787,
      allowedOrigins: new Set([origin]),
    })
    const response = await app.request(
      `${baseUrl}/api/sessions/${sessionId}/events`,
      {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'Last-Event-ID',
        },
      },
    )
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-headers')).toBe(
      'Last-Event-ID',
    )
  })

  test('aborts one blocked writer at its deadline without starting another write', async () => {
    vi.useFakeTimers()
    try {
      let resolveWrite!: () => void
      const write = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveWrite = resolve
          }),
      )
      const stream = { abort: vi.fn() }
      const connection = { close: vi.fn() }
      const result = writeBeforeDeadline({
        stream: stream as never,
        connection: connection as never,
        deadlineAt: Date.now() + 15_000,
        write,
        now: Date.now,
        setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimer: (handle) => clearTimeout(handle as never),
      })
      await vi.advanceTimersByTimeAsync(15_000)
      await expect(result).resolves.toBe(false)
      expect(write).toHaveBeenCalledOnce()
      expect(connection.close).toHaveBeenCalledOnce()
      expect(stream.abort).toHaveBeenCalledOnce()
      resolveWrite()
    } finally {
      vi.useRealTimers()
    }
  })
})
