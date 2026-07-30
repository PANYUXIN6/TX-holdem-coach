import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import type { Sql } from 'postgres'

const journalSchema = z
  .object({
    version: z.string().min(1),
    dialect: z.literal('postgresql'),
    entries: z.array(
      z
        .object({
          idx: z.number().int().nonnegative(),
          version: z.string().min(1),
          when: z.number().int().nonnegative(),
          tag: z.string().min(1),
          breakpoints: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict()

export interface ExpectedMigration {
  readonly when: number
  readonly hash: string
}

export interface ActualMigration {
  readonly createdAt: string
  readonly hash: string
}

export type MigrationCompatibilityMode = 'exact' | 'prefix'

export type MigrationCompatibilityFailure =
  'migrationRecordsMissing' | 'schemaVersionIncompatible'

export class MigrationCompatibilityError extends Error {
  public constructor(
    public readonly failure: MigrationCompatibilityFailure,
    options?: ErrorOptions,
  ) {
    super(failure, options)
    this.name = 'MigrationCompatibilityError'
  }
}

function incompatibleAssets(cause: unknown): MigrationCompatibilityError {
  return new MigrationCompatibilityError('schemaVersionIncompatible', { cause })
}

function validateJournalOrder(
  entries: readonly { idx: number; when: number; tag: string }[],
): void {
  const tags = new Set<string>()

  entries.forEach((entry, index) => {
    const previous = entries[index - 1]

    if (
      entry.idx !== index ||
      (previous !== undefined && entry.when <= previous.when) ||
      tags.has(entry.tag) ||
      entry.tag.includes('/') ||
      entry.tag.includes('\\')
    ) {
      throw incompatibleAssets(new Error('Invalid migration journal.'))
    }

    tags.add(entry.tag)
  })
}

export async function buildExpectedMigrationSequence(
  migrationsDirectory: string,
): Promise<readonly ExpectedMigration[]> {
  try {
    const directory = resolve(migrationsDirectory)
    const journal = journalSchema.parse(
      JSON.parse(
        await readFile(join(directory, 'meta', '_journal.json'), 'utf8'),
      ),
    )
    validateJournalOrder(journal.entries)

    return await Promise.all(
      journal.entries.map(async (entry) => {
        const migrationPath = resolve(directory, `${entry.tag}.sql`)

        if (!migrationPath.startsWith(`${directory}/`)) {
          throw new Error('Invalid migration path.')
        }

        const contents = await readFile(migrationPath, 'utf8')

        return {
          when: entry.when,
          hash: createHash('sha256').update(contents).digest('hex'),
        }
      }),
    )
  } catch (error) {
    if (error instanceof MigrationCompatibilityError) {
      throw error
    }

    throw incompatibleAssets(error)
  }
}

export async function readActualMigrationSequence(
  sql: Sql,
): Promise<readonly ActualMigration[]> {
  const rows = await sql<
    { readonly createdAt: string; readonly hash: string }[]
  >`
    SELECT created_at::text AS "createdAt", hash
    FROM app_private.__drizzle_migrations
    ORDER BY id ASC
  `

  return rows.map((row) => ({
    createdAt: row.createdAt,
    hash: row.hash,
  }))
}

export function assertMigrationSequence(
  expected: readonly ExpectedMigration[],
  actual: readonly ActualMigration[],
  mode: MigrationCompatibilityMode,
): void {
  if (mode === 'exact' && actual.length < expected.length) {
    throw new MigrationCompatibilityError('migrationRecordsMissing')
  }

  if (actual.length > expected.length) {
    throw new MigrationCompatibilityError('schemaVersionIncompatible')
  }

  for (const [index, actualMigration] of actual.entries()) {
    const expectedMigration = expected[index]

    if (
      expectedMigration === undefined ||
      actualMigration.createdAt !== String(expectedMigration.when) ||
      actualMigration.hash !== expectedMigration.hash
    ) {
      throw new MigrationCompatibilityError('schemaVersionIncompatible')
    }
  }
}

export function assertExactMigrationSequence(
  expected: readonly ExpectedMigration[],
  actual: readonly ActualMigration[],
): void {
  assertMigrationSequence(expected, actual, 'exact')
}
