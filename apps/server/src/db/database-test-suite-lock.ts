import { setTimeout as delay } from 'node:timers/promises'
import type { Sql } from 'postgres'
import { DATABASE_TEST_SUITE_LOCK_NAME } from './test-database-safety.js'

const DATABASE_TEST_SUITE_LOCK_LOST_MESSAGE =
  '数据库测试全局锁已丢失，已中止后续数据库写入。'

export interface DatabaseTestSuiteLock {
  readonly signal: AbortSignal
  release(): Promise<void>
}

export function bindDatabaseTestClientToSuiteLock(
  client: Pick<Sql, 'end'>,
  lock: Pick<DatabaseTestSuiteLock, 'signal'>,
): () => void {
  let termination: Promise<void> | null = null
  const terminateClient = (): void => {
    termination ??= client.end({ timeout: 0 })
    void termination.catch(() => undefined)
  }

  lock.signal.addEventListener('abort', terminateClient, { once: true })
  if (lock.signal.aborted) {
    terminateClient()
  }

  return () => lock.signal.removeEventListener('abort', terminateClient)
}

export async function acquireDatabaseTestSuiteLock(
  sql: Sql,
): Promise<DatabaseTestSuiteLock> {
  let reportAcquired!: (acquired: boolean) => void
  let reportAcquisitionFailure!: (error: unknown) => void
  const acquired = new Promise<boolean>((resolve, reject) => {
    reportAcquired = resolve
    reportAcquisitionFailure = reject
  })
  let releaseTransaction!: () => void
  const releaseRequested = new Promise<void>((resolve) => {
    releaseTransaction = resolve
  })
  let acquisitionSettled = false
  let lockAcquired = false
  let lockLoss: Error | null = null
  const lockLossController = new AbortController()
  const reportLockLoss = (): Error => {
    lockLoss ??= new Error(DATABASE_TEST_SUITE_LOCK_LOST_MESSAGE)
    lockLossController.abort(lockLoss)
    return lockLoss
  }
  const completion = sql
    .begin(async (transaction) => {
      const rows = await transaction<readonly { readonly acquired: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(
          hashtext(${DATABASE_TEST_SUITE_LOCK_NAME})
        ) AS acquired
      `
      lockAcquired = rows.length === 1 && rows[0]?.acquired === true
      acquisitionSettled = true
      reportAcquired(lockAcquired)
      if (!lockAcquired) return

      for (;;) {
        const release = await Promise.race([
          releaseRequested.then(() => true),
          delay(30_000, false, { ref: false }),
        ])
        if (release) return
        await transaction`SELECT 1`
      }
    })
    .catch((error: unknown) => {
      if (!acquisitionSettled) {
        reportAcquisitionFailure(error)
      } else if (lockAcquired) {
        reportLockLoss()
      }
      throw error
    })
  void completion.catch(() => undefined)

  if (!(await acquired)) {
    await completion
    throw new Error(
      '检测到另一套远程 PostgreSQL 测试正在运行。请等待其结束后再串行执行。',
    )
  }

  let releasePromise: Promise<void> | null = null
  return Object.freeze({
    signal: lockLossController.signal,
    release(): Promise<void> {
      releaseTransaction()
      releasePromise ??= completion.catch(() => {
        throw lockLoss ?? reportLockLoss()
      })
      return releasePromise
    },
  })
}
