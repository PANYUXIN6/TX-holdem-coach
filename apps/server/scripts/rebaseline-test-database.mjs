import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import postgres from 'postgres'
import {
  assertExactMigrationSequence,
  readActualMigrationSequence,
} from '../dist/db/migration-compatibility.js'
import { verifySingleBaselineMigrationAssets } from '../dist/db/migration-artifact.js'
import {
  acquireDatabaseTestSuiteLock,
  bindDatabaseTestClientToSuiteLock,
} from '../dist/db/database-test-suite-lock.js'
import {
  DATABASE_TEST_APPLICATION_PREFIX,
  loadTestDatabaseConnections,
} from '../dist/db/test-database-safety.js'
import { runManagedChildProcess } from './managed-child-process.mjs'

const CONFIRMATION_ARGUMENT = '--confirm-test-schema-reset'
const TEST_ENVIRONMENT_KEYS = [
  'TEST_DATABASE_URL',
  'TEST_DATABASE_MIGRATION_URL',
]
const serverDirectory = dirname(dirname(fileURLToPath(import.meta.url)))

const commandArguments = process.argv.slice(2)
const confirmationArguments =
  commandArguments[0] === '--' ? commandArguments.slice(1) : commandArguments
if (
  confirmationArguments.length !== 1 ||
  confirmationArguments[0] !== CONFIRMATION_ARGUMENT
) {
  throw new Error(`远程测试库重基线必须显式传入 ${CONFIRMATION_ARGUMENT}。`)
}

async function loadTestEnvironment() {
  try {
    const parsed = parseEnv(
      await readFile(`${serverDirectory}/.env.test.local`, 'utf8'),
    )
    const unexpectedKeys = Object.keys(parsed).filter(
      (key) => !TEST_ENVIRONMENT_KEYS.includes(key),
    )
    if (unexpectedKeys.length > 0) {
      throw new Error('.env.test.local 只能包含两条测试数据库 URL。')
    }
    return parsed
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return Object.fromEntries(
        TEST_ENVIRONMENT_KEYS.flatMap((key) => {
          const value = process.env[key]
          return value === undefined ? [] : [[key, value]]
        }),
      )
    }
    throw error
  }
}

function createConnectionOptions(runId, role) {
  return {
    connect_timeout: 30,
    max: 1,
    prepare: false,
    ssl: 'require',
    connection: {
      application_name: `${DATABASE_TEST_APPLICATION_PREFIX}:${runId}:${role}`,
      statement_timeout: 90_000,
      idle_in_transaction_session_timeout: 60_000,
    },
  }
}

const expected = await verifySingleBaselineMigrationAssets(
  `${serverDirectory}/src/db/migrations`,
)
const testEnvironment = await loadTestEnvironment()
const environment = { ...process.env, ...testEnvironment }
const { runtimeUrl, migrationUrl, projectRef } =
  loadTestDatabaseConnections(environment)
const runId = randomBytes(8).toString('hex')
const lockSql = postgres(
  runtimeUrl,
  createConnectionOptions(runId, 'suite-lock'),
)
const migrationSql = postgres(
  migrationUrl,
  createConnectionOptions(runId, 'rebaseline'),
)

try {
  const suiteLock = await acquireDatabaseTestSuiteLock(lockSql)
  const unbindMigrationSql = bindDatabaseTestClientToSuiteLock(
    migrationSql,
    suiteLock,
  )
  try {
    suiteLock.signal.throwIfAborted()
    const conflictingRows = await migrationSql`
      SELECT pid
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name LIKE ${`${DATABASE_TEST_APPLICATION_PREFIX}:%`}
        AND application_name NOT LIKE ${`${DATABASE_TEST_APPLICATION_PREFIX}:${runId}:%`}
        AND xact_start IS NOT NULL
    `
    if (conflictingRows.length > 0) {
      throw new Error(
        '检测到其他数据库测试事务，未执行重基线。请先运行 db:test:cleanup。',
      )
    }

    const beforeRows = await migrationSql`
      SELECT
        to_regclass('app_private.__drizzle_migrations') IS NOT NULL AS "journalExists"
    `
    let previousMigrationCount = 0
    if (beforeRows[0]?.journalExists === true) {
      const countRows = await migrationSql`
        SELECT count(*)::int AS count
        FROM app_private.__drizzle_migrations
      `
      previousMigrationCount = countRows[0]?.count ?? 0
    }

    suiteLock.signal.throwIfAborted()
    await migrationSql`DROP SCHEMA IF EXISTS app_private CASCADE`
    const droppedRows = await migrationSql`
      SELECT to_regnamespace('app_private') IS NULL AS dropped
    `
    if (droppedRows[0]?.dropped !== true) {
      throw new Error('远程测试 schema 未成功删除。')
    }

    const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
    const { completion } = runManagedChildProcess(
      command,
      [
        'exec',
        'drizzle-kit',
        'migrate',
        '--config',
        'drizzle.integration.config.ts',
      ],
      {
        cwd: serverDirectory,
        env: environment,
        signal: suiteLock.signal,
        signalErrorMessage: '远程测试库 baseline 迁移进程异常终止。',
        stdio: 'inherit',
      },
    )
    const exitCode = await completion
    if (exitCode !== 0) {
      throw new Error(`远程测试库 baseline 迁移失败，退出码 ${exitCode}。`)
    }

    suiteLock.signal.throwIfAborted()
    const actual = await readActualMigrationSequence(migrationSql)
    assertExactMigrationSequence(expected, actual)
    if (actual.length !== 1) {
      throw new Error('远程测试库未收敛为唯一 baseline journal。')
    }

    process.stdout.write(
      `[database-test] REBASELINED test project ${projectRef}; previous migrations=${previousMigrationCount}; current migrations=${actual.length}\n`,
    )
  } finally {
    try {
      await suiteLock.release()
    } finally {
      unbindMigrationSql()
    }
  }
} finally {
  await Promise.allSettled([
    migrationSql.end({ timeout: 0 }),
    lockSql.end({ timeout: 0 }),
  ])
}
