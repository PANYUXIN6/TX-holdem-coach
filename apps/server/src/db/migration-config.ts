import { parseSupabaseDatabaseUrl } from './database-url-policy.js'
import type { DatabaseConnection } from './database-url-policy.js'

export type MigrationDatabaseConnection = DatabaseConnection

export class MigrationConfigurationError extends Error {
  public constructor(options?: ErrorOptions) {
    super('数据库迁移配置无效，请检查部署环境变量。', options)
    this.name = 'MigrationConfigurationError'
  }
}

export function loadMigrationDatabaseConnection(
  environment: NodeJS.ProcessEnv,
): MigrationDatabaseConnection {
  try {
    const value = environment.DATABASE_MIGRATION_URL

    if (value === undefined) {
      throw new MigrationConfigurationError()
    }

    return parseSupabaseDatabaseUrl(value, 'migration').connection
  } catch (error) {
    if (error instanceof MigrationConfigurationError) {
      throw error
    }

    throw new MigrationConfigurationError({ cause: error })
  }
}
