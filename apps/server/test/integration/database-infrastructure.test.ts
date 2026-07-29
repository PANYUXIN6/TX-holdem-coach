import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import {
  assertExactMigrationSequence,
  buildExpectedMigrationSequence,
  readActualMigrationSequence,
} from '../../src/db/migration-compatibility.js'
import { loadIsolatedTestDatabaseUrl } from '../../src/db/test-database-safety.js'

const temporaryDirectories: string[] = []

async function runIntegrationTest(): Promise<void> {
  const testDatabaseUrl = loadIsolatedTestDatabaseUrl(process.env)

  const postgres = (await import('postgres')).default
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const sql = postgres(testDatabaseUrl, { max: 1 })

  try {
    const existingSchema = await sql<{ readonly schema: string | null }[]>`
      SELECT to_regnamespace('app_private') AS schema
    `

    if (existingSchema[0]?.schema !== null) {
      throw new Error('TEST_DATABASE_URL must target an empty database.')
    }

    const execFileAsync = promisify(execFile)
    const runMigrate = async (migrationsDirectory?: string): Promise<void> => {
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
          env: {
            ...process.env,
            ...(migrationsDirectory === undefined
              ? {}
              : { TEST_MIGRATIONS_OUT: migrationsDirectory }),
          },
        },
      )
    }

    await runMigrate()

    const sourceDirectory = join(process.cwd(), 'src/db/migrations')
    const expected = await buildExpectedMigrationSequence(sourceDirectory)
    const actual = await readActualMigrationSequence(sql)
    expect(actual).toHaveLength(1)
    expect(() => assertExactMigrationSequence(expected, actual)).not.toThrow()

    const failingDirectory = await mkdtemp(
      join(tmpdir(), 'poker-failing-migrations-'),
    )
    temporaryDirectories.push(failingDirectory)
    await cp(sourceDirectory, failingDirectory, { recursive: true })
    await writeFile(
      join(failingDirectory, '0001_intentional_failure.sql'),
      'CREATE TABLE app_private.failed_migration_marker (id integer);\nTHIS IS INVALID SQL;',
    )
    const journalPath = join(failingDirectory, 'meta/_journal.json')
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
      entries: unknown[]
    }
    journal.entries.push({
      idx: 1,
      version: '7',
      when: 1_785_318_513_388,
      tag: '0001_intentional_failure',
      breakpoints: true,
    })
    await writeFile(journalPath, JSON.stringify(journal))

    await expect(runMigrate(failingDirectory)).rejects.toThrow()

    const [records, failedTable] = await Promise.all([
      sql<{ readonly count: string }[]>`
        SELECT count(*)::text AS count
        FROM app_private.__drizzle_migrations
      `,
      sql<{ readonly table: string | null }[]>`
        SELECT to_regclass('app_private.failed_migration_marker') AS table
      `,
    ])
    expect(records[0]?.count).toBe('1')
    expect(failedTable[0]?.table).toBeNull()
  } finally {
    await sql.end()
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  )
})

test('migrates an isolated empty PostgreSQL database and rolls back failed migrations', async (context) => {
  if (process.env.TEST_DATABASE_URL === undefined) {
    context.skip()
    return
  }

  await runIntegrationTest()
})
