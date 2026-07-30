import { describe, expect, test } from 'vitest'
import { loadDatabaseTestMode } from '../../src/db/database-test-mode.js'

describe('database integration test mode', () => {
  test('stays disabled when ordinary verification inherits database variables', () => {
    expect(
      loadDatabaseTestMode({
        TEST_DATABASE_URL: 'postgresql://runtime.example',
        TEST_DATABASE_MIGRATION_URL: 'postgresql://migration.example',
        DATABASE_TEST_SCOPE: 'full',
      }),
    ).toEqual({ enabled: false, full: false })
  })

  test.each([
    [undefined, false],
    ['full', true],
  ])('accepts the explicit launcher scope %s', (scope, full) => {
    expect(
      loadDatabaseTestMode({
        DATABASE_TEST_ENTRYPOINT: 'run-database-integration-tests',
        DATABASE_TEST_SCOPE: scope,
      }),
    ).toEqual({ enabled: true, full })
  })
})
