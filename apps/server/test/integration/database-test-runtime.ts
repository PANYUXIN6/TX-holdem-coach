import { AsyncLocalStorage } from 'node:async_hooks'
import postgres, { type Sql, type TransactionSql } from 'postgres'
import type {
  DatabaseTestMilestone,
  DatabaseTestMode,
} from '../../src/db/database-test-mode.js'
export {
  acquireDatabaseTestSuiteLock,
  bindDatabaseTestClientToSuiteLock,
  createDatabaseTestSuiteLockClient,
  type DatabaseTestSuiteLock,
} from '../../src/db/database-test-suite-lock.js'
import { DATABASE_TEST_APPLICATION_PREFIX } from '../../src/db/test-database-safety.js'
import { protectDatabaseTestTransactions } from './database-test-client.js'

const DATABASE_TEST_SUITE_LOCK_APPLICATION_PATTERN = `^${DATABASE_TEST_APPLICATION_PREFIX}:[a-f0-9]{16}:suite-lock$`

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

type AbortableDatabaseTestClient = Pick<Sql, 'end'>

interface DatabaseTestAbortScope {
  readonly signal: AbortSignal
  cleanupAuthority: AbortSignal | undefined
  readonly clientStops: Set<() => Promise<void>>
  readonly startedClientStops: Set<() => Promise<void>>
  readonly clientStopTasks: Set<Promise<void>>
  readonly cleanupClientClosers: Set<() => Promise<void>>
  cleanupClientsClosed?: Promise<void>
  readonly cleanupCallbacks: Set<() => Promise<void>>
  readonly startedCleanups: Map<() => Promise<void>, Promise<void>>
  readonly cleanupTasks: Set<Promise<void>>
  readonly cleanupCompletions: Set<Promise<unknown>>
  readonly cleanupFailures: unknown[]
}

const databaseTestAbortScopeStorage =
  new AsyncLocalStorage<DatabaseTestAbortScope>()
const databaseTestCleanupStorage = new AsyncLocalStorage<boolean>()
const databaseTestAbortScopes = new WeakMap<
  AbortSignal,
  DatabaseTestAbortScope
>()

export async function runDatabaseTestCleanup<Result>(
  cleanup: () => Promise<Result>,
): Promise<Result> {
  const scope = databaseTestAbortScopeStorage.getStore()
  const completion = (async () => {
    if (scope?.signal.aborted) await stopDatabaseTestClients(scope)
    scope?.cleanupAuthority?.throwIfAborted()
    return databaseTestCleanupStorage.run(true, cleanup)
  })()
  scope?.cleanupCompletions.add(completion)
  try {
    return await completion
  } finally {
    scope?.cleanupCompletions.delete(completion)
  }
}

export function throwIfDatabaseTestAborted(): void {
  const scope = databaseTestAbortScopeStorage.getStore()
  if (databaseTestCleanupStorage.getStore())
    scope?.cleanupAuthority?.throwIfAborted()
  else scope?.signal.throwIfAborted()
}

async function stopDatabaseTestClients(
  scope: DatabaseTestAbortScope,
): Promise<void> {
  for (const stop of scope.clientStops) {
    if (scope.startedClientStops.has(stop)) continue
    scope.startedClientStops.add(stop)
    const completion = Promise.resolve()
      .then(stop)
      .catch((error: unknown) => {
        scope.cleanupFailures.push(error)
      })
      .finally(() => scope.clientStopTasks.delete(completion))
    scope.clientStopTasks.add(completion)
  }
  while (scope.clientStopTasks.size > 0)
    await Promise.all([...scope.clientStopTasks])
}

async function closeDatabaseTestCleanupClients(
  scope: DatabaseTestAbortScope,
): Promise<void> {
  scope.cleanupClientsClosed ??= Promise.all(
    [...scope.cleanupClientClosers].map(async (close) => {
      try {
        await close()
      } catch (error) {
        scope.cleanupFailures.push(error)
      }
    }),
  ).then(() => undefined)
  await scope.cleanupClientsClosed
}

