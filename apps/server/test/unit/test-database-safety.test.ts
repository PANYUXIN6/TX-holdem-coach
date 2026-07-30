import { describe, expect, test } from 'vitest'
import {
  loadTestDatabaseConnections,
  TestDatabaseSafetyError,
} from '../../src/db/test-database-safety.js'

const testRuntimeUrl =
  'postgresql://postgres.wlxjauqsesrmcyghibsr:runtime-secret@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres'
const testMigrationUrl =
  'postgresql://postgres.wlxjauqsesrmcyghibsr:migration-secret@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres'

describe('test database safety gate', () => {
  test('uses only the two test URLs and the repository target registry', () => {
    expect(
      loadTestDatabaseConnections({
        TEST_DATABASE_URL: testRuntimeUrl,
        TEST_DATABASE_MIGRATION_URL: testMigrationUrl,
        TEST_SUPABASE_PROJECT_REF: 'hsdyjpghsmqmdpqvufdw',
        PRODUCTION_SUPABASE_PROJECT_REF: 'wlxjauqsesrmcyghibsr',
        DATABASE_URL:
          'postgresql://postgres.wlxjauqsesrmcyghibsr:production-secret@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres',
      }),
    ).toStrictEqual({
      runtimeUrl: testRuntimeUrl,
      migrationUrl: testMigrationUrl,
      projectRef: 'wlxjauqsesrmcyghibsr',
    })
  })

  test.each([
    {
      name: 'an unregistered runtime project',
      runtimeUrl: testRuntimeUrl.replace(
        'wlxjauqsesrmcyghibsr',
        'aaaaaaaaaaaaaaaaaaaa',
      ),
      migrationUrl: testMigrationUrl,
    },
    {
      name: 'an unregistered migration project',
      runtimeUrl: testRuntimeUrl,
      migrationUrl: testMigrationUrl.replace(
        'wlxjauqsesrmcyghibsr',
        'aaaaaaaaaaaaaaaaaaaa',
      ),
    },
    {
      name: 'the production project',
      runtimeUrl: testRuntimeUrl.replace(
        'wlxjauqsesrmcyghibsr',
        'hsdyjpghsmqmdpqvufdw',
      ),
      migrationUrl: testMigrationUrl.replace(
        'wlxjauqsesrmcyghibsr',
        'hsdyjpghsmqmdpqvufdw',
      ),
    },
  ])('rejects $name', ({ runtimeUrl, migrationUrl }) => {
    expect(() =>
      loadTestDatabaseConnections({
        TEST_DATABASE_URL: runtimeUrl,
        TEST_DATABASE_MIGRATION_URL: migrationUrl,
      }),
    ).toThrow(TestDatabaseSafetyError)
  })
})
