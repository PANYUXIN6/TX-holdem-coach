import { defineConfig } from 'drizzle-kit'
import { loadIsolatedTestDatabaseUrl } from './src/db/test-database-safety.js'

const testDatabaseUrl = loadIsolatedTestDatabaseUrl(process.env)

const url = new URL(testDatabaseUrl)

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: process.env.TEST_MIGRATIONS_OUT ?? './src/db/migrations',
  dbCredentials: {
    host: url.hostname,
    port: Number(url.port || '5432'),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    ssl: false,
  },
  migrations: {
    schema: 'app_private',
    table: '__drizzle_migrations',
  },
})
