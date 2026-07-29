import { describe, expect, test } from 'vitest'
import {
  loadIsolatedTestDatabaseUrl,
  normalizeDatabaseAddress,
  TestDatabaseSafetyError,
} from '../../src/db/test-database-safety.js'

const testDatabaseUrl =
  'postgres://postgres.project-ref:test-secret@db.project-ref.supabase.co:5432/postgres'

describe('test database safety gate', () => {
  test('normalizes postgres and postgresql URLs as the same address', () => {
    expect(normalizeDatabaseAddress(testDatabaseUrl)).toBe(
      normalizeDatabaseAddress(
        testDatabaseUrl.replace('postgres:', 'postgresql:'),
      ),
    )
  })

  test.each(['DATABASE_URL', 'DATABASE_MIGRATION_URL'] as const)(
    'rejects a %s address equivalent to TEST_DATABASE_URL',
    (variable) => {
      expect(() =>
        loadIsolatedTestDatabaseUrl({
          TEST_DATABASE_URL: testDatabaseUrl,
          [variable]: testDatabaseUrl.replace('postgres:', 'postgresql:'),
        }),
      ).toThrow(TestDatabaseSafetyError)
    },
  )
})
