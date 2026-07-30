import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import { loadProductionMigrationTarget } from '../dist/db/migration-release.js'
import { runManagedChildProcess } from './managed-child-process.mjs'

const manifest = JSON.parse(
  await readFile('dist/db/database-targets.manifest.json', 'utf8'),
)

loadProductionMigrationTarget(process.env, manifest)

const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const { completion } = runManagedChildProcess(
  command,
  ['exec', 'drizzle-kit', 'migrate', '--config', 'drizzle.release.config.ts'],
  {
    cwd: process.cwd(),
    env: process.env,
    signalErrorMessage: '线上迁移进程异常终止。',
    stdio: 'inherit',
  },
)
const exitCode = await completion

if (exitCode !== 0) {
  throw new Error('线上迁移失败。')
}
