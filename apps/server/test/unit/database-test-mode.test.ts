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
    ).toEqual({
      enabled: false,
      full: false,
      milestone: null,
      cleanupStale: false,
      runId: null,
    })
  })

  test.each([
    [undefined, false],
    ['full', true],
  ])('accepts the explicit launcher scope %s', (scope, full) => {
    expect(
      loadDatabaseTestMode({
        DATABASE_TEST_ENTRYPOINT: 'run-database-integration-tests',
        DATABASE_TEST_SCOPE: scope,
        DATABASE_TEST_RUN_ID: '0123456789abcdef',
      }),
    ).toEqual({
      enabled: true,
      full,
      milestone: null,
      cleanupStale: false,
      runId: '0123456789abcdef',
    })
  })

  test('accepts one explicit allowlisted milestone', () => {
    expect(
      loadDatabaseTestMode({
        DATABASE_TEST_ENTRYPOINT: 'run-database-integration-tests',
        DATABASE_TEST_SCOPE: 'milestone',
        DATABASE_TEST_MILESTONE: 'm32',
        DATABASE_TEST_RUN_ID: '0123456789abcdef',
      }),
    ).toEqual({
      enabled: true,
      full: false,
      milestone: 'm32',
      cleanupStale: false,
      runId: '0123456789abcdef',
    })
  })

  test.each([
    [{ DATABASE_TEST_SCOPE: 'full' }, '数据库测试 Run ID 无效。'],
    [
      {
        DATABASE_TEST_SCOPE: 'milestone',
        DATABASE_TEST_MILESTONE: 'm29',
        DATABASE_TEST_RUN_ID: '0123456789abcdef',
      },
      '数据库测试里程碑无效。',
    ],
    [
      {
        DATABASE_TEST_SCOPE: 'full',
        DATABASE_TEST_MILESTONE: 'm27',
        DATABASE_TEST_RUN_ID: '0123456789abcdef',
      },
      '数据库测试里程碑只能用于 milestone scope。',
    ],
  ])('rejects an invalid explicit launcher environment', (input, message) => {
    expect(() =>
      loadDatabaseTestMode({
        DATABASE_TEST_ENTRYPOINT: 'run-database-integration-tests',
        ...input,
      }),
    ).toThrow(message)
  })
})