function getDatabaseTestAbortScope(
  signal: AbortSignal,
): DatabaseTestAbortScope {
  const existing = databaseTestAbortScopes.get(signal)
  if (existing !== undefined) {
    return existing
  }
  const scope: DatabaseTestAbortScope = {
    signal,
    cleanupAuthority: undefined,
    clientStops: new Set(),
    startedClientStops: new Set(),
    clientStopTasks: new Set(),
    cleanupClientClosers: new Set(),
    cleanupCallbacks: new Set(),
    startedCleanups: new Map(),
    cleanupTasks: new Set(),
    cleanupCompletions: new Set(),
    cleanupFailures: [],
  }
  databaseTestAbortScopes.set(signal, scope)
  signal.addEventListener(
    'abort',
    () => {
      void stopDatabaseTestClients(scope)
      for (const cleanup of scope.cleanupCallbacks) {
        startDatabaseTestAbortCleanup(scope, cleanup)
      }
    },
    { once: true },
  )
  return scope
}

function startDatabaseTestAbortCleanup(
  scope: DatabaseTestAbortScope,
  cleanup: () => Promise<void>,
): void {
  if (scope.startedCleanups.has(cleanup)) {
    return
  }
  const task = Promise.resolve()
    .then(() =>
      databaseTestAbortScopeStorage.run(scope, () =>
        runDatabaseTestCleanup(cleanup),
      ),
    )
    .catch((error: unknown) => {
      scope.cleanupFailures.push(error)
    })
    .finally(() => {
      scope.cleanupTasks.delete(task)
    })
  scope.cleanupTasks.add(task)
  scope.startedCleanups.set(cleanup, task)
}

function registerDatabaseTestAbortCleanup(
  scope: DatabaseTestAbortScope,
  cleanup: () => Promise<void>,
): () => void {
  scope.cleanupCallbacks.add(cleanup)
  if (scope.signal.aborted) {
    startDatabaseTestAbortCleanup(scope, cleanup)
  }
  return () => scope.cleanupCallbacks.delete(cleanup)
}

function registerCurrentDatabaseTestAbortCleanup(
  cleanup: () => Promise<void>,
): () => void {
  const scope = databaseTestAbortScopeStorage.getStore()
  return scope === undefined
    ? () => undefined
    : registerDatabaseTestAbortCleanup(scope, cleanup)
}

export function trackDatabaseTestAbortCleanupCompletion(
  completion: Promise<unknown>,
): () => void {
  const scope = databaseTestAbortScopeStorage.getStore()
  if (scope === undefined) {
    return () => undefined
  }
  scope.cleanupCompletions.add(completion)
  const unregister = () => scope.cleanupCompletions.delete(completion)
  void completion.then(unregister, unregister)
  return unregister
}

export function startDatabaseTestOperation<Started, Result>(
  label: string,
  operation: (reportStarted: (value: Started) => void) => Promise<Result>,
): {
  readonly started: Promise<Started>
  readonly completion: Promise<Result>
} {
  let startedReported = false
  let resolveStarted!: (value: Started) => void
  let rejectStarted!: (error: unknown) => void
  const started = new Promise<Started>((resolve, reject) => {
    resolveStarted = resolve
    rejectStarted = reject
  })
  const completion = Promise.resolve().then(() =>
    operation((value) => {
      if (startedReported) {
        throw new Error(`${label} 重复报告已启动。`)
      }
      startedReported = true
      resolveStarted(value)
    }),
  )
  void completion.then(
    () => {
      if (!startedReported) {
        rejectStarted(new Error(`${label} 在报告已启动前结束。`))
      }
    },
    (error: unknown) => {
      if (!startedReported) rejectStarted(error)
    },
  )
  return Object.freeze({ started, completion })
}

