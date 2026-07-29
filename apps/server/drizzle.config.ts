import { defineConfig } from 'drizzle-kit'
import { loadMigrationDatabaseConnection } from './src/db/migration-config.js'

const connection = loadMigrationDatabaseConnection(process.env)

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dbCredentials: {
    host: connection.host,
    port: connection.port,
    user: connection.user,
    password: connection.password,
    database: connection.database,
    ssl: 'require',
  },
  migrations: {
    schema: 'app_private',
    table: '__drizzle_migrations',
  },
})
