import { loadDatabaseTargets } from './database-targets.js'
import { parseSupabaseDatabaseUrl } from './database-url-policy.js'

export interface TestDatabaseConnections {
  readonly runtimeUrl: string
  readonly migrationUrl: string
  readonly projectRef: string
}

export class TestDatabaseSafetyError extends Error {
  public constructor(options?: ErrorOptions) {
    super('测试数据库配置无效或目标项目不受信任。', options)
    this.name = 'TestDatabaseSafetyError'
  }
}

export function loadTestDatabaseConnections(
  environment: NodeJS.ProcessEnv,
): TestDatabaseConnections {
  try {
    const runtimeUrl = environment.TEST_DATABASE_URL
    const migrationUrl = environment.TEST_DATABASE_MIGRATION_URL

    if (runtimeUrl === undefined || migrationUrl === undefined) {
      throw new TestDatabaseSafetyError()
    }

    const targets = loadDatabaseTargets()
    const runtime = parseSupabaseDatabaseUrl(runtimeUrl, 'runtime')
    const migration = parseSupabaseDatabaseUrl(migrationUrl, 'migration')
    const projectRef = targets.test.supabaseProjectRef

    if (
      runtime.projectRef !== projectRef ||
      migration.projectRef !== projectRef ||
      projectRef === targets.production.supabaseProjectRef
    ) {
      throw new TestDatabaseSafetyError()
    }

    return { runtimeUrl, migrationUrl, projectRef }
  } catch (error) {
    if (error instanceof TestDatabaseSafetyError) {
      throw error
    }

    throw new TestDatabaseSafetyError({ cause: error })
  }
}
