import { randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import { expect } from 'vitest'
import { createApp } from '../../src/app.js'
import { createApiRuntime } from '../../src/bootstrap.js'
import { ServerConfig } from '../../src/config.js'
import { loadAndValidatePersonaCatalog } from '../../src/personas/catalog.js'
import {
  clearLocalOwnerSessions,
  currentCatalogRequest,
} from './database-m32-assertions.js'

const ORIGIN = 'http://localhost:5173'
const BASE_URL = 'http://127.0.0.1:8787'

export async function assertM36PublicProjectionRuntime(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  await clearLocalOwnerSessions(sql)
  try {
    const runtime = await createApiRuntime(
      new ServerConfig({
        port: 8787,
        databaseUrl: runtimeUrl,
        deepSeekApiKey: 'm36-fake-provider-key',
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
    expect(createdBody.snapshot.eventSeq).toBe(1)

    const active = await app.request(`${BASE_URL}/api/sessions/active`)
    const byId = await app.request(
      `${BASE_URL}/api/sessions/${createdBody.snapshot.sessionId}`,
    )
    expect(active.status).toBe(200)
    expect(byId.status).toBe(200)
    expect(await active.json()).toEqual(await byId.json())

    const rows = await sql<
      { readonly eventSeq: number; readonly publicEvent: unknown }[]
    >`
    SELECT event_seq::float8 AS "eventSeq", public_event_payload AS "publicEvent"
    FROM app_private.session_events
    WHERE session_id = ${createdBody.snapshot.sessionId}::uuid
    ORDER BY event_seq
  `
    expect(rows.map((row) => row.eventSeq)).toEqual([0, 1])
    const serialized = JSON.stringify(rows)
    for (const forbidden of [
      'remainingDeck',
      'burnedCards',
      'legalActionsBefore',
      'privateEventPayload',
      'configPayload',
    ]) {
      expect(serialized).not.toContain(forbidden)
    }

    const beforeLedger = await sql<{ readonly count: number }[]>`
    SELECT count(*)::int AS count FROM app_private.command_ledger
    WHERE session_id = ${createdBody.snapshot.sessionId}::uuid
  `
    const retry = await app.request(
      `${BASE_URL}/api/sessions/${createdBody.snapshot.sessionId}/commands`,
      {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          protocolVersion: 1,
          command: {
            sessionId: createdBody.snapshot.sessionId,
            commandId: randomUUID(),
            expectedStateVersion: 1,
            type: 'retryAgent',
            payload: {},
          },
        }),
      },
    )
    expect(retry.status).toBe(409)
    await expect(retry.json()).resolves.toMatchObject({
      code: 'COMMAND_NOT_ALLOWED_IN_PHASE',
    })
    const afterLedger = await sql<{ readonly count: number }[]>`
    SELECT count(*)::int AS count FROM app_private.command_ledger
    WHERE session_id = ${createdBody.snapshot.sessionId}::uuid
  `
    expect(afterLedger[0]?.count).toBe(beforeLedger[0]?.count)

    await sql`
      DELETE FROM app_private.session_snapshots
      WHERE session_id = ${createdBody.snapshot.sessionId}::uuid
    `
    const missingSnapshot = await app.request(
      `${BASE_URL}/api/sessions/${createdBody.snapshot.sessionId}`,
    )
    expect(missingSnapshot.status).toBe(500)
    await expect(missingSnapshot.json()).resolves.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    })

    await sql`
      UPDATE app_private.sessions
      SET lifecycle_status = 'readonlyDiagnostic',
          diagnostic_code = 'snapshotMissing',
          diagnosed_at = now(),
          updated_at = now()
      WHERE id = ${createdBody.snapshot.sessionId}::uuid
    `
    const readonlyDiagnostic = await app.request(
      `${BASE_URL}/api/sessions/${createdBody.snapshot.sessionId}`,
    )
    expect(readonlyDiagnostic.status).toBe(409)
    await expect(readonlyDiagnostic.json()).resolves.toMatchObject({
      code: 'SESSION_READONLY_DIAGNOSTIC',
    })
  } finally {
    await clearLocalOwnerSessions(sql)
  }
}
