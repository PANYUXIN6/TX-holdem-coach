import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
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
import {
  assertM24M25AtomicComposition,
  assertM23Repositories,
  assertM24CommandLedgerRepository,
  assertM25SessionMutationRepository,
  assertM26SessionRecoveryRepository,
} from './database-repository-assertions.js'

const databaseTestMode = loadDatabaseTestMode(process.env)
const runFullSchemaValidation = databaseTestMode.full

async function runIntegrationTest(): Promise<void> {
  const { runtimeUrl } = loadTestDatabaseConnections(process.env)

  const postgres = (await import('postgres')).default
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const sql = postgres(runtimeUrl, {
    connect_timeout: 10,
    max: 1,
    prepare: false,
    ssl: 'require',
  })

  try {
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

    if (runFullSchemaValidation) {
      await assertM22DatabaseSchema(sql, runtimeUrl)
      await assertM23Repositories(sql)
      await assertM24CommandLedgerRepository(sql, runtimeUrl)
      await assertM25SessionMutationRepository(sql, runtimeUrl)
      await assertM24M25AtomicComposition(sql)
      await assertM26SessionRecoveryRepository(sql, runtimeUrl)
    }
  } finally {
    await sql.end({ timeout: 0 })
  }
}

test(
  runFullSchemaValidation
    ? 'prepares the persistent test database and validates its full schema'
    : 'prepares the persistent test database',
  async (context) => {
    if (!databaseTestMode.enabled) {
      context.skip()
      return
    }

    await runIntegrationTest()
  },
  180_000,
)

async function applySqlMigrationFile(
  sql: import('postgres').Sql,
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
  if (!runFullSchemaValidation) {
    context.skip()
    return
  }

  const { migrationUrl } = loadTestDatabaseConnections(process.env)
  const postgres = (await import('postgres')).default
  const adminSql = postgres(migrationUrl, {
    connect_timeout: 10,
    max: 1,
    prepare: false,
    ssl: 'require',
  })
  const databaseName = `m26_upgrade_${randomBytes(8).toString('hex')}`
  let databaseCreated = false
  let disposableSql: import('postgres').Sql | undefined
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
    disposableSql = postgres(disposableUrl.toString(), {
      connect_timeout: 10,
      max: 1,
      prepare: false,
      ssl: 'require',
    })
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
}, 180_000)
