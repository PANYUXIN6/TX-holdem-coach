import { describe, expect, test } from 'vitest'
import {
  createDatabaseTestPlanEnvironment,
  createDatabaseVitestArguments,
  parseDatabaseTestArguments,
} from '../../scripts/database-test-plan.mjs'

describe('database test plan', () => {
  test('runs only the persistence entry for the database suite', () => {
    expect(
      createDatabaseVitestArguments({ kind: 'full', suite: 'database' }),
    ).toEqual([
      'exec',
      'vitest',
      'run',
      '--bail=1',
      'test/integration/database-infrastructure.test.ts',
    ])
  })

  test('runs only the application entry for the PostgreSQL E2E suite', () => {
    expect(
      createDatabaseVitestArguments({ kind: 'full', suite: 'e2e' }),
    ).toEqual([
      'exec',
      'vitest',
      'run',
      '--bail=1',
      'test/integration/postgres-application-e2e.test.ts',
    ])
  })

  test('selects one allowlisted E2E milestone', () => {
    expect(
      parseDatabaseTestArguments(['--suite=e2e', '--milestone=m37']),
    ).toEqual({
      kind: 'milestone',
      milestone: 'm37',
      suite: 'e2e',
    })
  })

  test('allows a persistence milestone owned by a later feature', () => {
    expect(
      parseDatabaseTestArguments(['--suite=database', '--milestone=m35']),
    ).toEqual({
      kind: 'milestone',
      milestone: 'm35',
      suite: 'database',
    })
  })

  test('allows M5.4 in both PostgreSQL suites', () => {
    expect(
      parseDatabaseTestArguments(['--suite=database', '--milestone=m54']),
    ).toEqual({ kind: 'milestone', milestone: 'm54', suite: 'database' })
    expect(
      parseDatabaseTestArguments(['--suite=e2e', '--milestone=m54']),
    ).toEqual({ kind: 'milestone', milestone: 'm54', suite: 'e2e' })
  })

  test('allows M5.5 in both PostgreSQL suites', () => {
    for (const suite of ['database', 'e2e']) {
      expect(
        parseDatabaseTestArguments([`--suite=${suite}`, '--milestone=m55']),
      ).toEqual({ kind: 'milestone', milestone: 'm55', suite })
    }
  })

  test('allows M5.1 only in the database suite', () => {
    expect(
      parseDatabaseTestArguments(['--suite=database', '--milestone=m51']),
    ).toEqual({ kind: 'milestone', milestone: 'm51', suite: 'database' })
    expect(() =>
      parseDatabaseTestArguments(['--suite=e2e', '--milestone=m51']),
    ).toThrow('数据库测试启动参数无效。')
  })

  test('allows M5.2 only in the PostgreSQL E2E suite', () => {
    expect(
      parseDatabaseTestArguments(['--suite=e2e', '--milestone=m52']),
    ).toEqual({ kind: 'milestone', milestone: 'm52', suite: 'e2e' })
    expect(() =>
      parseDatabaseTestArguments(['--suite=database', '--milestone=m52']),
    ).toThrow('数据库测试启动参数无效。')
  })

  test('allows M5.3 in both persistence and PostgreSQL E2E suites', () => {
    for (const suite of ['database', 'e2e']) {
      expect(
        parseDatabaseTestArguments([`--suite=${suite}`, '--milestone=m53']),
      ).toEqual({ kind: 'milestone', milestone: 'm53', suite })
    }
  })

  test.each(['database', 'e2e'])(
    'allows the M4.5 milestone in the %s suite',
    (suite) => {
      expect(
        parseDatabaseTestArguments([`--suite=${suite}`, '--milestone=m45']),
      ).toEqual({ kind: 'milestone', milestone: 'm45', suite })
    },
  )

  test.each(['database', 'e2e'])(
    'allows the M4.6 milestone in the %s suite',
    (suite) => {
      expect(
        parseDatabaseTestArguments([`--suite=${suite}`, '--milestone=m46']),
      ).toEqual({ kind: 'milestone', milestone: 'm46', suite })
    },
  )

  test.each(['database', 'e2e'])(
    'allows the M4.7 milestone in the %s suite',
    (suite) => {
      expect(
        parseDatabaseTestArguments([`--suite=${suite}`, '--milestone=m47']),
      ).toEqual({ kind: 'milestone', milestone: 'm47', suite })
    },
  )

  test.each(['database', 'e2e'])(
    'allows the M4.8 milestone in the %s suite',
    (suite) => {
      expect(
        parseDatabaseTestArguments([`--suite=${suite}`, '--milestone=m48']),
      ).toEqual({ kind: 'milestone', milestone: 'm48', suite })
    },
  )

  test('accepts the pnpm argument separator before one milestone', () => {
    expect(
      parseDatabaseTestArguments(['--suite=database', '--', '--milestone=m27']),
    ).toEqual({
      kind: 'milestone',
      milestone: 'm27',
      suite: 'database',
    })
  })

  test.each([
    [[], { kind: 'migration', suite: 'database' }],
    [['--full'], { kind: 'full', suite: 'database' }],
    [['--suite=e2e', '--full'], { kind: 'full', suite: 'e2e' }],
    [['--cleanup-stale'], { kind: 'cleanup', suite: 'database' }],
  ])('accepts the controlled plan %j', (arguments_, expected) => {
    expect(parseDatabaseTestArguments(arguments_)).toEqual(expected)
  })

  test('creates the explicit launcher environment for a milestone', () => {
    expect(
      createDatabaseTestPlanEnvironment(
        { kind: 'milestone', milestone: 'm27', suite: 'database' },
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
    [{ kind: 'migration', suite: 'database' }, undefined],
    [{ kind: 'full', suite: 'database' }, 'full'],
    [{ kind: 'cleanup', suite: 'database' }, 'cleanup'],
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
    ['--suite=database', '--milestone=m37'],
    ['--suite=e2e', '--milestone=m27'],
    ['--suite=e2e', '--cleanup-stale'],
    ['--suite=e2e'],
    ['--suite=unknown', '--full'],
    ['--full', '--cleanup-stale'],
    ['--unknown'],
  ])('rejects uncontrolled arguments %j', (...arguments_) => {
    expect(() => parseDatabaseTestArguments(arguments_)).toThrow(
      '数据库测试启动参数无效。',
    )
  })
})
