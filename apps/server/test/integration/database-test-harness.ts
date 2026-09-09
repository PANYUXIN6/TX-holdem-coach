import { join } from 'node:path'
import type { Sql } from 'postgres'
import { afterAll, expect, test } from 'vitest'
import {
  assertExactMigrationSequence,
  assertMigrationSequence,
  buildExpectedMigrationSequence,
  readActualMigrationSequence,
} from '../../src/db/migration-compatibility.js'
import { loadDatabaseTestMode } from '../../src/db/database-test-mode.js'
import { loadTestDatabaseConnections } from '../../src/db/test-database-safety.js'
import { runManagedChildProcess } from '../../scripts/managed-child-process.mjs'
import {
  assertNoConflictingDatabaseTestConnections,
  acquireDatabaseTestSuiteLock,
  createDatabaseTestSuiteLockClient,
  createDatabaseTestSql,
  type DatabaseTestSuiteLock,
  runAbortableDatabasePhase,
  shouldRunDatabaseMilestone,
  terminateConflictingDatabaseTestConnections,
  trackDatabaseTestAbortCleanupCompletion,
  waitForDatabaseTestAbortCleanup,
} from './database-test-runtime.js'

const databaseTestMode = loadDatabaseTestMode(process.env)
let persistentDatabasePrepared = false
let persistentDatabaseSuiteLock: {
  readonly client: Sql
  readonly lock: DatabaseTestSuiteLock
} | null = null

afterAll(async () => {
  const lock = persistentDatabaseSuiteLock
  persistentDatabaseSuiteLock = null
  if (lock !== null) {
    try {
      await lock.lock.release()
    } finally {
      await lock.client.end({ timeout: 0 })
    }
  }
})

function requireDatabaseTestRunId(): string {
  if (databaseTestMode.runId === null) {
    throw new Error('数据库测试缺少 Run ID。')
  }
  return databaseTestMode.runId
}

function createSuiteProtectedDatabaseTestSignal(
  signal: AbortSignal,
): AbortSignal {
  const suiteLock = persistentDatabaseSuiteLock
  if (suiteLock === null) {
    throw new Error('数据库测试全局锁未持有。')
  }
  return AbortSignal.any([signal, suiteLock.lock.signal])
}

async function clearPersistentLocalOwnerSessions(sql: Sql): Promise<void> {
  await sql`
    DELETE FROM app_private.sessions
    WHERE owner_id = (
      SELECT id FROM app_private.owners WHERE identity_key = 'local-user'
    )
  `
}

async function preparePersistentTestDatabase(
  signal: AbortSignal,
): Promise<void> {
  const { runtimeUrl } = loadTestDatabaseConnections(process.env)
  const runId = requireDatabaseTestRunId()
  const sourceDirectory = join(process.cwd(), 'src/db/migrations')
  const expected = await buildExpectedMigrationSequence(sourceDirectory)
  const preflightSql = createDatabaseTestSql(
    runtimeUrl,
    runId,
    'migration-preflight',
  )

  try {
    await assertNoConflictingDatabaseTestConnections(preflightSql, runId)
    const existingSchema = await preflightSql<
      { readonly schema: string | null }[]
    >`
      SELECT to_regnamespace('app_private') AS schema
    `

    if (existingSchema[0]?.schema !== null) {
      const actualBeforeMigration =
        await readActualMigrationSequence(preflightSql)
      assertMigrationSequence(expected, actualBeforeMigration, 'prefix')
    }
  } finally {
    await preflightSql.end({ timeout: 0 })
  }

  signal.throwIfAborted()
  const { completion } = runManagedChildProcess(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    [
      'exec',
      'drizzle-kit',
      'migrate',
      '--config',
      'drizzle.integration.config.ts',
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      signal,
      signalErrorMessage: '数据库测试迁移进程异常终止。',
      stdio: 'inherit',
    },
  )
  const unregisterMigrationCompletion =
    trackDatabaseTestAbortCleanupCompletion(completion)
  let exitCode: number
  try {
    exitCode = await completion
  } finally {
    unregisterMigrationCompletion()
  }
  if (exitCode !== 0) {
    throw new Error(`数据库测试迁移失败，退出码 ${exitCode}。`)
  }

  signal.throwIfAborted()
  const verificationSql = createDatabaseTestSql(
    runtimeUrl,
    runId,
    'migration-verify',
  )
  try {
    const actual = await readActualMigrationSequence(verificationSql)
    expect(() => assertExactMigrationSequence(expected, actual)).not.toThrow()
    signal.throwIfAborted()
    await clearPersistentLocalOwnerSessions(verificationSql)
  } finally {
    await verificationSql.end({ timeout: 0 })
  }
}

