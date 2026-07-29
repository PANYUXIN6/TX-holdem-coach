import { describe, expect, test } from 'vitest'
import {
  loadMigrationDatabaseConnection,
  MigrationConfigurationError,
} from '../../src/db/migration-config.js'

const migrationUrl =
  'postgresql://postgres.project-ref:migration-secret@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres'

describe('migration database configuration', () => {
  test('reads only the 5432 Supabase migration URL', () => {
    expect(
      loadMigrationDatabaseConnection({
        DATABASE_MIGRATION_URL: migrationUrl,
        DATABASE_URL:
          'postgresql://postgres.project-ref:runtime-secret@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres',
      }),
    ).toStrictEqual({
      host: 'aws-0-ap-northeast-1.pooler.supabase.com',
      port: 5432,
      user: 'postgres.project-ref',
      password: 'migration-secret',
      database: 'postgres',
    })
  })

  test.each([
    undefined,
    migrationUrl.replace(':5432/', ':6543/'),
    'postgresql://postgres.project-ref:secret@db.example.com:5432/postgres',
  ])('rejects an invalid migration URL', (value) => {
    expect(() =>
      loadMigrationDatabaseConnection({ DATABASE_MIGRATION_URL: value }),
    ).toThrow(MigrationConfigurationError)
  })
})
