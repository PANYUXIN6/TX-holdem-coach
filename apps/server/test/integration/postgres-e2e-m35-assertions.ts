import type { Sql } from 'postgres'
import { expect } from 'vitest'
import { getProviderSettingsResponse, ServerConfig } from '../../src/config.js'
import { createApp, type ApiRuntime } from '../../src/http/create-app.js'
import { loadAndValidatePersonaCatalog } from '../../src/personas/catalog.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import {
  PLAYER_TIMEOUT_SETTING_KEY,
  readResolvedPlayerTimeoutSettings,
} from '../../src/persistence/player-settings-repository.js'
import { createPlayerAgentSettingsService } from '../../src/settings/player-agent-settings-service.js'

const ORIGIN = 'http://localhost:5173'
const BASE_URL = 'http://127.0.0.1:8787'

const unavailableSessionHttp = {
  creation: {
    async create() {
      throw new Error('unavailable')
    },
  },
  query: {
    async findActive() {
      return null
    },
    async getById() {
      return null
    },
  },
  commands: {
    async execute() {
      throw new Error('unavailable')
    },
  },
} as never

const unavailableSessionEvents = {
  async open() {
    throw new Error('unavailable')
  },
} as never

async function deleteSettingsRow(sql: Sql, databaseOwnerId: string) {
  await sql`
    DELETE FROM app_private.app_settings
    WHERE owner_id = ${databaseOwnerId}::uuid
      AND setting_key = ${PLAYER_TIMEOUT_SETTING_KEY}
  `
}

export async function assertM35SettingsHttpPostgresSmoke(
  sql: Sql,
): Promise<void> {
  const owner = await resolveOwnerScope(sql, { ownerId: 'local-user' })
  try {
    await deleteSettingsRow(sql, owner.databaseOwnerId)
    const providerResponse = getProviderSettingsResponse(
      new ServerConfig({ port: 8787, databaseUrl: 'postgresql://runtime' }),
    )
    const runtime = {
      health: {
        read: async () => ({
          status: 'ok' as const,
          database: 'available' as const,
        }),
      },
      providerHealth: {
        read: () => providerResponse,
        check: async () => providerResponse,
      },
      playerAgentSettings: createPlayerAgentSettingsService({ sql, owner }),
      personaCatalog: loadAndValidatePersonaCatalog(),
      deletion: {
        deleteEndedSession: async () => ({
          deletedSessionId: crypto.randomUUID(),
          invalidatedRunCount: 0,
        }),
        clearAll: async () => ({
          deletedSessionCount: 0,
          invalidatedRunCount: 0,
        }),
      },
      sessionHttp: unavailableSessionHttp,
      sessionEvents: unavailableSessionEvents,
    } satisfies ApiRuntime
    const app = createApp(runtime, {
      port: 8787,
      allowedOrigins: new Set([ORIGIN]),
    })

    const defaults = await app.request(`${BASE_URL}/api/settings/agent`)
    expect(defaults.status).toBe(200)
    expect(await defaults.json()).toMatchObject({
      settings: {
        attemptTimeoutSeconds: 15,
        decisionDeadlineSeconds: 45,
      },
    })

    const updated = await app.request(`${BASE_URL}/api/settings/agent`, {
      method: 'PATCH',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        settings: { attemptTimeoutSeconds: 25 },
      }),
    })
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({
      settings: {
        attemptTimeoutSeconds: 25,
        decisionDeadlineSeconds: 45,
      },
    })
    await expect(
      readResolvedPlayerTimeoutSettings(sql, owner),
    ).resolves.toEqual({
      attemptTimeoutSeconds: 25,
      decisionDeadlineSeconds: 45,
    })
  } finally {
    await deleteSettingsRow(sql, owner.databaseOwnerId)
  }
}
