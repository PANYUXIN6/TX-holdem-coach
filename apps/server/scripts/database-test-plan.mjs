export const DATABASE_TEST_MILESTONES = Object.freeze([
  'm22',
  'm23',
  'm24',
  'm25',
  'm26',
  'm27',
  'm28',
  'm31',
  'm32',
  'm33',
  'm34',
  'm35',
  'm36',
  'm37',
  'm42',
  'm43',
  'm44',
  'm45',
])

export const DATABASE_TEST_SUITES = Object.freeze(['database', 'e2e'])

const DATABASE_MILESTONES_BY_SUITE = Object.freeze({
  database: new Set([
    'm22',
    'm23',
    'm24',
    'm25',
    'm26',
    'm27',
    'm28',
    'm35',
    'm44',
    'm45',
  ]),
  e2e: new Set([
    'm31',
    'm32',
    'm33',
    'm34',
    'm35',
    'm36',
    'm37',
    'm42',
    'm43',
    'm44',
    'm45',
  ]),
})

export function parseDatabaseTestArguments(arguments_) {
  const normalizedArguments = arguments_.filter((argument) => argument !== '--')
  const suiteArguments = normalizedArguments.filter((argument) =>
    argument.startsWith('--suite='),
  )
  if (suiteArguments.length > 1) {
    throw new Error('数据库测试启动参数无效。')
  }
  const suite = suiteArguments[0]?.slice('--suite='.length) ?? 'database'
  if (!DATABASE_TEST_SUITES.includes(suite)) {
    throw new Error('数据库测试启动参数无效。')
  }
  const planArguments = normalizedArguments.filter(
    (argument) => !argument.startsWith('--suite='),
  )

  if (planArguments.length === 0 && suite === 'database') {
    return { kind: 'migration', suite }
  }
  if (planArguments.length === 1 && planArguments[0] === '--full') {
    return { kind: 'full', suite }
  }
  if (
    planArguments.length === 1 &&
    planArguments[0] === '--cleanup-stale' &&
    suite === 'database'
  ) {
    return { kind: 'cleanup', suite }
  }

  const milestonePrefix = '--milestone='
  if (
    planArguments.length === 1 &&
    planArguments[0]?.startsWith(milestonePrefix)
  ) {
    const milestone = planArguments[0].slice(milestonePrefix.length)
    if (DATABASE_MILESTONES_BY_SUITE[suite].has(milestone)) {
      return { kind: 'milestone', milestone, suite }
    }
  }

  throw new Error('数据库测试启动参数无效。')
}

export function createDatabaseTestPlanEnvironment(plan, runId) {
  const environment = {
    DATABASE_TEST_ENTRYPOINT: 'run-database-integration-tests',
    DATABASE_TEST_RUN_ID: runId,
  }
  if (plan.kind === 'full') {
    environment.DATABASE_TEST_SCOPE = 'full'
  } else if (plan.kind === 'milestone') {
    environment.DATABASE_TEST_SCOPE = 'milestone'
    environment.DATABASE_TEST_MILESTONE = plan.milestone
  } else if (plan.kind === 'cleanup') {
    environment.DATABASE_TEST_SCOPE = 'cleanup'
  }
  return environment
}

export function createDatabaseVitestArguments(plan) {
  const testFile =
    plan.suite === 'database'
      ? 'test/integration/database-infrastructure.test.ts'
      : 'test/integration/postgres-application-e2e.test.ts'
  return ['exec', 'vitest', 'run', '--bail=1', testFile]
}
