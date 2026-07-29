import { z } from 'zod'

const SUPABASE_SHARED_POOLER_HOST_PATTERN =
  /^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/
const SUPABASE_DIRECT_HOST_PATTERN = /^db\.[a-z0-9-]+\.supabase\.co$/

const migrationDatabaseUrlSchema = z
  .string()
  .trim()
  .min(1)
  .superRefine((value, context) => {
    let url: URL
    let password: string
    let databaseName: string

    try {
      url = new URL(value)
      password = decodeURIComponent(url.password)
      databaseName = decodeURIComponent(url.pathname.slice(1))
    } catch {
      context.addIssue({ code: 'custom', message: 'Invalid PostgreSQL URL.' })
      return
    }

    const isSupabaseHost =
      SUPABASE_SHARED_POOLER_HOST_PATTERN.test(url.hostname) ||
      SUPABASE_DIRECT_HOST_PATTERN.test(url.hostname)
    const isValid =
      (url.protocol === 'postgres:' || url.protocol === 'postgresql:') &&
      isSupabaseHost &&
      url.port === '5432' &&
      url.username.length > 0 &&
      password.length > 0 &&
      password !== '[YOUR-PASSWORD]' &&
      databaseName.length > 0

    if (!isValid) {
      context.addIssue({
        code: 'custom',
        message: 'Invalid Supabase migration URL.',
      })
    }
  })

export interface MigrationDatabaseConnection {
  readonly host: string
  readonly port: number
  readonly user: string
  readonly password: string
  readonly database: string
}

export class MigrationConfigurationError extends Error {
  public constructor() {
    super('数据库迁移配置无效，请检查部署环境变量。')
    this.name = 'MigrationConfigurationError'
  }
}

export function loadMigrationDatabaseConnection(
  environment: NodeJS.ProcessEnv,
): MigrationDatabaseConnection {
  const result = migrationDatabaseUrlSchema.safeParse(
    environment.DATABASE_MIGRATION_URL,
  )

  if (!result.success) {
    throw new MigrationConfigurationError()
  }

  const url = new URL(result.data)

  return {
    host: url.hostname,
    port: Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
  }
}
