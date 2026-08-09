import postgres, { type Sql, type TransactionSql } from 'postgres'
import type {
  DatabaseTestMilestone,
  DatabaseTestMode,
} from '../../src/db/database-test-mode.js'

const DATABASE_TEST_APPLICATION_PREFIX = 'txhc-dbtest'

interface ConflictingDatabaseTestConnection {
  readonly pid: number
  readonly applicationName: string
  readonly state: string | null
  readonly transactionAge: string | null
}

export interface DatabaseTestPhaseReporter {
  readonly now: () => number
  readonly write: (message: string) => void
}

export interface DatabaseTestCleanupReporter {
  readonly write: (message: string) => void
}

function describeDatabaseTestCleanupFailure(error: unknown): string {
  if (error instanceof AggregateError) {
    return `AggregateError(causes=${error.errors
      .map((cause) => describeDatabaseTestCleanupFailure(cause))
      .join(',')})`
  }
  if (typeof error !== 'object' || error === null) {
    return 'UnknownCleanupFailure'
  }
  const name =
    'name' in error &&
    typeof error.name === 'string' &&
    /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name)
      ? error.name
      : 'CleanupFailure'
  const code =
    'code' in error &&
    typeof error.code === 'string' &&
    /^[A-Za-z0-9_]{1,64}$/.test(error.code)
      ? error.code
      : null
  return code === null ? name : `${name}(code=${code})`
}

export async function runDatabaseTestWithCleanup<Result>(
  operation: () => Promise<Result>,
  cleanup: () => Promise<void>,
  reporter: DatabaseTestCleanupReporter = {
    write: (message) => process.stderr.write(message),
  },
): Promise<Result> {
  let operationCompleted = false
  let operationFailed = false
  let operationResult: Result | undefined
  let primaryFailure: unknown
  try {
    operationResult = await operation()
    operationCompleted = true
  } catch (error) {
    operationFailed = true
    primaryFailure = error
  }

  try {
    await cleanup()
  } catch (cleanupFailure) {
    if (!operationFailed) {
      throw new Error(
        `数据库测试清理失败：${describeDatabaseTestCleanupFailure(cleanupFailure)}`,
        { cause: cleanupFailure },
      )
    }
    reporter.write(
      `[database-test] CLEANUP failed after preserving the primary failure: ${describeDatabaseTestCleanupFailure(cleanupFailure)}\n`,
    )
  }

  if (operationFailed) {
    throw primaryFailure
  }
  if (!operationCompleted) {
    throw new Error('数据库测试既未完成也未返回失败。')
  }
  return operationResult as Result
}

export function createDatabaseTestConnectionOptions(
  runId: string,
  role: string,
) {
  if (!/^[a-f0-9]{16}$/.test(runId)) {
    throw new Error('数据库测试 Run ID 无效。')
  }
  if (!/^[a-z0-9-]{1,24}$/.test(role)) {
    throw new Error('数据库测试连接角色无效。')
  }
  return {
    connect_timeout: 10,
    max: 1,
    prepare: false,
    ssl: 'require' as const,
    connection: {
      application_name: `${DATABASE_TEST_APPLICATION_PREFIX}:${runId}:${role}`,
      statement_timeout: 90_000,
      idle_in_transaction_session_timeout: 60_000,
    },
  }
}

export function createDatabaseTestSql(
  url: string,
  runId: string,
  role: string,
): Sql {
  return postgres(url, createDatabaseTestConnectionOptions(runId, role))
}

export function createDatabaseTestSqlForRole(
  url: string,
  role: string,
  environment: NodeJS.ProcessEnv = process.env,
): Sql {
  const runId = environment.DATABASE_TEST_RUN_ID
  if (runId === undefined) {
    throw new Error('数据库测试缺少 Run ID。')
  }
  return createDatabaseTestSql(url, runId, role)
}

export async function assertNoConflictingDatabaseTestConnections(
  sql: Sql,
  runId: string,
): Promise<void> {
  const rows = await sql<ConflictingDatabaseTestConnection[]>`
    SELECT
      pid,
      application_name AS "applicationName",
      state,
      age(clock_timestamp(), xact_start)::text AS "transactionAge"
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND application_name LIKE ${`${DATABASE_TEST_APPLICATION_PREFIX}:%`}
      AND application_name NOT LIKE ${`${DATABASE_TEST_APPLICATION_PREFIX}:${runId}:%`}
      AND xact_start IS NOT NULL
    ORDER BY xact_start, pid
  `
  if (rows.length === 0) {
    return
  }
  const details = rows
    .map(
      (row) =>
        `PID ${row.pid}，状态 ${row.state ?? 'unknown'}，事务年龄 ${row.transactionAge ?? 'unknown'}`,
    )
    .join('；')
  throw new Error(
    `检测到其他数据库测试事务：${details}。请先运行 pnpm --filter @tx-holdem-coach/server run db:test:cleanup。`,
  )
}

export async function terminateConflictingDatabaseTestConnections(
  sql: Sql,
  runId: string,
): Promise<readonly number[]> {
  const rows = await sql<
    { readonly pid: number; readonly terminated: boolean }[]
  >`
    SELECT
      pid,
      pg_terminate_backend(pid) AS terminated
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND application_name LIKE ${`${DATABASE_TEST_APPLICATION_PREFIX}:%`}
      AND application_name NOT LIKE ${`${DATABASE_TEST_APPLICATION_PREFIX}:${runId}:%`}
      AND xact_start IS NOT NULL
    ORDER BY pid
  `
  return Object.freeze(
    rows.filter((row) => row.terminated).map((row) => row.pid),
  )
}

export async function readTransactionBackendPid(
  transaction: TransactionSql,
): Promise<number> {
  const rows = await transaction<{ readonly backendPid: number }[]>`
    SELECT pg_backend_pid() AS "backendPid"
  `
  const backendPid = rows[0]?.backendPid
  if (backendPid === undefined) {
    throw new Error('无法取得数据库测试事务 backend PID。')
  }
  return backendPid
}

export function serializeJsonbFixture(value: unknown): string {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) {
    throw new Error('数据库测试 JSONB fixture 无法序列化。')
  }
  return serialized
}

export function shouldRunDatabaseMilestone(
  mode: DatabaseTestMode,
  milestone: DatabaseTestMilestone,
  databasePrepared: boolean,
): boolean {
  return databasePrepared && (mode.full || mode.milestone === milestone)
}

export async function runTimedDatabasePhase<Result>(
  label: string,
  operation: () => Promise<Result>,
  reporter: DatabaseTestPhaseReporter = {
    now: Date.now,
    write: (message) => process.stderr.write(message),
  },
): Promise<Result> {
  const startedAt = reporter.now()
  reporter.write(`[database-test] START ${label}\n`)
  try {
    const result = await operation()
    reporter.write(
      `[database-test] PASS ${label} (${reporter.now() - startedAt} ms)\n`,
    )
    return result
  } catch (error) {
    reporter.write(
      `[database-test] FAIL ${label} (${reporter.now() - startedAt} ms)\n`,
    )
    throw error
  }
}
