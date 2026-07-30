import { defineConfig } from 'drizzle-kit'
import { parseSupabaseDatabaseUrl } from './src/db/database-url-policy.js'
import { loadTestDatabaseConnections } from './src/db/test-database-safety.js'

const { migrationUrl } = loadTestDatabaseConnections(process.env)
const { connection } = parseSupabaseDatabaseUrl(migrationUrl, 'migration')

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dbCredentials: {
    ...connection,
    ssl: 'require',
  },
  migrations: {
    schema: 'app_private',
    table: '__drizzle_migrations',
  },
})
