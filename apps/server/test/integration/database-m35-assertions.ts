import type { PublicSessionSnapshot } from '@tx-holdem-coach/contracts'
import type { Sql, TransactionSql } from 'postgres'
import { expect } from 'vitest'
import { createApp } from '../../src/app.js'
import { ServerConfig } from '../../src/config.js'
import { createHealthService } from '../../src/http/health-service.js'
import { loadAndValidatePersonaCatalog } from '../../src/personas/catalog.js'
import { runDatabaseTransaction } from '../../src/persistence/database-transaction.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import {
  PLAYER_TIMEOUT_SETTING_KEY,
  readResolvedPlayerTimeoutSettings,
  writePlayerTimeoutSettings,
} from '../../src/persistence/player-settings-repository.js'
import { createProviderHealthService } from '../../src/providers/provider-health-service.js'
import { createProviderCheckTransport } from '../../src/providers/provider-check-transport.js'
import { createPlayerAgentSettingsService } from '../../src/settings/player-agent-settings-service.js'
import type { PlayerAgentSettingsService } from '../../src/settings/player-agent-settings-service.js'
import { createSessionDataDeletionService } from '../../src/sessions/session-data-deletion-service.js'
import {
  clearLocalOwnerSessions,
  createM32Service,
  currentCatalogRequest,
} from './database-m32-assertions.js'
import { createM34Executor } from './database-m34-assertions.js'
import {
  createM33Executor,
  prepareTerminalUserTurn,
} from './database-m33-assertions.js'
import {
  createDatabaseTestSqlForRole,
  readTransactionBackendPid,
} from './database-test-runtime.js'

const ORIGIN = 'http://localhost:5173'
const BASE_URL = 'http://127.0.0.1:8787'

async function deleteSettingsRow(sql: Sql, databaseOwnerId: string) {
  await sql`
    DELETE FROM app_private.app_settings
    WHERE owner_id = ${databaseOwnerId}::uuid
      AND setting_key = ${PLAYER_TIMEOUT_SETTING_KEY}
  `
}

function createDeferred<Value>() {
  let resolvePromise: ((value: Value) => void) | undefined
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve(value: Value) {
      resolvePromise?.(value)
    },
  }
}

async function waitForBlockedTransaction(
  observerSql: Sql,
  backendPid: number,
): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const rows = await observerSql<
      { readonly blockingPids: readonly number[] }[]
    >`
      SELECT pg_blocking_pids(${backendPid}) AS "blockingPids"
    `
    if ((rows[0]?.blockingPids.length ?? 0) > 0) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('M3.5 未观察到第二个设置事务等待第一个事务。')
}

function transactionSql(
  begin: (
    operation: (transaction: TransactionSql) => Promise<unknown>,
  ) => Promise<unknown>,
): Sql {
  return { begin } as unknown as Sql
}

function playerSettingsRequest(
  settings: Readonly<{
    attemptTimeoutSeconds?: number
    decisionDeadlineSeconds?: number
  }>,
): RequestInit {
  return {
    method: 'PATCH',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings }),
  }
}

