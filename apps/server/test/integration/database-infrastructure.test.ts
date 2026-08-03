import { join } from 'node:path'
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
