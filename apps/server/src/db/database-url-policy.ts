const SUPABASE_SHARED_POOLER_HOST_PATTERN =
  /^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/
const SUPABASE_DIRECT_HOST_PATTERN = /^db\.([a-z0-9]+)\.supabase\.co$/
const SUPABASE_POOLER_USER_PATTERN = /^postgres\.([a-z0-9]+)$/

export type DatabaseUrlRole = 'runtime' | 'migration'

export interface DatabaseConnection {
  readonly host: string
  readonly port: number
  readonly user: string
  readonly password: string
  readonly database: string
}

export interface ParsedSupabaseDatabaseUrl {
  readonly projectRef: string
  readonly connection: DatabaseConnection
}

export class DatabaseUrlPolicyError extends Error {
  public constructor() {
    super('Supabase 数据库连接配置无效。')
    this.name = 'DatabaseUrlPolicyError'
  }
}

export function parseSupabaseDatabaseUrl(
  value: string,
  role: DatabaseUrlRole,
): ParsedSupabaseDatabaseUrl {
  try {
    const url = new URL(value)
    const user = decodeURIComponent(url.username)
    const password = decodeURIComponent(url.password)
    const database = decodeURIComponent(url.pathname.slice(1))
    const userMatch = SUPABASE_POOLER_USER_PATTERN.exec(user)
    const directHostMatch = SUPABASE_DIRECT_HOST_PATTERN.exec(url.hostname)
    const isRuntimeUrl =
      role === 'runtime' &&
      SUPABASE_SHARED_POOLER_HOST_PATTERN.test(url.hostname) &&
      url.port === '6543' &&
      userMatch !== null
    const isMigrationPoolerUrl =
      role === 'migration' &&
      SUPABASE_SHARED_POOLER_HOST_PATTERN.test(url.hostname) &&
      url.port === '5432' &&
      userMatch !== null
    const isMigrationDirectUrl =
      role === 'migration' &&
      directHostMatch !== null &&
      url.port === '5432' &&
      user === 'postgres'

    if (
      (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') ||
      (!isRuntimeUrl && !isMigrationPoolerUrl && !isMigrationDirectUrl) ||
      password.length === 0 ||
      password === '[YOUR-PASSWORD]' ||
      database !== 'postgres'
    ) {
      throw new DatabaseUrlPolicyError()
    }

    return {
      projectRef: userMatch?.[1] ?? directHostMatch![1]!,
      connection: {
        host: url.hostname,
        port: Number(url.port),
        user,
        password,
        database,
      },
    }
  } catch (error) {
    if (error instanceof DatabaseUrlPolicyError) {
      throw error
    }

    throw new DatabaseUrlPolicyError()
  }
}
