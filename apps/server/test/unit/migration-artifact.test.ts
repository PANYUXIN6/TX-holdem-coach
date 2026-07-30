import { describe, expect, test } from 'vitest'
import {
  createDatabaseTargetsManifest,
  MigrationArtifactError,
  verifyDatabaseTargetsManifest,
} from '../../src/db/migration-artifact.js'
import { loadDatabaseTargets } from '../../src/db/database-targets.js'
import {
  loadProductionMigrationTarget,
  ProductionMigrationTargetError,
} from '../../src/db/migration-release.js'

const productionMigrationUrl =
  'postgresql://postgres.hsdyjpghsmqmdpqvufdw:secret@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres'

describe('migration artifact database targets', () => {
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
