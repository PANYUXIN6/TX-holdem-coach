import { setTimeout as delay } from 'node:timers/promises'
import postgres, { type Sql } from 'postgres'
import { parseSupabaseDatabaseUrl } from './database-url-policy.js'
import {
  DATABASE_TEST_APPLICATION_PREFIX,
  DATABASE_TEST_SUITE_LOCK_NAME,
} from './test-database-safety.js'

const DATABASE_TEST_SUITE_LOCK_LOST_MESSAGE =
  '数据库测试全局锁已丢失，已中止后续数据库写入。'
const DATABASE_TEST_SUITE_LOCK_HEARTBEAT_MS = 30_000
const DATABASE_TEST_SUITE_LOCK_CONFLICT_MESSAGE =
  '检测到另一套远程 PostgreSQL 测试正在运行。请等待其结束后再串行执行。'

export interface DatabaseTestSuiteLockReporter {
  readonly write: (message: string) => void
}

export interface DatabaseTestSuiteLockAcquireOptions {
  readonly heartbeatIntervalMs?: number
  readonly reporter?: DatabaseTestSuiteLockReporter
}

export interface DatabaseTestSuiteLock {
  readonly signal: AbortSignal
  release(): Promise<void>
}

export interface DatabaseTestSuiteLockClient {
  readonly applicationName: string
  readonly connectionClosedSignal: AbortSignal
  readonly sql: Sql
}

export function createDatabaseTestSuiteLockClient(
  url: string,
  runId: string,
): DatabaseTestSuiteLockClient {
  if (!/^[a-f0-9]{16}$/.test(runId)) {
    throw new Error('数据库测试 Run ID 无效。')
  }
  parseSupabaseDatabaseUrl(url, 'migration')
  const applicationName = `${DATABASE_TEST_APPLICATION_PREFIX}:${runId}:suite-lock`
  const connectionClosedController = new AbortController()
  const sql = postgres(url, {
    connect_timeout: 30,
    idle_timeout: 0,
    max: 1,
    max_lifetime: 0,
    prepare: false,
    ssl: 'require',
    connection: {
      application_name: applicationName,
      statement_timeout: 90_000,
      idle_in_transaction_session_timeout: 60_000,
    },
    onclose: () => {
      connectionClosedController.abort(
        new Error('数据库测试全局锁连接已关闭。'),
      )
    },
  })
  return Object.freeze({
    applicationName,
    connectionClosedSignal: connectionClosedController.signal,
    sql,
  })
}

function describeSuiteLockFailure(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return 'UnknownLockFailure'
  }
  const name =
    'name' in error &&
    typeof error.name === 'string' &&
    /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name)
      ? error.name
      : 'LockFailure'
  const code =
    'code' in error &&
    typeof error.code === 'string' &&
    /^[A-Za-z0-9_]{1,64}$/.test(error.code)
      ? error.code
      : null
  return code === null ? name : `${name}(code=${code})`
}

