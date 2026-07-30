import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  databaseTargetsSchema,
  parseDatabaseTargets,
} from './database-targets.js'
import type { DatabaseTargets } from './database-targets.js'

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
