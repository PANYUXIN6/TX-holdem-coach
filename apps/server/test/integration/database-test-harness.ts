import { join } from 'node:path'
import type { Sql } from 'postgres'
import { expect, test } from 'vitest'
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
  createDatabaseTestSql,
  runAbortableDatabasePhase,
  shouldRunDatabaseMilestone,
  terminateConflictingDatabaseTestConnections,
  trackDatabaseTestAbortCleanupCompletion,
  waitForDatabaseTestAbortCleanup,
} from './database-test-runtime.js'

const databaseTestMode = loadDatabaseTestMode(process.env)
let persistentDatabasePrepared = false

function requireDatabaseTestRunId(): string {
  if (databaseTestMode.runId === null) {
    throw new Error('数据库测试缺少 Run ID。')
  }
  return databaseTestMode.runId
}

async function preparePersistentTestDatabase(
  signal: AbortSignal,
): Promise<void> {
  const { runtimeUrl } = loadTestDatabaseConnections(process.env)
  const runId = requireDatabaseTestRunId()
  const sql = createDatabaseTestSql(runtimeUrl, runId, 'migration')

  try {
    await assertNoConflictingDatabaseTestConnections(sql, runId)
    const sourceDirectory = join(process.cwd(), 'src/db/migrations')
    const expected = await buildExpectedMigrationSequence(sourceDirectory)
    const existingSchema = await sql<{ readonly schema: string | null }[]>`
      SELECT to_regnamespace('app_private') AS schema
    `

    if (existingSchema[0]?.schema !== null) {
      const actualBeforeMigration = await readActualMigrationSequence(sql)
      assertMigrationSequence(expected, actualBeforeMigration, 'prefix')
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

    const actual = await readActualMigrationSequence(sql)
    expect(() => assertExactMigrationSequence(expected, actual)).not.toThrow()
  } finally {
    await sql.end({ timeout: 0 })
  }
}

export function registerPersistentDatabasePreparation(): void {
  test('prepares the persistent test database', async (context) => {
    if (!databaseTestMode.enabled || databaseTestMode.cleanupStale) {
      context.skip()
      return
    }
    context.onTestFinished(
      () => waitForDatabaseTestAbortCleanup(context.signal),
      30_000,
    )
    await runAbortableDatabasePhase(
      'migration compatibility',
      context.signal,
      preparePersistentTestDatabase,
    )
    persistentDatabasePrepared = true
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
      context.onTestFinished(
        () => waitForDatabaseTestAbortCleanup(context.signal),
        30_000,
      )
      await runAbortableDatabasePhase(label, context.signal, async (signal) => {
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
