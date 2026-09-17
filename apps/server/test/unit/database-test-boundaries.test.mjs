import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const serverDirectory = fileURLToPath(new URL('../../', import.meta.url))
const persistenceEntryUrl = new URL(
  '../integration/database-infrastructure.test.ts',
  import.meta.url,
)
const applicationEntryUrl = new URL(
  '../integration/postgres-application-e2e.test.ts',
  import.meta.url,
)
const persistenceEntry = await readFile(persistenceEntryUrl, 'utf8')
const applicationEntry = await readFile(applicationEntryUrl, 'utf8')
const persistenceM35Assertions = await readFile(
  new URL('../integration/database-m35-assertions.ts', import.meta.url),
  'utf8',
)
const persistenceM45Assertions = await readFile(
  new URL('../integration/database-m45-assertions.ts', import.meta.url),
  'utf8',
)
const applicationM45Assertions = await readFile(
  new URL('../integration/postgres-e2e-m45-assertions.ts', import.meta.url),
  'utf8',
)
const persistenceM55Assertions = await readFile(
  new URL('../integration/database-m55-assertions.ts', import.meta.url),
  'utf8',
)
const playerCommitGateRepository = await readFile(
  new URL(
    '../../src/persistence/player-commit-gate-repository.ts',
    import.meta.url,
  ),
  'utf8',
)
const rebaselineScript = await readFile(
  new URL('../../scripts/rebaseline-test-database.mjs', import.meta.url),
  'utf8',
)
const databaseTestHarnessSource = await readFile(
  new URL('../integration/database-test-harness.ts', import.meta.url),
  'utf8',
)
const serverPackage = JSON.parse(
  await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
)
const coverageConfig = await readFile(
  new URL('../../vitest.coverage.config.ts', import.meta.url),
  'utf8',
)
const typescriptCompiler = resolve(
  serverDirectory,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsc.cmd' : 'tsc',
)

function buildTypeScriptDependencyClosure(entryUrl) {
  const compilerOutput = execFileSync(
    typescriptCompiler,
    [
      '--noEmit',
      '--listFilesOnly',
      '--ignoreConfig',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--target',
      'ES2023',
      '--types',
      'node',
      fileURLToPath(entryUrl),
    ],
    {
      cwd: serverDirectory,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    },
  )
  return compilerOutput
    .trim()
    .split(/\r?\n/)
    .map((file) => relative(serverDirectory, file).replaceAll('\\', '/'))
    .filter((file) => file !== '..' && !file.startsWith('../'))
}

const [persistenceDependencyClosure, applicationDependencyClosure] = [
  buildTypeScriptDependencyClosure(persistenceEntryUrl),
  buildTypeScriptDependencyClosure(applicationEntryUrl),
]

