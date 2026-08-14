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
])

export function parseDatabaseTestArguments(arguments_) {
  const normalizedArguments =
    arguments_.length > 1 && arguments_[0] === '--'
      ? arguments_.slice(1)
      : arguments_

  if (normalizedArguments.length === 0) {
    return { kind: 'migration' }
  }
  if (normalizedArguments.length === 1 && normalizedArguments[0] === '--full') {
    return { kind: 'full' }
  }
  if (
    normalizedArguments.length === 1 &&
    normalizedArguments[0] === '--cleanup-stale'
  ) {
    return { kind: 'cleanup' }
  }

  const milestonePrefix = '--milestone='
  if (
    normalizedArguments.length === 1 &&
    normalizedArguments[0]?.startsWith(milestonePrefix)
  ) {
    const milestone = normalizedArguments[0].slice(milestonePrefix.length)
    if (DATABASE_TEST_MILESTONES.includes(milestone)) {
      return { kind: 'milestone', milestone }
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

export function createDatabaseVitestArguments() {
  return [
    'exec',
    'vitest',
    'run',
    '--bail=1',
    'test/integration/database-infrastructure.test.ts',
  ]
}
