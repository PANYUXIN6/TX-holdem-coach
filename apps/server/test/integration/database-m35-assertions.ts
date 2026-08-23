import type { Sql } from 'postgres'
import { expect } from 'vitest'
import { runDatabaseTransaction } from '../../src/persistence/database-transaction.js'
import { DatabaseOperationError } from '../../src/persistence/errors.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import {
  PLAYER_TIMEOUT_SETTING_KEY,
  patchPlayerTimeoutSettings,
  readResolvedPlayerTimeoutSettings,
} from '../../src/persistence/player-settings-repository.js'
import {
  createDatabaseTestSqlForRole,
  readTransactionBackendPid,
} from './database-test-runtime.js'

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

async function assertConcurrentSettingsPatches(
  firstSql: Sql,
  secondSql: Sql,
  observerSql: Sql,
  owner: Awaited<ReturnType<typeof resolveOwnerScope>>,
): Promise<void> {
  const releaseFirst = createDeferred<void>()
  const firstReady = createDeferred<
    | { readonly kind: 'ready' }
    | { readonly kind: 'failed'; readonly error: unknown }
  >()
  const secondReady = createDeferred<number>()
  const first = firstSql.begin(async (transaction) => {
    try {
      const result = await patchPlayerTimeoutSettings(transaction, owner, {
        attemptTimeoutSeconds: 20,
      })
      firstReady.resolve({ kind: 'ready' })
      await releaseFirst.promise
      return result
    } catch (error) {
      firstReady.resolve({ kind: 'failed', error })
      throw error
    }
  })
  void first.catch((error: unknown) =>
    firstReady.resolve({ kind: 'failed', error }),
  )
  const firstReadiness = await firstReady.promise
  if (firstReadiness.kind === 'failed') throw firstReadiness.error

  const second = secondSql.begin(async (transaction) => {
    secondReady.resolve(await readTransactionBackendPid(transaction))
    return patchPlayerTimeoutSettings(transaction, owner, {
      decisionDeadlineSeconds: 90,
    })
  })
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

  await expect(
    readResolvedPlayerTimeoutSettings(firstSql, owner),
  ).resolves.toEqual({
    attemptTimeoutSeconds: 20,
    decisionDeadlineSeconds: 90,
  })
}

export async function assertM35AtomicPlayerSettingsPersistence(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const owner = await resolveOwnerScope(sql, { ownerId: 'local-user' })
  const secondSql = createDatabaseTestSqlForRole(runtimeUrl, 'm35-settings')
  const observerSql = createDatabaseTestSqlForRole(runtimeUrl, 'm35-observer')
  try {
    await deleteSettingsRow(sql, owner.databaseOwnerId)
    await expect(
      readResolvedPlayerTimeoutSettings(sql, owner),
    ).resolves.toEqual({
      attemptTimeoutSeconds: 15,
      decisionDeadlineSeconds: 45,
    })

    await sql.begin((transaction) =>
      patchPlayerTimeoutSettings(transaction, owner, {
        attemptTimeoutSeconds: 10,
        decisionDeadlineSeconds: 60,
      }),
    )
    await assertConcurrentSettingsPatches(sql, secondSql, observerSql, owner)

    await deleteSettingsRow(sql, owner.databaseOwnerId)
    await assertConcurrentSettingsPatches(sql, secondSql, observerSql, owner)
    await expect(
      sql<{ readonly count: number }[]>`
        SELECT count(*)::int AS count
        FROM app_private.app_settings
        WHERE owner_id = ${owner.databaseOwnerId}::uuid
          AND setting_key = ${PLAYER_TIMEOUT_SETTING_KEY}
      `,
    ).resolves.toEqual([{ count: 1 }])

    const invalidSessionId = crypto.randomUUID()
    await expect(
      runDatabaseTransaction(sql, async (transaction) => {
        const result = await patchPlayerTimeoutSettings(transaction, owner, {
          attemptTimeoutSeconds: 26,
        })
        await transaction`
          INSERT INTO app_private.sessions (id, owner_id)
          VALUES (
            ${invalidSessionId}::uuid,
            ${owner.databaseOwnerId}::uuid
          )
        `
        return result
      }),
    ).rejects.toBeInstanceOf(DatabaseOperationError)
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
      attemptTimeoutSeconds: 20,
      decisionDeadlineSeconds: 90,
    })
  } finally {
    await deleteSettingsRow(sql, owner.databaseOwnerId)
    await Promise.all([
      secondSql.end({ timeout: 0 }),
      observerSql.end({ timeout: 0 }),
    ])
  }
}
