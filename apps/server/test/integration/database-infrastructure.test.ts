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
import { assertM22DatabaseSchema } from './database-schema-assertions.js'
import { assertM32SessionCreation } from './database-m32-assertions.js'
import { assertM33PlayerActionHandCompletion } from './database-m33-assertions.js'
import { assertM34RebuyNextHandSessionEnd } from './database-m34-assertions.js'
import { assertM35HttpAndAtomicSettings } from './database-m35-assertions.js'
import { assertM36PublicProjectionRuntime } from './database-m36-assertions.js'
import { assertM37SessionEventReplay } from './database-m37-assertions.js'
import {
  assertM24M25AtomicComposition,
  assertM23Repositories,
  assertM24CommandLedgerRepository,
  assertM25SessionMutationRepository,
  assertM26SessionRecoveryRepository,
  assertM27HandAgentAuditRepositories,
  assertM28CoachDeletionContention,
  assertM28CurrentCatalogCreationContention,
  assertM28HistoricalCandidateContention,
  assertM28HistoricalClearContention,
  assertM28PlayerDeletionContention,
  assertM28SessionDataDeletionRepositories,
  assertM31SessionCommandExecutor,
} from './database-repository-assertions.js'
import {
  assertNoConflictingDatabaseTestConnections,
  createDatabaseTestSql,
  runTimedDatabasePhase,
  shouldRunDatabaseMilestone,
  terminateConflictingDatabaseTestConnections,
} from './database-test-runtime.js'

const databaseTestMode = loadDatabaseTestMode(process.env)
let persistentDatabasePrepared = false

function requireDatabaseTestRunId(): string {
  if (databaseTestMode.runId === null) {
    throw new Error('数据库测试缺少 Run ID。')
  }
  return databaseTestMode.runId
}

async function preparePersistentTestDatabase(): Promise<void> {
  const { runtimeUrl } = loadTestDatabaseConnections(process.env)
  const runId = requireDatabaseTestRunId()
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
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

    const execFileAsync = promisify(execFile)
    const runMigrate = async (): Promise<void> => {
      await execFileAsync(
        process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
        [
          'exec',
          'drizzle-kit',
          'migrate',
          '--config',
          'drizzle.integration.config.ts',
        ],
        {
          cwd: join(process.cwd()),
          env: process.env,
        },
      )
    }

    await runMigrate()

    const actual = await readActualMigrationSequence(sql)
    expect(() => assertExactMigrationSequence(expected, actual)).not.toThrow()
  } finally {
    await sql.end({ timeout: 0 })
  }
}

test('prepares the persistent test database', async (context) => {
  if (!databaseTestMode.enabled || databaseTestMode.cleanupStale) {
    context.skip()
    return
  }
  await runTimedDatabasePhase(
    'migration compatibility',
    preparePersistentTestDatabase,
  )
  persistentDatabasePrepared = true
}, 180_000)

function registerMilestoneTest(
  milestone: NonNullable<typeof databaseTestMode.milestone>,
  label: string,
  assertion: (sql: Sql, runtimeUrl: string) => Promise<void>,
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
      const { runtimeUrl } = loadTestDatabaseConnections(process.env)
      const runId = requireDatabaseTestRunId()
      const sql = createDatabaseTestSql(
        runtimeUrl,
        runId,
        `${milestone}-primary`,
      )
      try {
        await assertNoConflictingDatabaseTestConnections(sql, runId)
        await runTimedDatabasePhase(label, () => assertion(sql, runtimeUrl))
      } finally {
        await sql.end({ timeout: 0 })
      }
    },
    timeout,
  )
}

