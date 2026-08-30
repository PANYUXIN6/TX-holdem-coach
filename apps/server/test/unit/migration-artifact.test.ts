import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  createDatabaseTargetsManifest,
  MigrationBaselineAssetError,
  MigrationArtifactError,
  MigrationBaselineInvariantError,
  verifyDatabaseTargetsManifest,
  verifyMigrationBaselineInvariants,
  verifySingleBaselineMigrationAssets,
} from '../../src/db/migration-artifact.js'
import { loadDatabaseTargets } from '../../src/db/database-targets.js'
import {
  loadProductionMigrationTarget,
  ProductionMigrationTargetError,
} from '../../src/db/migration-release.js'

const productionMigrationUrl =
  'postgresql://postgres.hsdyjpghsmqmdpqvufdw:secret@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres'

describe('migration artifact database targets', () => {
  test('preserves the non-Drizzle invariants in the single baseline', async () => {
    const baseline = await readFile(
      new URL('../../src/db/migrations/0000_baseline.sql', import.meta.url),
      'utf8',
    )

    expect(() => verifyMigrationBaselineInvariants(baseline)).not.toThrow()
    expect(() =>
      verifyMigrationBaselineInvariants(
        baseline.replace('TRIGGER "sessions_roster_integrity"', ''),
      ),
    ).toThrow(MigrationBaselineInvariantError)
  })

  test('rejects a second migration version before destructive rebaseline work', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'poker-baseline-assets-'))
    try {
      await mkdir(join(directory, 'meta'))
      const baseline = await readFile(
        new URL('../../src/db/migrations/0000_baseline.sql', import.meta.url),
        'utf8',
      )
      await Promise.all([
        writeFile(join(directory, '0000_baseline.sql'), baseline),
        writeFile(join(directory, '0001_next.sql'), 'SELECT 1;'),
        writeFile(
          join(directory, 'meta', '_journal.json'),
          JSON.stringify({
            version: '7',
            dialect: 'postgresql',
            entries: [
              {
                idx: 0,
                version: '7',
                when: 1,
                tag: '0000_baseline',
                breakpoints: true,
              },
              {
                idx: 1,
                version: '7',
                when: 2,
                tag: '0001_next',
                breakpoints: true,
              },
            ],
          }),
        ),
      ])

      await expect(
        verifySingleBaselineMigrationAssets(directory),
      ).rejects.toThrow(MigrationBaselineAssetError)
    } finally {
      await rm(directory, { recursive: true })
    }
  })

  test('rejects an extra snapshot before destructive rebaseline work', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'poker-baseline-assets-'))
    try {
      await mkdir(join(directory, 'meta'))
      const baseline = await readFile(
        new URL('../../src/db/migrations/0000_baseline.sql', import.meta.url),
        'utf8',
      )
      await Promise.all([
        writeFile(join(directory, '0000_baseline.sql'), baseline),
        writeFile(join(directory, 'meta', '0000_snapshot.json'), '{}'),
        writeFile(join(directory, 'meta', '0001_snapshot.json'), '{}'),
        writeFile(
          join(directory, 'meta', '_journal.json'),
          JSON.stringify({
            version: '7',
            dialect: 'postgresql',
            entries: [
              {
                idx: 0,
                version: '7',
                when: 1,
                tag: '0000_baseline',
                breakpoints: true,
              },
            ],
          }),
        ),
      ])

      await expect(
        verifySingleBaselineMigrationAssets(directory),
      ).rejects.toThrow(MigrationBaselineAssetError)
    } finally {
      await rm(directory, { recursive: true })
    }
  })

  test('embeds the fixed target registry and a verifiable digest', () => {
    const targets = loadDatabaseTargets()
    const manifest = createDatabaseTargetsManifest(targets)

    expect(manifest).toMatchObject({
      formatVersion: 1,
      databaseTargets: targets,
      databaseTargetsDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(verifyDatabaseTargetsManifest(manifest)).toStrictEqual(targets)
  })

  test('rejects a target registry changed after the digest was created', () => {
    const manifest = createDatabaseTargetsManifest(loadDatabaseTargets())

    expect(() =>
      verifyDatabaseTargetsManifest({
        ...manifest,
        databaseTargets: {
          ...manifest.databaseTargets,
          production: {
            supabaseProjectRef: 'aaaaaaaaaaaaaaaaaaaa',
          },
        },
      }),
    ).toThrow(MigrationArtifactError)
  })

  test('uses only the artifact registry to authorize a production URL', () => {
    const manifest = createDatabaseTargetsManifest(loadDatabaseTargets())

    expect(
      loadProductionMigrationTarget(
        {
          DATABASE_MIGRATION_URL: productionMigrationUrl,
          PRODUCTION_SUPABASE_PROJECT_REF: 'aaaaaaaaaaaaaaaaaaaa',
          TEST_SUPABASE_PROJECT_REF: 'hsdyjpghsmqmdpqvufdw',
        },
        manifest,
      ),
    ).toMatchObject({
      projectRef: 'hsdyjpghsmqmdpqvufdw',
      connection: { port: 5432, database: 'postgres' },
    })
  })

  test('rejects a valid migration URL for the wrong Supabase project', () => {
    const manifest = createDatabaseTargetsManifest(loadDatabaseTargets())
    const wrongProjectUrl = productionMigrationUrl.replace(
      'hsdyjpghsmqmdpqvufdw',
      'wlxjauqsesrmcyghibsr',
    )

    expect(() =>
      loadProductionMigrationTarget(
        { DATABASE_MIGRATION_URL: wrongProjectUrl },
        manifest,
      ),
    ).toThrow(ProductionMigrationTargetError)
  })
})