async function assertConcurrentHttpPatches(
  firstSql: Sql,
  secondSql: Sql,
  observerSql: Sql,
  owner: Awaited<ReturnType<typeof resolveOwnerScope>>,
  createSettingsApp: (
    settings: PlayerAgentSettingsService,
  ) => ReturnType<typeof createApp>,
): Promise<void> {
  const releaseFirst = createDeferred<void>()
  const firstReady = createDeferred<unknown | null>()
  const secondReady = createDeferred<number>()
  const firstService = createPlayerAgentSettingsService({
    sql: transactionSql((operation) =>
      firstSql.begin(async (transaction) => {
        try {
          const result = await operation(transaction)
          firstReady.resolve(null)
          await releaseFirst.promise
          return result
        } catch (error) {
          firstReady.resolve(error)
          throw error
        }
      }),
    ),
    owner,
  })
  const secondService = createPlayerAgentSettingsService({
    sql: transactionSql((operation) =>
      secondSql.begin(async (transaction) => {
        secondReady.resolve(await readTransactionBackendPid(transaction))
        return operation(transaction)
      }),
    ),
    owner,
  })
  const first = Promise.resolve(
    createSettingsApp(firstService).request(
      `${BASE_URL}/api/settings/agent`,
      playerSettingsRequest({ attemptTimeoutSeconds: 20 }),
    ),
  )
  void first.catch((error: unknown) => firstReady.resolve(error))
  const firstFailure = await firstReady.promise
  if (firstFailure !== null) throw firstFailure

  const second = Promise.resolve(
    createSettingsApp(secondService).request(
      `${BASE_URL}/api/settings/agent`,
      playerSettingsRequest({ decisionDeadlineSeconds: 90 }),
    ),
  )
  void second.catch(() => secondReady.resolve(-1))
  const secondBackendPid = await secondReady.promise
  if (secondBackendPid < 0) {
    releaseFirst.resolve()
    const results = await Promise.allSettled([first, second])
    const rejected = results.find((result) => result.status === 'rejected')
    if (rejected?.status === 'rejected') throw rejected.reason
    throw new Error('M3.5 第二个设置事务未能启动。')
  }
  let blockingFailure: unknown
  try {
    await waitForBlockedTransaction(observerSql, secondBackendPid)
  } catch (error) {
    blockingFailure = error
  } finally {
    releaseFirst.resolve()
  }
  const results = await Promise.allSettled([first, second])
  if (blockingFailure !== undefined) throw blockingFailure
  const rejected = results.find((result) => result.status === 'rejected')
  if (rejected?.status === 'rejected') throw rejected.reason
  for (const result of results) {
    if (result.status === 'fulfilled') expect(result.value.status).toBe(200)
  }

  await expect(
    readResolvedPlayerTimeoutSettings(firstSql, owner),
  ).resolves.toEqual({
    attemptTimeoutSeconds: 20,
    decisionDeadlineSeconds: 90,
  })
}