export function bindDatabaseTestClientToAbortSignal(
  client: AbortableDatabaseTestClient,
  signal: AbortSignal,
): void {
  const scope = getDatabaseTestAbortScope(signal)
  scope.clientStops.add(() => client.end({ timeout: 5 }))
  if (signal.aborted) void stopDatabaseTestClients(scope)
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
  const abortScope = databaseTestAbortScopeStorage.getStore()
  let cleanupPromise: Promise<void> | undefined
  const runCleanup = (): Promise<void> => {
    cleanupPromise ??= runDatabaseTestCleanup(cleanup)
    return cleanupPromise
  }
  const unregisterAbortCleanup =
    registerCurrentDatabaseTestAbortCleanup(runCleanup)
  try {
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
      await runCleanup()
    } catch (cleanupFailure) {
      if (!operationFailed) {
        throw new Error(
          `数据库测试清理失败：${describeDatabaseTestCleanupFailure(cleanupFailure)}`,
        )
      }
      if (!abortScope?.signal.aborted) {
        reporter.write(
          `[database-test] CLEANUP failed after preserving the primary failure: ${describeDatabaseTestCleanupFailure(cleanupFailure)}\n`,
        )
      }
    }

    if (operationFailed) {
      throw primaryFailure
    }
    if (!operationCompleted) {
      throw new Error('数据库测试既未完成也未返回失败。')
    }
    return operationResult as Result
  } finally {
    unregisterAbortCleanup()
  }
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
    connect_timeout: 30,
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
  maximumConnections = 1,
): Sql {
  if (!Number.isSafeInteger(maximumConnections) || maximumConnections < 1) {
    throw new Error('数据库测试连接池大小无效。')
  }
  const scope = databaseTestAbortScopeStorage.getStore()
  throwIfDatabaseTestAborted()
  const sql = postgres(url, {
    ...createDatabaseTestConnectionOptions(runId, role),
    max: maximumConnections,
  })
  if (scope !== undefined) {
    bindDatabaseTestClientToAbortSignal(sql, scope.signal)
  }
  const protectedSql = protectDatabaseTestTransactions(
    sql,
    `${DATABASE_TEST_APPLICATION_PREFIX}:${runId}:${role}`,
    scope?.signal,
  )
  if (scope === undefined) return protectedSql
  let cleanupSql: Sql | undefined
  const currentClient = (): Sql => {
    if (!databaseTestCleanupStorage.getStore()) return protectedSql
    scope.cleanupAuthority?.throwIfAborted()
    if (cleanupSql === undefined) {
      const cleanupClient = postgres(url, {
        ...createDatabaseTestConnectionOptions(runId, role),
        max: maximumConnections,
      })
      cleanupSql = protectDatabaseTestTransactions(
        cleanupClient,
        `${DATABASE_TEST_APPLICATION_PREFIX}:${runId}:${role}`,
        scope.cleanupAuthority,
      )
      const closeOnAuthorityLoss = () => {
        void cleanupClient.end({ timeout: 0 }).catch((error: unknown) => {
          scope.cleanupFailures.push(error)
        })
      }
      scope.cleanupAuthority?.addEventListener('abort', closeOnAuthorityLoss, {
        once: true,
      })
      scope.cleanupClientClosers.add(async () => {
        scope.cleanupAuthority?.removeEventListener(
          'abort',
          closeOnAuthorityLoss,
        )
        await cleanupClient.end({ timeout: 5 })
      })
    }
    return cleanupSql
  }
  return new Proxy(protectedSql, {
    apply(_target, thisArgument, argumentsList) {
      return Reflect.apply(currentClient(), thisArgument, argumentsList)
    },
    get(target, property) {
      // 原工作连接的 finally 不得提前关闭仍被夹具恢复使用的连接。
      return Reflect.get(
        property === 'end' ? target : currentClient(),
        property,
      )
    },
  })
}