registerMilestoneTest('m22', 'M2.2 schema', assertM22DatabaseSchema, 300_000)
registerMilestoneTest('m23', 'M2.3 repositories', (sql) =>
  assertM23Repositories(sql),
)
registerMilestoneTest('m24', 'M2.4 command ledger', (sql, runtimeUrl) =>
  assertM24CommandLedgerRepository(sql, runtimeUrl),
)
registerMilestoneTest(
  'm25',
  'M2.5 mutation and composition',
  async (sql, runtimeUrl) => {
    await assertM25SessionMutationRepository(sql, runtimeUrl)
    await assertM24M25AtomicComposition(sql)
  },
)
registerMilestoneTest(
  'm26',
  'M2.6 recovery',
  (sql, runtimeUrl) => assertM26SessionRecoveryRepository(sql, runtimeUrl),
  300_000,
)
registerMilestoneTest(
  'm27',
  'M2.7 audit persistence',
  (sql, runtimeUrl) => assertM27HandAgentAuditRepositories(sql, runtimeUrl),
  300_000,
)
registerMilestoneTest('m28', 'M2.8 session data deletion', (sql, runtimeUrl) =>
  assertM28SessionDataDeletionRepositories(sql, runtimeUrl),
)
registerMilestoneTest(
  'm28',
  'M2.8 Player deletion contention',
  (sql, runtimeUrl) => assertM28PlayerDeletionContention(sql, runtimeUrl),
)
registerMilestoneTest(
  'm31',
  'M3.1 session command executor',
  (sql, runtimeUrl) => assertM31SessionCommandExecutor(sql, runtimeUrl),
  300_000,
)
registerMilestoneTest(
  'm32',
  'M3.2 session creation and roster snapshot',
  (sql, runtimeUrl) => assertM32SessionCreation(sql, runtimeUrl),
  600_000,
)
registerMilestoneTest(
  'm33',
  'M3.3 player action and hand completion',
  (sql, runtimeUrl) => assertM33PlayerActionHandCompletion(sql, runtimeUrl),
  300_000,
)
registerMilestoneTest(
  'm34',
  'M3.4 rebuy, next hand, and session end',
  (sql, runtimeUrl) => assertM34RebuyNextHandSessionEnd(sql, runtimeUrl),
  300_000,
)
registerMilestoneTest(
  'm35',
  'M3.5 HTTP, transactions, and atomic Player settings',
  (sql, runtimeUrl) => assertM35HttpAndAtomicSettings(sql, runtimeUrl),
  300_000,
)
registerMilestoneTest(
  'm36',
  'M3.6 public projection runtime',
  (sql, runtimeUrl) => assertM36PublicProjectionRuntime(sql, runtimeUrl),
  300_000,
)
registerMilestoneTest(
  'm37',
  'M3.7 SSE reconnection and event replay',
  (sql, runtimeUrl) => assertM37SessionEventReplay(sql, runtimeUrl),
  300_000,
)
registerMilestoneTest(
  'm28',
  'M2.8 Coach deletion contention',
  (sql, runtimeUrl) => assertM28CoachDeletionContention(sql, runtimeUrl),
)
registerMilestoneTest(
  'm28',
  'M2.8 current catalog creation contention',
  (sql, runtimeUrl) =>
    assertM28CurrentCatalogCreationContention(sql, runtimeUrl),
)
registerMilestoneTest(
  'm28',
  'M2.8 historical clear contention',
  (sql, runtimeUrl) => assertM28HistoricalClearContention(sql, runtimeUrl),
)
registerMilestoneTest(
  'm28',
  'M2.8 historical candidate contention',
  (sql, runtimeUrl) => assertM28HistoricalCandidateContention(sql, runtimeUrl),
)

test('cleans stale tagged database test transactions', async (context) => {
  if (!databaseTestMode.enabled || !databaseTestMode.cleanupStale) {
    context.skip()
    return
  }
  const { runtimeUrl } = loadTestDatabaseConnections(process.env)
  const runId = requireDatabaseTestRunId()
  const sql = createDatabaseTestSql(runtimeUrl, runId, 'cleanup')
  try {
    const terminatedPids = await terminateConflictingDatabaseTestConnections(
      sql,
      runId,
    )
    process.stderr.write(
      `[database-test] CLEANUP terminated ${terminatedPids.length} transaction(s)${
        terminatedPids.length === 0 ? '' : `: ${terminatedPids.join(', ')}`
      }\n`,
    )
  } finally {
    await sql.end({ timeout: 0 })
  }
}, 60_000)
