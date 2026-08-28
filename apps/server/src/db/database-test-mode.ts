export type DatabaseTestMilestone =
  | 'm22'
  | 'm23'
  | 'm24'
  | 'm25'
  | 'm26'
  | 'm27'
  | 'm28'
  | 'm31'
  | 'm32'
  | 'm33'
  | 'm34'
  | 'm35'
  | 'm36'
  | 'm37'
  | 'm42'
  | 'm43'
  | 'm44'
  | 'm45'
  | 'm46'
  | 'm47'
  | 'm48'

export interface DatabaseTestMode {
  readonly enabled: boolean
  readonly full: boolean
  readonly milestone: DatabaseTestMilestone | null
  readonly cleanupStale: boolean
  readonly runId: string | null
}

const DATABASE_TEST_MILESTONES = new Set<DatabaseTestMilestone>([
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
  'm46',
  'm47',
  'm48',
])

function isDatabaseTestMilestone(
  value: string | undefined,
): value is DatabaseTestMilestone {
  return (
    value !== undefined &&
    DATABASE_TEST_MILESTONES.has(value as DatabaseTestMilestone)
  )
}

export function loadDatabaseTestMode(
  environment: NodeJS.ProcessEnv,
): DatabaseTestMode {
  const enabled =
    environment.DATABASE_TEST_ENTRYPOINT === 'run-database-integration-tests'

  if (!enabled) {
    return {
      enabled: false,
      full: false,
      milestone: null,
      cleanupStale: false,
      runId: null,
    }
  }

  const runId = environment.DATABASE_TEST_RUN_ID
  if (runId === undefined || !/^[a-f0-9]{16}$/.test(runId)) {
    throw new Error('数据库测试 Run ID 无效。')
  }

  const scope = environment.DATABASE_TEST_SCOPE
  const milestone = environment.DATABASE_TEST_MILESTONE
  let selectedMilestone: DatabaseTestMilestone | null = null
  if (scope === 'milestone' && !isDatabaseTestMilestone(milestone)) {
    throw new Error('数据库测试里程碑无效。')
  }
  if (scope === 'milestone' && isDatabaseTestMilestone(milestone)) {
    selectedMilestone = milestone
  }
  if (scope !== 'milestone' && milestone !== undefined) {
    throw new Error('数据库测试里程碑只能用于 milestone scope。')
  }
  if (
    scope !== undefined &&
    !['full', 'milestone', 'cleanup'].includes(scope)
  ) {
    throw new Error('数据库测试 scope 无效。')
  }

  return {
    enabled: true,
    full: scope === 'full',
    milestone: selectedMilestone,
    cleanupStale: scope === 'cleanup',
    runId,
  }
}
