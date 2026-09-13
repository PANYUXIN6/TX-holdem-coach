import type { SseEvent } from '@tx-holdem-coach/contracts'
import type { Sql } from 'postgres'
import { expect } from 'vitest'
import { createApp } from '../../src/http/create-app.js'
import { createApiRuntime } from '../../src/bootstrap.js'
import { ServerConfig } from '../../src/config.js'
import { loadAndValidatePersonaCatalog } from '../../src/personas/catalog.js'
import {
  clearLocalOwnerSessions,
  currentCatalogRequest,
} from './database-m32-assertions.js'

const ORIGIN = 'http://localhost:5173'
const BASE_URL = 'http://127.0.0.1:8787'

async function readDataEvents(
  response: Response,
  count: number,
): Promise<readonly SseEvent[]> {
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error('SSE response has no body')
  const decoder = new TextDecoder()
  let buffer = ''
  const events: SseEvent[] = []
  try {
    while (events.length < count) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      while (buffer.includes('\n\n')) {
        const boundary = buffer.indexOf('\n\n')
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = frame
          .split('\n')
          .find((line) => line.startsWith('data: '))
          ?.slice(6)
        if (data !== undefined) events.push(JSON.parse(data) as SseEvent)
      }
    }
  } finally {
    await reader.cancel()
  }
  return events
}

export async function assertM37SessionEventReplay(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  await clearLocalOwnerSessions(sql)
  try {
    const runtime = await createApiRuntime(
      new ServerConfig({
        port: 8787,
        databaseUrl: runtimeUrl,
        deepSeekApiKey: 'm37-fake-provider-key',
      }),
      loadAndValidatePersonaCatalog(),
      { sql, db: {} as never, close: async () => {} },
    )
    const app = createApp(runtime, {
      port: 8787,
      allowedOrigins: new Set([ORIGIN]),
    })
    const created = await app.request(`${BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify(currentCatalogRequest(5)),
    })
    expect(created.status).toBe(201)
    const createdBody = (await created.json()) as {
      readonly snapshot: {
        readonly sessionId: string
        readonly eventSeq: number
      }
    }

    // A persisted pre-M7.4 event has no display block. Preserve its replay,
    // while calibration is regenerated from the current private state.
    await sql`
      UPDATE app_private.session_events
      SET public_event_payload = public_event_payload #- '{payload,snapshot,tableDisplay}'
      WHERE session_id = ${createdBody.snapshot.sessionId}::uuid
    `

    const replayResponse = await app.request(
      `${BASE_URL}/api/sessions/${createdBody.snapshot.sessionId}/events`,
      { headers: { Origin: ORIGIN, 'Last-Event-ID': '0' } },
    )
    expect(replayResponse.status).toBe(200)
    const replay = await readDataEvents(replayResponse, 2)
    expect(replay.map((event) => [event.eventSeq, event.type])).toEqual([
      [1, 'handStarted'],
      [1, 'snapshot'],
    ])

    expect(replay[0]!.payload.snapshot.tableDisplay).toBeUndefined()
    expect(replay[1]!.payload.snapshot.tableDisplay).toMatchObject({
      completedHandCount: 0,
      blinds: { smallBlind: 10, bigBlind: 20 },
    })

    const initialResponse = await app.request(
      `${BASE_URL}/api/sessions/${createdBody.snapshot.sessionId}/events`,
      { headers: { Origin: ORIGIN } },
    )
    const initial = await readDataEvents(initialResponse, 1)
    expect(initial.map((event) => [event.eventSeq, event.type])).toEqual([
      [1, 'snapshot'],
    ])
  } finally {
    await clearLocalOwnerSessions(sql)
  }
}