function waitForAbort(signal: AbortSignal): {
  readonly promise: Promise<never>
  dispose(): void
} {
  let rejectFromAbort!: () => void
  const promise = new Promise<never>((_resolve, reject) => {
    rejectFromAbort = () =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error('数据库测试全局锁连接已关闭。'),
      )
    signal.addEventListener('abort', rejectFromAbort, { once: true })
    if (signal.aborted) rejectFromAbort()
  })
  return {
    promise,
    dispose: () => signal.removeEventListener('abort', rejectFromAbort),
  }
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
  client: DatabaseTestSuiteLockClient,
  options: DatabaseTestSuiteLockAcquireOptions = {},
): Promise<DatabaseTestSuiteLock> {
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? DATABASE_TEST_SUITE_LOCK_HEARTBEAT_MS
  if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1) {
    throw new TypeError('数据库测试全局锁心跳周期无效。')
  }
  const reporter =
    options.reporter ??
    Object.freeze({
      write: (message: string) => process.stderr.write(message),
    })
  const reserved = await client.sql.reserve()
  let lockAcquired = false
  let reservedReleased = false
  let backendPid: number
  try {
    const settingRows = await reserved<
      readonly { readonly applicationName: string }[]
    >`
      SELECT
        set_config('application_name', ${client.applicationName}, false)
          AS "applicationName",
        set_config('statement_timeout', '90s', false),
        set_config('idle_in_transaction_session_timeout', '60s', false)
    `
    if (settingRows[0]?.applicationName !== client.applicationName) {
      throw new Error('数据库测试全局锁连接标签未生效。')
    }
    const lockRows = await reserved<
      readonly {
        readonly acquired: boolean
        readonly backendPid: number
      }[]
    >`
      SELECT
        pg_try_advisory_lock(
          hashtext(${DATABASE_TEST_SUITE_LOCK_NAME})
        ) AS acquired,
        pg_backend_pid() AS "backendPid"
    `
    const lockRow = lockRows[0]
    lockAcquired = lockRow?.acquired === true
    if (!lockAcquired) {
      reserved.release()
      reservedReleased = true
      throw new Error(DATABASE_TEST_SUITE_LOCK_CONFLICT_MESSAGE)
    }
    if (
      lockRow === undefined ||
      !Number.isSafeInteger(lockRow.backendPid) ||
      lockRow.backendPid < 1
    ) {
      throw new Error('数据库测试全局锁 backend PID 无效。')
    }
    backendPid = lockRow.backendPid
  } catch (error) {
    if (!lockAcquired && !reservedReleased) reserved.release()
    throw error
  }

  let requestRelease!: () => void
  const releaseRequested = new Promise<void>((resolve) => {
    requestRelease = resolve
  })
  let lockLoss: Error | null = null
  const lockLossController = new AbortController()
  const reportLockLoss = (error: unknown): Error => {
    if (lockLoss !== null) return lockLoss
    lockLoss = new Error(DATABASE_TEST_SUITE_LOCK_LOST_MESSAGE)
    lockLoss.name = 'DatabaseTestSuiteLockLostError'
    try {
      reporter.write(
        `[database-test] SUITE LOCK lost: ${describeSuiteLockFailure(error)}\n`,
      )
    } catch {
      // Diagnostics never alter the fail-closed lock state.
    }
    lockLossController.abort(lockLoss)
    return lockLoss
  }
  const connectionClosed = waitForAbort(client.connectionClosedSignal)
  let unlocked = false
  const completion = (async () => {
    try {
      for (;;) {
        const next = await Promise.race([
          releaseRequested.then(() => 'release' as const),
          connectionClosed.promise,
          delay(heartbeatIntervalMs, 'heartbeat' as const, { ref: false }),
        ])
        if (next === 'release') {
          const rows = await Promise.race([
            reserved<
              readonly {
                readonly released: boolean
                readonly backendPid: number
              }[]
            >`
              SELECT
                pg_advisory_unlock(
                  hashtext(${DATABASE_TEST_SUITE_LOCK_NAME})
                ) AS released,
                pg_backend_pid() AS "backendPid"
            `,
            connectionClosed.promise,
          ])
          if (
            rows[0]?.released !== true ||
            rows[0]?.backendPid !== backendPid
          ) {
            throw new Error('数据库测试全局锁释放认证失败。')
          }
          unlocked = true
          connectionClosed.dispose()
          if (!client.connectionClosedSignal.aborted) {
            reserved.release()
            reservedReleased = true
          }
          return
        }
        const rows = await Promise.race([
          reserved<readonly { readonly backendPid: number }[]>`
            SELECT pg_backend_pid() AS "backendPid"
          `,
          connectionClosed.promise,
        ])
        if (rows[0]?.backendPid !== backendPid) {
          throw new Error('数据库测试全局锁 backend 已变化。')
        }
      }
    } catch (error) {
      throw reportLockLoss(error)
    } finally {
      connectionClosed.dispose()
      if (
        unlocked &&
        !reservedReleased &&
        !client.connectionClosedSignal.aborted
      ) {
        reserved.release()
      }
    }
  })()
  void completion.catch(() => undefined)

  let releasePromise: Promise<void> | null = null
  return Object.freeze({
    signal: lockLossController.signal,
    release(): Promise<void> {
      requestRelease()
      releasePromise ??= completion
      return releasePromise
    },
  })
}
