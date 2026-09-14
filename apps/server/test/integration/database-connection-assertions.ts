import { randomInt } from 'node:crypto'
import type { Sql } from 'postgres'
import { expect } from 'vitest'
import {
  createDatabaseTestSqlForRole,
  runAbortableDatabasePhase,
  runDatabaseTestWithCleanup,
  startDatabaseTestOperation,
} from './database-test-runtime.js'

const LOCK_NAMESPACE = 1_904_014_091

async function assertLockAvailable(sql: Sql, key: number): Promise<void> {
  await sql.begin(async (tx) => {
    const rows = await tx`
      SELECT pg_try_advisory_xact_lock(${LOCK_NAMESPACE}, ${key}) AS acquired
    `
    expect(rows[0]?.acquired).toBe(true)
  })
}

/** 仅操作当前测试的事务级 advisory lock，不修改应用数据。 */
export async function assertDatabaseConnectionProtection(
  runtimeUrl: string,
  signal: AbortSignal,
): Promise<void> {
  const observer = createDatabaseTestSqlForRole(
    runtimeUrl,
    'connection-observer',
  )
  const idleClient = createDatabaseTestSqlForRole(runtimeUrl, 'connection-idle')
  try {
    await idleClient.begin(async (tx) => {
      await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`
      const rows = await tx`
        SELECT current_setting('application_name') AS name,
          current_setting('statement_timeout') AS statement,
          current_setting('idle_in_transaction_session_timeout') AS idle,
          current_setting('transaction_isolation') AS isolation,
          current_setting('transaction_read_only') AS "readOnly"
      `
      expect(rows[0]).toEqual({
        name: `txhc-dbtest:${process.env.DATABASE_TEST_RUN_ID}:connection-idle`,
        statement: '90s',
        idle: '1min',
        isolation: 'repeatable read',
        readOnly: 'on',
      })
    })

    const idleLock = randomInt(1, 2_147_483_647)
    let releaseIdle!: () => void
    const idleGate = new Promise<void>((resolve) => {
      releaseIdle = resolve
    })
    const idleOperation = startDatabaseTestOperation(
      'idle transaction expiry',
      async (reportStarted) => {
        await idleClient.begin(async (tx) => {
          // 缩短这一故障用例的空闲期限；默认 60 秒已由上面的真实查询认证。
          await tx`SET LOCAL idle_in_transaction_session_timeout = '1s'`
          const rows = await tx`
          SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE}, ${idleLock}), pg_backend_pid() AS pid
        `
          reportStarted(rows[0]!.pid as number)
          await idleGate
        })
      },
    )
    const idleFailure = idleOperation.completion.then(
      () => null,
      (error: unknown) => error,
    )
    try {
      await idleOperation.started
      const failure = await idleFailure
      const code =
        typeof failure === 'object' && failure !== null && 'code' in failure
          ? failure.code
          : undefined
      // Supavisor 可把 PostgreSQL 的空闲超时终止转换为前端连接关闭。
      expect(['25P03', 'CONNECTION_CLOSED']).toContain(code)
      await assertLockAvailable(observer, idleLock)
    } finally {
      releaseIdle()
      await idleClient.end({ timeout: 0 })
    }

    const controller = new AbortController()
    const abortReason = new Error('connection protection abort probe')
    const abortLock = randomInt(1, 2_147_483_647)
    let reportStarted!: (pid: number) => void
    const started = new Promise<number>((resolve) => {
      reportStarted = resolve
    })
    let cleanupCompleted = false
    const phase = runAbortableDatabasePhase(
      'transaction rollback and isolated cleanup',
      AbortSignal.any([signal, controller.signal]),
      async () => {
        const client = createDatabaseTestSqlForRole(
          runtimeUrl,
          'connection-abort',
        )
        await runDatabaseTestWithCleanup(
          async () => {
            await client.begin(async (tx) => {
              const rows = await tx`
              SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE}, ${abortLock}), pg_backend_pid() AS pid
            `
              reportStarted(rows[0]!.pid as number)
              await new Promise<void>(() => undefined)
            })
          },
          async () => {
            await assertLockAvailable(client, abortLock)
            cleanupCompleted = true
          },
        )
      },
      { now: Date.now, write: () => undefined },
    )
    const outcome = phase.then(
      () => null,
      (error: unknown) => error,
    )
    try {
      const pid = await Promise.race([
        started,
        outcome.then((error) => {
          throw error ?? new Error('连接探测未启动。')
        }),
      ])
      const rows = await observer`
        SELECT application_name AS name FROM pg_stat_activity WHERE pid = ${pid}
      `
      expect(rows[0]?.name).toBe(
        `txhc-dbtest:${process.env.DATABASE_TEST_RUN_ID}:connection-abort`,
      )
      controller.abort(abortReason)
      expect(await outcome).toBe(abortReason)
      expect(cleanupCompleted).toBe(true)
      await assertLockAvailable(observer, abortLock)
    } finally {
      controller.abort(abortReason)
      await outcome
    }
  } finally {
    await idleClient.end({ timeout: 0 })
    await observer.end({ timeout: 0 })
  }
}