function registeredMilestones(source) {
  return [
    ...source.matchAll(/registerDatabaseMilestoneTest\(\s*['"](m\d+)['"]/g),
  ].map((match) => match[1])
}

describe('remote PostgreSQL test boundaries', () => {
  test('keeps persistence milestones in the database entry', () => {
    expect([...new Set(registeredMilestones(persistenceEntry))]).toEqual([
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
      'm46',
      'm47',
      'm48',
      'm49',
      'm410',
      'm51',
      'm53',
      'm54',
      'm55',
      'm82',
    ])
    expect(persistenceEntry).not.toContain('postgres-application-e2e')
    expect(persistenceEntry).toContain('database-repository-assertions')
    expect(persistenceEntry).not.toContain('postgres-e2e-m31-assertions')
    // M5.5 的持久化查询必须用 current Player Decision codecs 认证公开动作；
    // 精确冻结其 schema 依赖闭包，避免继续扩展到命令执行或 Runtime 编排。
    expect(
      persistenceDependencyClosure.filter((path) =>
        path.startsWith('src/sessions/command-execution/'),
      ),
    ).toEqual([])
    expect(persistenceEntry).not.toMatch(
      /database-m(?:3[2-46-7]|4[23])-assertions/,
    )
    expect(playerCommitGateRepository).not.toMatch(
      /from ['"]\.\.\/agents\/player\//,
    )
    expect(persistenceM35Assertions).not.toMatch(
      /src\/(?:config|http|personas|providers|settings)\b/,
    )
    expect(persistenceM35Assertions).not.toContain('createApp')
    expect(persistenceM35Assertions).not.toContain(
      'createPlayerAgentSettingsService',
    )
    expect(persistenceM45Assertions).toContain(
      'createPostgresPlayerDecisionReferencePort',
    )
    expect(persistenceM45Assertions).not.toMatch(
      /src\/poker\/(?:hand-features|decision-metrics|decision-spot|candidate-outcomes)/,
    )
    expect(persistenceM45Assertions).not.toMatch(
      /src\/agents\/player\/(?:player-decision-analysis-input|opponent-feature-projector)/,
    )
    expect(
      persistenceDependencyClosure.filter((path) =>
        /src\/(?:poker\/(?:hand-features|decision-metrics|decision-spot|candidate-outcomes)|agents\/player\/(?:player-decision-analysis-input|opponent-feature-projector))\.ts$/.test(
          path,
        ),
      ),
    ).toEqual([
      'src/poker/candidate-outcomes.ts',
      'src/poker/decision-metrics.ts',
      'src/poker/hand-features.ts',
      'src/poker/decision-spot.ts',
      'src/agents/player/player-decision-analysis-input.ts',
      'src/agents/player/opponent-feature-projector.ts',
    ])
  })

  test('keeps M5.5 database connection role literals valid offline', () => {
    const roles = [
      ...persistenceM55Assertions.matchAll(
        /createDatabaseTestSqlForRole\(\s*[^,]+,\s*['"]([^'"]+)['"]/g,
      ),
    ].map((match) => match[1])

    expect(roles.length).toBeGreaterThan(0)
    expect(roles.filter((role) => !/^[a-z0-9-]{1,24}$/.test(role))).toEqual([])
  })

  test('keeps application milestones in the PostgreSQL E2E entry', () => {
    expect(registeredMilestones(applicationEntry)).toEqual([
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
      'm49',
      'm410',
      'm52',
      'm53',
      'm54',
      'm55',
      'm55',
    ])
    expect(applicationEntry).not.toContain('database-schema-assertions')
    expect(applicationEntry).toContain('postgres-e2e-m35-assertions')
    expect(applicationEntry).toContain('postgres-e2e-m31-assertions')
    expect(applicationEntry).toContain(
      'assertM55SessionAndAgentCallHttpSuccessFlow',
    )
    expect(applicationEntry).toContain('assertM55PauseAbortAndClearHttpFlow')
    expect(applicationEntry).not.toContain('database-repository-assertions')
    expect(applicationDependencyClosure).toContain(
      'src/sessions/command-execution/session-command-executor.ts',
    )
    expect(applicationM45Assertions).toContain(
      'createPostgresPlayerObservationPort',
    )
    expect(applicationM45Assertions).toContain(
      'createPostgresPlayerDecisionReferencePort',
    )
    expect(applicationM45Assertions).toContain('createCapabilityExecutor')
    expect(applicationM45Assertions).toContain(
      'executePlayerDecisionPreprocessingPlan',
    )
    expect(applicationM45Assertions).toContain(
      'isPlayerDecisionPreprocessingResult',
    )
    expect(applicationDependencyClosure).toEqual(
      expect.arrayContaining([
        'src/persistence/player-observation-authority.ts',
        'src/persistence/player-decision-reference-authority.ts',
        'src/agents/player/player-decision-capabilities.ts',
        'src/agents/player/player-decision-preprocessing-plan.ts',
        'src/agents/player/player-decision-analysis-core.ts',
        'src/agents/player/player-decision-analysis-input.ts',
        'src/poker/decision-spot.ts',
        'src/poker/hand-features.ts',
        'src/poker/decision-metrics.ts',
        'src/poker/candidate-outcomes.ts',
      ]),
    )
  })

  test('limits offline coverage collection to unit and service tests', () => {
    expect(serverPackage.scripts['test:coverage']).toContain(
      '--config vitest.coverage.config.ts',
    )
    expect(coverageConfig).toContain("'test/unit/**/*.{test,spec}.{ts,mjs}'")
    expect(coverageConfig).toContain("'test/service/**/*.{test,spec}.{ts,mjs}'")
    expect(coverageConfig).not.toContain('test/integration')
  })

  test('refreshes the runtime connection after migrations before resetting test data', () => {
    const preflightClosePosition = databaseTestHarnessSource.indexOf(
      'await preflightSql.end({ timeout: 0 })',
    )
    const migrationStartPosition = databaseTestHarnessSource.indexOf(
      'const { completion } = runManagedChildProcess(',
    )
    const migrationCompletionPosition = databaseTestHarnessSource.indexOf(
      'exitCode = await completion',
    )
    const verificationConnectionPosition = databaseTestHarnessSource.indexOf(
      'const verificationSql = createDatabaseTestSql(',
    )
    const migrationAssertionPosition = databaseTestHarnessSource.indexOf(
      'expect(() => assertExactMigrationSequence(expected, actual)).not.toThrow()',
    )
    const sessionCleanupPosition = databaseTestHarnessSource.indexOf(
      'clearPersistentLocalOwnerSessions(verificationSql)',
    )

    expect(preflightClosePosition).toBeGreaterThanOrEqual(0)
    expect(migrationStartPosition).toBeGreaterThan(preflightClosePosition)
    expect(migrationCompletionPosition).toBeGreaterThan(migrationStartPosition)
    expect(verificationConnectionPosition).toBeGreaterThan(
      migrationCompletionPosition,
    )
    expect(migrationAssertionPosition).toBeGreaterThan(
      verificationConnectionPosition,
    )
    expect(sessionCleanupPosition).toBeGreaterThan(migrationAssertionPosition)
  })

  test('holds the suite lock on the persistent database endpoint', () => {
    const preparationStart = databaseTestHarnessSource.indexOf(
      'export function registerPersistentDatabasePreparation()',
    )
    const milestoneStart = databaseTestHarnessSource.indexOf(
      'export function registerDatabaseMilestoneTest(',
    )
    const preparationSource = databaseTestHarnessSource.slice(
      preparationStart,
      milestoneStart,
    )

    expect(preparationStart).toBeGreaterThanOrEqual(0)
    expect(milestoneStart).toBeGreaterThan(preparationStart)
    expect(preparationSource).toContain(
      'const { migrationUrl } = loadTestDatabaseConnections(process.env)',
    )
    expect(preparationSource).toMatch(
      /createDatabaseTestSuiteLockClient\(\s*migrationUrl,/,
    )
    expect(rebaselineScript).toContain(
      'createDatabaseTestSuiteLockClient(migrationUrl, runId)',
    )
  })

  test('gates destructive rebaseline locally and aborts migration when the suite lock is lost', () => {
    expect(serverPackage.scripts['db:test:rebaseline']).toBe(
      'pnpm run build && pnpm run verify:migration-assets && node scripts/rebaseline-test-database.mjs',
    )

    const preflightPosition = rebaselineScript.indexOf(
      'const expected = await verifySingleBaselineMigrationAssets(',
    )
    const environmentPosition = rebaselineScript.indexOf(
      'const testEnvironment = await loadTestEnvironment()',
    )
    expect(preflightPosition).toBeGreaterThanOrEqual(0)
    expect(environmentPosition).toBeGreaterThan(preflightPosition)
    expect(rebaselineScript).toContain(
      "from '../dist/db/database-test-suite-lock.js'",
    )
    const lockAcquisitionPosition = rebaselineScript.indexOf(
      'const suiteLock = await acquireDatabaseTestSuiteLock(lockClient)',
    )
    const clientBindingPosition = rebaselineScript.indexOf(
      'const unbindMigrationSql = bindDatabaseTestClientToSuiteLock(',
    )
    const firstDatabaseQueryPosition = rebaselineScript.indexOf(
      'const conflictingRows = await migrationSql',
    )
    expect(lockAcquisitionPosition).toBeGreaterThanOrEqual(0)
    expect(clientBindingPosition).toBeGreaterThan(lockAcquisitionPosition)
    expect(firstDatabaseQueryPosition).toBeGreaterThan(clientBindingPosition)
    expect(rebaselineScript).toContain('signal: suiteLock.signal')
  })
})
