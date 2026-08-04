import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { parseEnv } from 'node:util'
import {
  createDatabaseTestPlanEnvironment,
  parseDatabaseTestArguments,
} from './database-test-plan.mjs'
import { runManagedChildProcess } from './managed-child-process.mjs'

const TEST_ENVIRONMENT_KEYS = [
  'TEST_DATABASE_URL',
  'TEST_DATABASE_MIGRATION_URL',
]
const CHILD_ENVIRONMENT_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
  'CI',
  'GITHUB_ACTIONS',
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'FORCE_COLOR',
  'NO_COLOR',
]
const commandArguments = process.argv.slice(2)
const testPlan = parseDatabaseTestArguments(commandArguments)

async function loadTestEnvironment() {
  try {
    const contents = await readFile('.env.test.local', 'utf8')
    const parsed = parseEnv(contents)
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

const testEnvironment = await loadTestEnvironment()

for (const key of TEST_ENVIRONMENT_KEYS) {
  if (testEnvironment[key] === undefined) {
    throw new Error('测试数据库凭据未配置。')
  }
}

const childEnvironment = Object.fromEntries(
  CHILD_ENVIRONMENT_KEYS.flatMap((key) => {
    const value = process.env[key]
    return value === undefined ? [] : [[key, value]]
  }),
)

Object.assign(childEnvironment, testEnvironment)
Object.assign(
  childEnvironment,
  createDatabaseTestPlanEnvironment(testPlan, randomBytes(8).toString('hex')),
)

const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const { completion } = runManagedChildProcess(
  command,
  ['exec', 'vitest', 'run', 'test/integration/database-infrastructure.test.ts'],
  {
    cwd: process.cwd(),
    env: childEnvironment,
    signalErrorMessage: '数据库集成测试进程异常终止。',
    stdio: 'inherit',
  },
)
const exitCode = await completion

if (exitCode !== 0) {
  process.exitCode = exitCode
}
