import { drizzle } from 'drizzle-orm/postgres-js'
import postgres, { type Sql } from 'postgres'

export interface DatabaseClient {
  readonly sql: Sql
  readonly db: ReturnType<typeof drizzle>
  close(): Promise<void>
}

export function createDatabaseClient(
  databaseUrl: string,
  sqlFactory: typeof postgres = postgres,
  options: { readonly max?: number } = {},
): DatabaseClient {
  const sql = sqlFactory(databaseUrl, {
    ssl: 'require',
    prepare: false,
    ...options,
  })

  return {
    sql,
    db: drizzle({ client: sql }),
    async close() {
      await sql.end()
    },
  }
}
