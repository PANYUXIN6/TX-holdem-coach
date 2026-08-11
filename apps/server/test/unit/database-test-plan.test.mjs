import { describe, expect, test } from 'vitest'
import {
  createDatabaseTestPlanEnvironment,
  parseDatabaseTestArguments,
} from '../../scripts/database-test-plan.mjs'

describe('database test plan', () => {
  test('selects one allowlisted milestone', () => {
    expect(parseDatabaseTestArguments(['--milestone=m34'])).toEqual({
      kind: 'milestone',
      milestone: 'm34',
    })
  })

  test('accepts the pnpm argument separator before one milestone', () => {
    expect(parseDatabaseTestArguments(['--', '--milestone=m27'])).toEqual({
      kind: 'milestone',
      milestone: 'm27',
    })
  })

  test.each([
    [[], { kind: 'migration' }],
    [['--full'], { kind: 'full' }],
    [['--cleanup-stale'], { kind: 'cleanup' }],
  ])('accepts the controlled plan %j', (arguments_, expected) => {
    expect(parseDatabaseTestArguments(arguments_)).toEqual(expected)
  })

  test('creates the explicit launcher environment for a milestone', () => {
    expect(
      createDatabaseTestPlanEnvironment(
        { kind: 'milestone', milestone: 'm27' },
        '0123456789abcdef',
      ),
    ).toEqual({
      DATABASE_TEST_ENTRYPOINT: 'run-database-integration-tests',
      DATABASE_TEST_SCOPE: 'milestone',
      DATABASE_TEST_MILESTONE: 'm27',
      DATABASE_TEST_RUN_ID: '0123456789abcdef',
    })
  })

  test.each([
    [{ kind: 'migration' }, undefined],
    [{ kind: 'full' }, 'full'],
    [{ kind: 'cleanup' }, 'cleanup'],
  ])('creates the launcher scope for %j', (plan, expectedScope) => {
    const environment = createDatabaseTestPlanEnvironment(
      plan,
      '0123456789abcdef',
    )
    expect(environment.DATABASE_TEST_SCOPE).toBe(expectedScope)
    expect(environment.DATABASE_TEST_MILESTONE).toBeUndefined()
  })

  test.each([
    ['--milestone=m29'],
    ['--full', '--cleanup-stale'],
    ['--unknown'],
  ])('rejects uncontrolled arguments %j', (...arguments_) => {
    expect(() => parseDatabaseTestArguments(arguments_)).toThrow(
      '数据库测试启动参数无效。',
    )
  })
})
