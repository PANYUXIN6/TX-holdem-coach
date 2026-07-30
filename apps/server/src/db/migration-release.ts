import { verifyDatabaseTargetsManifest } from './migration-artifact.js'
import type { DatabaseTargetsManifest } from './migration-artifact.js'
import { parseSupabaseDatabaseUrl } from './database-url-policy.js'
import type { ParsedSupabaseDatabaseUrl } from './database-url-policy.js'

export class ProductionMigrationTargetError extends Error {
  public constructor(options?: ErrorOptions) {
    super('线上迁移目标与已验证制品不匹配。', options)
    this.name = 'ProductionMigrationTargetError'
  }
}

export function loadProductionMigrationTarget(
  environment: NodeJS.ProcessEnv,
  manifest: DatabaseTargetsManifest,
): ParsedSupabaseDatabaseUrl {
  try {
    const targets = verifyDatabaseTargetsManifest(manifest)
    const value = environment.DATABASE_MIGRATION_URL

    if (value === undefined) {
      throw new ProductionMigrationTargetError()
    }

    const target = parseSupabaseDatabaseUrl(value, 'migration')

    if (target.projectRef !== targets.production.supabaseProjectRef) {
      throw new ProductionMigrationTargetError()
    }

    return target
  } catch (error) {
    if (error instanceof ProductionMigrationTargetError) {
      throw error
    }

    throw new ProductionMigrationTargetError({ cause: error })
  }
}
