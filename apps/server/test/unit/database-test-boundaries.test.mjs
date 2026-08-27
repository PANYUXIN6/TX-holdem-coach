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
const playerCommitGateRepository = await readFile(
  new URL(
    '../../src/persistence/player-commit-gate-repository.ts',
    import.meta.url,
  ),
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
    ])
    expect(persistenceEntry).not.toContain('postgres-application-e2e')
    expect(persistenceEntry).toContain('database-repository-assertions')
    expect(persistenceEntry).not.toContain('postgres-e2e-m31-assertions')
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
    ).toEqual([])
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
    ])
    expect(applicationEntry).not.toContain('database-schema-assertions')
    expect(applicationEntry).toContain('postgres-e2e-m35-assertions')
    expect(applicationEntry).toContain('postgres-e2e-m31-assertions')
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
})
