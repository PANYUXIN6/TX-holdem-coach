import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  databaseTargetsSchema,
  parseDatabaseTargets,
} from './database-targets.js'
import type { DatabaseTargets } from './database-targets.js'
import {
  buildExpectedMigrationSequence,
  type ExpectedMigration,
} from './migration-compatibility.js'

const databaseTargetsManifestSchema = z
  .object({
    formatVersion: z.literal(1),
    databaseTargets: databaseTargetsSchema,
    databaseTargetsDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()

export type DatabaseTargetsManifest = z.infer<
  typeof databaseTargetsManifestSchema
>

export class MigrationArtifactError extends Error {
  public constructor(options?: ErrorOptions) {
    super('迁移制品中的数据库目标注册表无效。', options)
    this.name = 'MigrationArtifactError'
  }
}

const requiredBaselineFragments = Object.freeze([
  'CREATE SCHEMA IF NOT EXISTS "app_private";',
  'CONSTRAINT "sessions_current_hand_scope_fk"',
  'CONSTRAINT "sessions_active_player_run_fk"',
  'CONSTRAINT "session_agents_current_memory_revision_fk"',
  'CONSTRAINT "hands_aborted_by_agent_run_fk"',
  'CONSTRAINT "agent_runs_parent_scope_fk"',
  'CONSTRAINT "agent_runs_replacement_scope_fk"',
  'FUNCTION "app_private"."enforce_session_roster"()',
  'TRIGGER "sessions_roster_integrity"',
  'TRIGGER "session_participants_roster_integrity"',
  'TRIGGER "session_agents_roster_integrity"',
  'FUNCTION "app_private"."enforce_player_run_coordination"()',
  'TRIGGER "sessions_player_run_coordination"',
  'TRIGGER "agent_runs_player_run_coordination"',
  'FUNCTION "app_private"."enforce_coach_completed_hand"()',
  'TRIGGER "agent_runs_coach_completed_hand"',
  'TRIGGER "hands_coach_completed_hand"',
  "VALUES ('11111111-1111-4111-8111-111111111111', 'local-user');",
  'REVOKE ALL ON SCHEMA "app_private" FROM PUBLIC;',
  'REVOKE ALL ON ALL TABLES IN SCHEMA "app_private" FROM PUBLIC;',
  'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "app_private" FROM PUBLIC;',
])

export class MigrationBaselineInvariantError extends Error {
  public constructor() {
    super('唯一数据库 baseline 缺少必需的手工不变量。')
    this.name = 'MigrationBaselineInvariantError'
  }
}

export class MigrationBaselineAssetError extends Error {
  public constructor() {
    super('数据库迁移资产必须收敛为唯一的 0000_baseline。')
    this.name = 'MigrationBaselineAssetError'
  }
}

const singleBaselineAssetFiles = Object.freeze(
  [
    '0000_baseline.sql',
    join('meta', '0000_snapshot.json'),
    join('meta', '_journal.json'),
  ].sort((left, right) => left.localeCompare(right)),
)

async function listMigrationAssetFiles(
  directory: string,
  prefix = '',
): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = (
    await Promise.all(
      entries.map(async (entry): Promise<readonly string[]> => {
        const relativePath = join(prefix, entry.name)
        if (entry.isDirectory()) {
          return listMigrationAssetFiles(
            join(directory, entry.name),
            relativePath,
          )
        }
        return entry.isFile() ? [relativePath] : []
      }),
    )
  )
    .flat()
    .sort((left, right) => left.localeCompare(right))
  return Object.freeze(files)
}

export function verifyMigrationBaselineInvariants(contents: string): void {
  if (
    !requiredBaselineFragments.every((fragment) => contents.includes(fragment))
  ) {
    throw new MigrationBaselineInvariantError()
  }
}

export async function verifySingleBaselineMigrationAssets(
  migrationsDirectory: string,
): Promise<readonly ExpectedMigration[]> {
  const [assetFiles, expected, baseline] = await Promise.all([
    listMigrationAssetFiles(migrationsDirectory),
    buildExpectedMigrationSequence(migrationsDirectory),
    readFile(join(migrationsDirectory, '0000_baseline.sql'), 'utf8'),
  ])

  if (
    expected.length !== 1 ||
    JSON.stringify(assetFiles) !== JSON.stringify(singleBaselineAssetFiles)
  ) {
    throw new MigrationBaselineAssetError()
  }

  verifyMigrationBaselineInvariants(baseline)
  return expected
}

function serializeDatabaseTargets(targets: DatabaseTargets): string {
  return JSON.stringify({
    version: targets.version,
    test: {
      supabaseProjectRef: targets.test.supabaseProjectRef,
    },
    production: {
      supabaseProjectRef: targets.production.supabaseProjectRef,
    },
  })
}

function digestDatabaseTargets(targets: DatabaseTargets): string {
  return createHash('sha256')
    .update(`${serializeDatabaseTargets(targets)}\n`, 'utf8')
    .digest('hex')
}

export function createDatabaseTargetsManifest(
  value: unknown,
): DatabaseTargetsManifest {
  const targets = parseDatabaseTargets(value)

  return {
    formatVersion: 1,
    databaseTargets: targets,
    databaseTargetsDigest: digestDatabaseTargets(targets),
  }
}

export function verifyDatabaseTargetsManifest(value: unknown): DatabaseTargets {
  try {
    const manifest = databaseTargetsManifestSchema.parse(value)
    const expectedDigest = digestDatabaseTargets(manifest.databaseTargets)

    if (manifest.databaseTargetsDigest !== expectedDigest) {
      throw new MigrationArtifactError()
    }

    return manifest.databaseTargets
  } catch (error) {
    if (error instanceof MigrationArtifactError) {
      throw error
    }

    throw new MigrationArtifactError({ cause: error })
  }
}