export function registerPersistentDatabasePreparation(): void {
  test('prepares the persistent test database', async (context) => {
    if (!databaseTestMode.enabled || databaseTestMode.cleanupStale) {
      context.skip()
      return
    }
    const { migrationUrl } = loadTestDatabaseConnections(process.env)
    const lockClient = createDatabaseTestSuiteLockClient(
      migrationUrl,
      requireDatabaseTestRunId(),
    )
    const lock = lockClient.sql
    let retained = false
    try {
      const suiteLock = await acquireDatabaseTestSuiteLock(lockClient)
      persistentDatabaseSuiteLock = { client: lock, lock: suiteLock }
      retained = true
      const phaseSignal = createSuiteProtectedDatabaseTestSignal(context.signal)
      context.onTestFinished(
        () => waitForDatabaseTestAbortCleanup(phaseSignal),
        30_000,
      )
      await runAbortableDatabasePhase(
        'migration compatibility',
        phaseSignal,
        preparePersistentTestDatabase,
      )
      persistentDatabasePrepared = true
    } finally {
      if (!retained) await lock.end({ timeout: 0 })
    }
  }, 180_000)
}

export function registerDatabaseMilestoneTest(
  milestone: NonNullable<typeof databaseTestMode.milestone>,
  label: string,
  assertion: (
    sql: Sql,
    runtimeUrl: string,
    signal: AbortSignal,
  ) => Promise<void>,
  timeout = 180_000,
): void {
  test(
    `validates ${label} against PostgreSQL`,
    async (context) => {
      if (
        !databaseTestMode.enabled ||
        !shouldRunDatabaseMilestone(
          databaseTestMode,
          milestone,
          persistentDatabasePrepared,
        )
      ) {
        context.skip()
        return
      }
      const phaseSignal = createSuiteProtectedDatabaseTestSignal(context.signal)
      context.onTestFinished(
        () => waitForDatabaseTestAbortCleanup(phaseSignal),
        30_000,
      )
      await runAbortableDatabasePhase(label, phaseSignal, async (signal) => {
        const { runtimeUrl } = loadTestDatabaseConnections(process.env)
        const runId = requireDatabaseTestRunId()
        const sql = createDatabaseTestSql(
          runtimeUrl,
          runId,
          `${milestone}-primary`,
        )
        try {
          await assertNoConflictingDatabaseTestConnections(sql, runId)
          await assertion(sql, runtimeUrl, signal)
        } finally {
          await sql.end({ timeout: 0 })
        }
      })
    },
    timeout,
  )
}

export function registerStaleDatabaseTestCleanup(): void {
  test('cleans stale tagged database test transactions', async (context) => {
    if (!databaseTestMode.enabled || !databaseTestMode.cleanupStale) {
      context.skip()
      return
    }
    const { runtimeUrl } = loadTestDatabaseConnections(process.env)
    const runId = requireDatabaseTestRunId()
    context.onTestFinished(
      () => waitForDatabaseTestAbortCleanup(context.signal),
      30_000,
    )
    await runAbortableDatabasePhase(
      'stale tagged transaction cleanup',
      context.signal,
      async () => {
        const sql = createDatabaseTestSql(runtimeUrl, runId, 'cleanup')
        try {
          const terminatedPids =
            await terminateConflictingDatabaseTestConnections(sql, runId)
          process.stderr.write(
            `[database-test] CLEANUP terminated ${terminatedPids.length} transaction(s)${
              terminatedPids.length === 0
                ? ''
                : `: ${terminatedPids.join(', ')}`
            }\n`,
          )
        } finally {
          await sql.end({ timeout: 0 })
        }
      },
    )
  }, 60_000)
}
