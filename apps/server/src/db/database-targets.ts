import { readFileSync } from 'node:fs'
import { z } from 'zod'

const projectRefSchema = z.string().regex(/^[a-z0-9]+$/)
export const databaseTargetsSchema = z
  .object({
    version: z.literal(1),
    test: z
      .object({
        supabaseProjectRef: projectRefSchema,
      })
      .strict(),
    production: z
      .object({
        supabaseProjectRef: projectRefSchema,
      })
      .strict(),
  })
  .strict()
  .refine(
    (targets) =>
      targets.test.supabaseProjectRef !== targets.production.supabaseProjectRef,
  )

export type DatabaseTargets = z.infer<typeof databaseTargetsSchema>

export class DatabaseTargetsConfigurationError extends Error {
  public constructor(options?: ErrorOptions) {
    super('数据库目标注册表无效。', options)
    this.name = 'DatabaseTargetsConfigurationError'
  }
}

export function parseDatabaseTargets(value: unknown): DatabaseTargets {
  const result = databaseTargetsSchema.safeParse(value)

  if (!result.success) {
    throw new DatabaseTargetsConfigurationError({ cause: result.error })
  }

  return result.data
}

export function loadDatabaseTargets(): DatabaseTargets {
  try {
    const path = new URL('../../config/database-targets.json', import.meta.url)
    return parseDatabaseTargets(JSON.parse(readFileSync(path, 'utf8')))
  } catch (error) {
    if (error instanceof DatabaseTargetsConfigurationError) {
      throw error
    }

    throw new DatabaseTargetsConfigurationError({ cause: error })
  }
}