export function createDatabaseTestSqlForRole(
  url: string,
  role: string,
  environment: NodeJS.ProcessEnv = process.env,
  maximumConnections = 1,
): Sql {
  const runId = environment.DATABASE_TEST_RUN_ID
  if (runId === undefined) {
    throw new Error('数据库测试缺少 Run ID。')
  }
  return createDatabaseTestSql(url, runId, role, maximumConnections)
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
    FROM pg_stat_activity AS activity
    WHERE datname = current_database()
      AND pid <> pg_backend_pid()
      AND application_name NOT LIKE ${`${DATABASE_TEST_APPLICATION_PREFIX}:${runId}:%`}
      AND (
        (application_name LIKE ${`${DATABASE_TEST_APPLICATION_PREFIX}:%`}
          AND (xact_start IS NOT NULL
            OR application_name ~ ${DATABASE_TEST_SUITE_LOCK_APPLICATION_PATTERN}))
        OR (xact_start IS NOT NULL
          AND application_name NOT LIKE ${`${DATABASE_TEST_APPLICATION_PREFIX}:%`}
          AND EXISTS (
            SELECT 1 FROM pg_locks AS held
            JOIN pg_class AS relation ON relation.oid = held.relation
            JOIN pg_namespace AS schema ON schema.oid = relation.relnamespace
            WHERE held.pid = activity.pid AND held.granted
              AND schema.nspname = 'app_private'
          ))
      )
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
  if (
    rows.some(
      (row) =>
        !row.applicationName.startsWith(`${DATABASE_TEST_APPLICATION_PREFIX}:`),
    )
  ) {
    throw new Error(
      `检测到未标记的数据库事务持有 app_private 锁：${details}。请确认连接归属后处理；自动测试连接清理不会终止它。`,
    )
  }
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
      AND (
        xact_start IS NOT NULL
        OR application_name ~ ${DATABASE_TEST_SUITE_LOCK_APPLICATION_PATTERN}
      )
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

export async function runAbortableDatabasePhase<Result>(
  label: string,
  signal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<Result>,
  reporter: DatabaseTestPhaseReporter = {
    now: Date.now,
    write: (message) => process.stderr.write(message),
  },
  cleanupAuthority?: AbortSignal,
): Promise<Result> {
  const scope = getDatabaseTestAbortScope(signal)
  scope.cleanupAuthority =
    cleanupAuthority ??
    databaseTestAbortScopeStorage.getStore()?.cleanupAuthority
  return databaseTestAbortScopeStorage.run(scope, async () => {
    signal.throwIfAborted()
    const completion = runTimedDatabasePhase(
      label,
      () => operation(signal),
      reporter,
    )
    const unregister = trackDatabaseTestAbortCleanupCompletion(completion)
    try {
      const result = await completion
      signal.throwIfAborted()
      return result
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted()
      throw error
    } finally {
      unregister()
      if (signal.aborted) {
        await waitForDatabaseTestAbortCleanup(signal, reporter)
      }
      await closeDatabaseTestCleanupClients(scope)
    }
  })
}

export async function waitForDatabaseTestAbortCleanup(
  signal: AbortSignal,
  reporter: DatabaseTestCleanupReporter = {
    write: (message) => process.stderr.write(message),
  },
): Promise<void> {
  const scope = databaseTestAbortScopes.get(signal)
  if (scope === undefined) {
    return
  }
  if (signal.aborted) {
    await stopDatabaseTestClients(scope)
    for (const cleanup of scope.cleanupCallbacks) {
      startDatabaseTestAbortCleanup(scope, cleanup)
    }
  }
  while (scope.cleanupTasks.size > 0 || scope.cleanupCompletions.size > 0) {
    await Promise.allSettled([
      ...scope.cleanupTasks,
      ...scope.cleanupCompletions,
    ])
  }
  await closeDatabaseTestCleanupClients(scope)
  const cleanupFailures = scope.cleanupFailures.splice(0)
  if (cleanupFailures.length > 0) {
    reporter.write(
      `[database-test] CLEANUP failed after preserving the primary failure: ${cleanupFailures
        .map((failure) => describeDatabaseTestCleanupFailure(failure))
        .join(',')}\n`,
    )
  }
}