export async function assertM35HttpAndAtomicSettings(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const owner = await resolveOwnerScope(sql, { ownerId: 'local-user' })
  const secondSql = createDatabaseTestSqlForRole(runtimeUrl, 'm35-settings')
  const observerSql = createDatabaseTestSqlForRole(runtimeUrl, 'm35-observer')
  try {
    await clearLocalOwnerSessions(sql)
    await deleteSettingsRow(sql, owner.databaseOwnerId)
    const providerFetch = async () =>
      Response.json({ data: [{ id: 'deepseek-v4-flash' }] })
    const config = new ServerConfig({
      port: 8787,
      databaseUrl: runtimeUrl,
      deepSeekApiKey: 'm35-fake-provider-key',
    })
    const providerHealth = createProviderHealthService({
      config,
      transport: createProviderCheckTransport({ fetch: providerFetch }),
      now: () => '2026-08-12T00:00:00.000Z',
    })
    const personaCatalog = loadAndValidatePersonaCatalog()
    const deletion = createSessionDataDeletionService({ sql, owner })
    const createSettingsApp = (settings: PlayerAgentSettingsService) =>
      createApp(
        {
          health: createHealthService(sql),
          providerHealth,
          playerAgentSettings: settings,
          personaCatalog,
          deletion,
        },
        { port: 8787, allowedOrigins: new Set([ORIGIN]) },
      )
    const defaultSettings = await createSettingsApp(
      createPlayerAgentSettingsService({ sql, owner }),
    ).request(`${BASE_URL}/api/settings/agent`)
    expect(defaultSettings.status).toBe(200)
    expect(await defaultSettings.json()).toMatchObject({
      settings: {
        attemptTimeoutSeconds: 15,
        decisionDeadlineSeconds: 45,
      },
    })

    await writePlayerTimeoutSettings(
      sql,
      { ownerId: 'local-user' },
      {
        attemptTimeoutSeconds: 10,
        decisionDeadlineSeconds: 60,
      },
    )
    await assertConcurrentHttpPatches(
      sql,
      secondSql,
      observerSql,
      owner,
      createSettingsApp,
    )

    const restartedSettingsApp = createSettingsApp(
      createPlayerAgentSettingsService({ sql, owner }),
    )
    const restartedSettings = await restartedSettingsApp.request(
      `${BASE_URL}/api/settings/agent`,
    )
    expect(restartedSettings.status).toBe(200)
    expect(await restartedSettings.json()).toMatchObject({
      settings: {
        attemptTimeoutSeconds: 20,
        decisionDeadlineSeconds: 90,
      },
    })

    await deleteSettingsRow(sql, owner.databaseOwnerId)
    await assertConcurrentHttpPatches(
      sql,
      secondSql,
      observerSql,
      owner,
      createSettingsApp,
    )
    const rows = await sql<{ readonly count: number }[]>`
      SELECT count(*)::int AS count
      FROM app_private.app_settings
      WHERE owner_id = ${owner.databaseOwnerId}::uuid
        AND setting_key = ${PLAYER_TIMEOUT_SETTING_KEY}
    `
    expect(rows).toEqual([{ count: 1 }])

    let createdSessionId: string | undefined
    let createdIdentity:
      Parameters<typeof prepareTerminalUserTurn>[2] | undefined
    let plannedIdentity:
      Parameters<typeof prepareTerminalUserTurn>[2] | undefined
    let latestSnapshot: PublicSessionSnapshot | null = null
    const creation = createM32Service(sql, (identity) => {
      plannedIdentity = identity
    })
    let commands: ReturnType<typeof createM34Executor> | undefined
    const app = createApp(
      {
        health: createHealthService(sql),
        providerHealth,
        playerAgentSettings: createPlayerAgentSettingsService({ sql, owner }),
        personaCatalog,
        deletion,
        sessionHttp: {
          creation: {
            async create(request) {
              const result = await creation.create(request)
              if (result.kind === 'created') {
                if (plannedIdentity === undefined) {
                  throw new Error('M3.5 创建场次未捕获 identity。')
                }
                createdIdentity = plannedIdentity
                latestSnapshot = result.response.snapshot
                createdSessionId = result.response.snapshot.sessionId
                commands = createM34Executor({
                  sql,
                  owner,
                  nextHandId: crypto.randomUUID(),
                  commandAt: '2026-08-12T00:01:00.000Z',
                })
              }
              return result
            },
          },
          query: {
            findActive: async () =>
              latestSnapshot?.lifecycleStatus === 'active'
                ? latestSnapshot
                : null,
            getById: async (sessionId) =>
              latestSnapshot?.sessionId === sessionId ? latestSnapshot : null,
          },
          commands: {
            async execute(command) {
              if (commands === undefined) {
                throw new Error('M3.5 命令执行器尚未绑定。')
              }
              const result = await commands.execute(command)
              if (result.kind === 'completed') {
                latestSnapshot = result.response.snapshot
              } else if (
                result.kind === 'rejected' &&
                result.response.latestSnapshot !== undefined
              ) {
                latestSnapshot = result.response.latestSnapshot
              }
              return result
            },
          },
        },
      },
      { port: 8787, allowedOrigins: new Set([ORIGIN]) },
    )
    const health = await app.request(`${BASE_URL}/api/health`)
    expect(health.status).toBe(200)
    const update = await app.request(`${BASE_URL}/api/settings/agent`, {
      method: 'PATCH',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        settings: { attemptTimeoutSeconds: 25 },
      }),
    })
    expect(update.status).toBe(200)
    expect(await update.json()).toMatchObject({
      settings: {
        attemptTimeoutSeconds: 25,
        decisionDeadlineSeconds: 90,
      },
    })

    const personas = await app.request(`${BASE_URL}/api/agent-personas`)
    expect(personas.status).toBe(200)
    expect(await personas.json()).toMatchObject({
      personas: expect.arrayContaining([
        expect.objectContaining({ personaId: 'nit_fish' }),
      ]),
    })
    await sql.begin(async (transaction) => {
      const writes = async () => {
        const rows = await transaction<{ readonly writes: number }[]>`
          SELECT coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0)::int AS writes
          FROM pg_stat_xact_user_tables
          WHERE schemaname = 'app_private'
        `
        return rows[0]?.writes
      }
      const before = await writes()
      const detail = await app.request(
        `${BASE_URL}/api/agent-personas/nit_fish`,
      )
      expect(detail.status).toBe(200)
      expect(await writes()).toBe(before)
    })

    const provider = await app.request(
      `${BASE_URL}/api/settings/providers/deepseek/check`,
      {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
    )
    expect(provider.status).toBe(200)
    expect(await provider.json()).toMatchObject({
      deepSeek: { checkStatus: 'available', errorCode: null },
    })

    const createBody = JSON.stringify(currentCatalogRequest(5))
    const created = await app.request(`${BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: createBody,
    })
    expect(created.status).toBe(201)
    const createdBody = (await created.json()) as {
      readonly snapshot: { readonly sessionId: string }
    }
    expect(createdBody.snapshot.sessionId).toBe(createdSessionId)

    const activeConflict = await app.request(`${BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: createBody,
    })
    expect(activeConflict.status).toBe(409)
    expect(await activeConflict.json()).toMatchObject({
      code: 'ACTIVE_SESSION_EXISTS',
    })

    const active = await app.request(`${BASE_URL}/api/sessions/active`)
    expect(active.status).toBe(200)
    if (createdSessionId === undefined) {
      throw new Error('M3.5 缺少创建场次 ID。')
    }
    if (createdIdentity === undefined) {
      throw new Error('M3.5 缺少创建 identity。')
    }

    const activeDelete = await app.request(
      `${BASE_URL}/api/sessions/${createdSessionId}`,
      {
        method: 'DELETE',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirmation: '永久删除本场',
        }),
      },
    )
    expect(activeDelete.status).toBe(409)
    expect(await activeDelete.json()).toMatchObject({
      code: 'SESSION_NOT_ENDED',
    })

    const sessionsBeforeInvalidConfirmation = await sql<
      { readonly count: number }[]
    >`
      SELECT count(*)::int AS count
      FROM app_private.sessions
      WHERE owner_id = ${owner.databaseOwnerId}::uuid
    `
    const invalidConfirmation = await app.request(`${BASE_URL}/api/data`, {
      method: 'DELETE',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: '清空' }),
    })
    expect(invalidConfirmation.status).toBe(400)
    await expect(
      sql<{ readonly count: number }[]>`
        SELECT count(*)::int AS count
        FROM app_private.sessions
        WHERE owner_id = ${owner.databaseOwnerId}::uuid
      `,
    ).resolves.toEqual(sessionsBeforeInvalidConfirmation)
    const terminal = await prepareTerminalUserTurn(sql, owner, createdIdentity)
    const handCompleted = await createM33Executor({ sql, owner }).execute({
      sessionId: createdSessionId,
      commandId: crypto.randomUUID(),
      expectedStateVersion: terminal.state.stateVersion,
      type: 'playerAction',
      payload: { action: { type: 'fold' } },
    })
    if (handCompleted.kind !== 'completed') {
      throw new Error('M3.5 未能完成首手。')
    }
    latestSnapshot = handCompleted.response.snapshot

    const commandId = crypto.randomUUID()
    const command = {
      command: {
        sessionId: createdSessionId,
        commandId,
        expectedStateVersion: handCompleted.response.snapshot.stateVersion,
        type: 'endSession',
        payload: {},
      },
    }
    const completed = await app.request(
      `${BASE_URL}/api/sessions/${createdSessionId}/commands`,
      {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify(command),
      },
    )
    expect(completed.status).toBe(200)
    expect(await completed.json()).toMatchObject({
      snapshot: { lifecycleStatus: 'ended' },
    })

    const replay = await app.request(
      `${BASE_URL}/api/sessions/${createdSessionId}/commands`,
      {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify(command),
      },
    )
    expect(replay.status).toBe(200)

    const payloadConflict = await app.request(
      `${BASE_URL}/api/sessions/${createdSessionId}/commands`,
      {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...command,
          command: { ...command.command, expectedStateVersion: 2 },
        }),
      },
    )
    expect(payloadConflict.status).toBe(409)
    expect(await payloadConflict.json()).toMatchObject({
      code: 'COMMAND_ID_CONFLICT',
    })

    const deleted = await app.request(
      `${BASE_URL}/api/sessions/${createdSessionId}`,
      {
        method: 'DELETE',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirmation: '永久删除本场',
        }),
      },
    )
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toMatchObject({
      deletedSessionId: createdSessionId,
    })

    const secondCreated = await app.request(`${BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: createBody,
    })
    expect(secondCreated.status).toBe(201)
    const cleared = await app.request(`${BASE_URL}/api/data`, {
      method: 'DELETE',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confirmation: '永久清空全部数据',
      }),
    })
    expect(cleared.status).toBe(200)
    expect(await cleared.json()).toMatchObject({ deletedSessionCount: 1 })
    await expect(
      sql<{ readonly count: number }[]>`
        SELECT count(*)::int AS count
        FROM app_private.sessions
        WHERE owner_id = ${owner.databaseOwnerId}::uuid
      `,
    ).resolves.toEqual([{ count: 0 }])

    const invalidSessionId = crypto.randomUUID()
    const shellFailureSettings = createPlayerAgentSettingsService({
      sql: transactionSql((operation) =>
        runDatabaseTransaction(sql, async (transaction) => {
          const result = await operation(transaction)
          await transaction`
            INSERT INTO app_private.sessions (id, owner_id)
            VALUES (
              ${invalidSessionId}::uuid,
              ${owner.databaseOwnerId}::uuid
            )
          `
          return result
        }),
      ),
      owner,
    })
    const shellFailureResponse = await createSettingsApp(
      shellFailureSettings,
    ).request(
      `${BASE_URL}/api/settings/agent`,
      playerSettingsRequest({ attemptTimeoutSeconds: 26 }),
    )
    expect(shellFailureResponse.status).toBe(503)
    const shellFailureBody = await shellFailureResponse.text()
    expect(shellFailureBody).toContain('SERVICE_UNAVAILABLE')
    expect(shellFailureBody).not.toContain('invalid participant roster')
    await expect(
      sql<{ readonly count: number }[]>`
        SELECT count(*)::int AS count
        FROM app_private.sessions
        WHERE id = ${invalidSessionId}::uuid
      `,
    ).resolves.toEqual([{ count: 0 }])
    await expect(
      readResolvedPlayerTimeoutSettings(sql, owner),
    ).resolves.toEqual({
      attemptTimeoutSeconds: 25,
      decisionDeadlineSeconds: 90,
    })

    const failingQuery = Object.assign(
      Promise.reject(new Error('private database failure detail')),
      { cancel() {} },
    )
    const failingSql = (() => failingQuery) as unknown as Sql
    const failureApp = createApp(
      {
        health: createHealthService(failingSql),
        providerHealth,
        playerAgentSettings: createPlayerAgentSettingsService({ sql, owner }),
        personaCatalog: loadAndValidatePersonaCatalog(),
        deletion: createSessionDataDeletionService({ sql, owner }),
      },
      { port: 8787, allowedOrigins: new Set([ORIGIN]) },
    )
    const unavailable = await failureApp.request(`${BASE_URL}/api/health`)
    expect(unavailable.status).toBe(503)
    const unavailableBody = await unavailable.text()
    expect(unavailableBody).toContain('SERVICE_UNAVAILABLE')
    expect(unavailableBody).not.toContain('private database failure detail')
  } finally {
    await clearLocalOwnerSessions(sql)
    await deleteSettingsRow(sql, owner.databaseOwnerId)
    await Promise.all([
      secondSql.end({ timeout: 0 }),
      observerSql.end({ timeout: 0 }),
    ])
  }
}
