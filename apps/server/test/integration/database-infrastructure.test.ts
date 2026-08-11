import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
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

registerMilestoneTest('m22', 'M2.2 schema', assertM22DatabaseSchema)
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
  300_000,
)
registerMilestoneTest(
  'm33',
  'M3.3 player action and hand completion',
  (sql, runtimeUrl) => assertM33PlayerActionHandCompletion(sql, runtimeUrl),
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
})

async function applySqlMigrationFile(
  sql: Sql,
  migrationPath: string,
): Promise<void> {
  const contents = await readFile(migrationPath, 'utf8')
  for (const statement of contents.split('--> statement-breakpoint')) {
    if (statement.trim().length > 0) {
      await sql.unsafe(statement)
    }
  }
}

test('upgrades an isolated M2.5 database containing a legacy diagnostic Session', async (context) => {
  if (
    !databaseTestMode.enabled ||
    databaseTestMode.cleanupStale ||
    !persistentDatabasePrepared ||
    (!databaseTestMode.full && databaseTestMode.milestone !== 'm26')
  ) {
    context.skip()
    return
  }

  await runTimedDatabasePhase('M2.6 legacy schema upgrade', async () => {
    const { migrationUrl } = loadTestDatabaseConnections(process.env)
    const runId = requireDatabaseTestRunId()
    const adminSql = createDatabaseTestSql(migrationUrl, runId, 'upgrade-admin')
    const databaseName = `m26_upgrade_${randomBytes(8).toString('hex')}`
    let databaseCreated = false
    let disposableSql: Sql | undefined
    try {
      try {
        await adminSql.unsafe(`CREATE DATABASE "${databaseName}"`)
        databaseCreated = true
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === '42501'
        ) {
          context.skip('测试数据库账号没有创建隔离数据库的权限。')
          return
        }
        throw error
      }

      const disposableUrl = new URL(migrationUrl)
      disposableUrl.pathname = `/${databaseName}`
      disposableSql = createDatabaseTestSql(
        disposableUrl.toString(),
        runId,
        'upgrade-target',
      )
      const migrationDirectory = join(process.cwd(), 'src/db/migrations')
      for (const migrationName of [
        '0000_app_private_baseline.sql',
        '0001_cheerful_johnny_blaze.sql',
        '0002_unusual_rocket_racer.sql',
      ]) {
        await applySqlMigrationFile(
          disposableSql,
          join(migrationDirectory, migrationName),
        )
      }

      const ownerId = '11111111-1111-4111-8111-111111111111'
      const sessionId = '22222222-2222-4222-8222-222222222222'
      await disposableSql`
        ALTER TABLE app_private.sessions
        DISABLE TRIGGER sessions_roster_integrity
      `
      await disposableSql`
        INSERT INTO app_private.sessions (
          id,
          owner_id,
          lifecycle_status,
          ended_at,
          updated_at
        ) VALUES (
          ${sessionId}::uuid,
          ${ownerId}::uuid,
          'readonlyDiagnostic',
          '2026-08-01T08:00:00.000Z'::timestamptz,
          '2026-08-02T09:30:00.000Z'::timestamptz
        )
      `
      await disposableSql`
        ALTER TABLE app_private.sessions
        ENABLE TRIGGER sessions_roster_integrity
      `

      await applySqlMigrationFile(
        disposableSql,
        join(migrationDirectory, '0003_modern_supreme_intelligence.sql'),
      )
      const rows = await disposableSql<
        {
          readonly diagnosticCode: string | null
          readonly diagnosedAt: string | null
          readonly endedAt: string | null
        }[]
      >`
        SELECT
          diagnostic_code AS "diagnosticCode",
          diagnosed_at::text AS "diagnosedAt",
          ended_at::text AS "endedAt"
        FROM app_private.sessions
        WHERE id = ${sessionId}::uuid
      `
      expect(rows[0]?.diagnosticCode).toBe('legacyDiagnosticState')
      expect(rows[0]?.diagnosedAt).toContain('2026-08-02 09:30:00')
      expect(rows[0]?.endedAt).toContain('2026-08-01 08:00:00')

      await expect(disposableSql`
        UPDATE app_private.sessions
        SET diagnostic_code = NULL
        WHERE id = ${sessionId}::uuid
      `).rejects.toThrow()
    } finally {
      await disposableSql?.end({ timeout: 0 })
      if (databaseCreated) {
        await adminSql.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`)
      }
      await adminSql.end({ timeout: 0 })
    }
  })
}, 180_000)
