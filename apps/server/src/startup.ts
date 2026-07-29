import { fileURLToPath } from 'node:url'
import {
  assertExactMigrationSequence,
  buildExpectedMigrationSequence,
  MigrationCompatibilityError,
  readActualMigrationSequence,
} from './db/migration-compatibility.js'
import { createDatabaseClient, type DatabaseClient } from './db/client.js'
import type { ServerConfig } from './config.js'

export type StartupFailure =
  | 'databaseConnectionFailed'
  | 'migrationRecordsMissing'
  | 'schemaVersionIncompatible'

const startupFailureMessages: Readonly<Record<StartupFailure, string>> = {
  databaseConnectionFailed: '数据库连接失败，服务未启动。',
  migrationRecordsMissing: '数据库迁移记录缺失，服务未启动。',
  schemaVersionIncompatible: '数据库结构版本不兼容，服务未启动。',
}

export class StartupError extends Error {
  public constructor(
    public readonly failure: StartupFailure,
    options?: ErrorOptions,
  ) {
    super(startupFailureMessages[failure], options)
    this.name = 'StartupError'
  }
}

export interface StartupDependencies {
  readonly createDatabaseClient?: typeof createDatabaseClient
  readonly migrationsDirectory?: string
}

function getPostgresErrorCode(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code
  }

  return undefined
}

function toStartupError(error: unknown): StartupError {
  if (error instanceof StartupError) {
    return error
  }

  if (error instanceof MigrationCompatibilityError) {
    return new StartupError(error.failure, { cause: error })
  }

  const errorCode = getPostgresErrorCode(error)

  if (errorCode === '3F000' || errorCode === '42P01') {
    return new StartupError('migrationRecordsMissing', { cause: error })
  }

  return new StartupError('databaseConnectionFailed', { cause: error })
}

function getRuntimeMigrationsDirectory(): string {
  return fileURLToPath(new URL('./db/migrations/', import.meta.url))
}

export async function initializeDatabase(
  config: ServerConfig,
  dependencies: StartupDependencies = {},
): Promise<DatabaseClient> {
  const createClient = dependencies.createDatabaseClient ?? createDatabaseClient
  const migrationsDirectory =
    dependencies.migrationsDirectory ?? getRuntimeMigrationsDirectory()
  let client: DatabaseClient | undefined

  try {
    client = createClient(config.getDatabaseUrl())
    await client.sql`SELECT 1`

    const [expected, actual] = await Promise.all([
      buildExpectedMigrationSequence(migrationsDirectory),
      readActualMigrationSequence(client.sql),
    ])
    assertExactMigrationSequence(expected, actual)

    return client
  } catch (error) {
    if (client !== undefined) {
      try {
        await client.close()
      } catch {
        // Keep the original startup failure private and fail closed.
      }
    }

    throw toStartupError(error)
  }
}
