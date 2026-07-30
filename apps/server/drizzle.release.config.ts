import { defineConfig } from 'drizzle-kit'
import { loadMigrationDatabaseConnection } from './src/db/migration-config.js'

const connection = loadMigrationDatabaseConnection(process.env)

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './dist/db/migrations',
  dbCredentials: {
    ...connection,
    ssl: 'require',
  },
  migrations: {
    schema: 'app_private',
    table: '__drizzle_migrations',
  },
})
