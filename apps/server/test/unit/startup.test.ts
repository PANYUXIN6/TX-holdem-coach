import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { Sql } from 'postgres'
import { loadServerConfig } from '../../src/config.js'
import type { DatabaseClient } from '../../src/db/client.js'
import { initializeDatabase, StartupError } from '../../src/startup.js'

const temporaryDirectories: string[] = []

async function createMigrationDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'poker-startup-migrations-'))
  temporaryDirectories.push(directory)
  await mkdir(join(directory, 'meta'))
  await writeFile(
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
  )
  await writeFile(join(directory, '0000_baseline.sql'), 'SELECT 1;')

  return directory
}

function createConfig() {
  return loadServerConfig({
    DATABASE_URL:
      'postgresql://postgres.abcdefghijklmnopqrst:runtime-secret@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres',
  })
}

function createClient(
  implementation: (query: string) => unknown,
): DatabaseClient & { readonly close: ReturnType<typeof vi.fn> } {
  const sql = (async (strings: TemplateStringsArray) => {
    const query = strings.join(' ')
    const result = implementation(query)

    if (result instanceof Error) {
      throw result
    }

    return result
  }) as unknown as Sql
  const close = vi.fn(async () => undefined)

  return {
    sql,
    db: {} as DatabaseClient['db'],
    close,
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  )
})

describe('database startup gate', () => {
  test('returns a ready client only after SELECT 1 and exact migration verification', async () => {
    const directory = await createMigrationDirectory()
    const client = createClient((query) =>
      query.includes('SELECT 1')
        ? []
        : [
            {
              createdAt: '1',
              hash: '17db4fd369edb9244b9f91d9aeed145c3d04ad8ba6e95d06247f07a63527d11a',
            },
          ],
    )

    const ready = await initializeDatabase(createConfig(), {
      migrationsDirectory: directory,
      createDatabaseClient: () => client,
    })

    expect(ready).toBe(client)
    expect(client.close).not.toHaveBeenCalled()
  })

  test.each([
    ['42P01', 'migrationRecordsMissing'],
    ['3F000', 'migrationRecordsMissing'],
    ['42501', 'databaseConnectionFailed'],
  ] as const)(
    'maps SQLSTATE %s to %s and closes the client',
    async (code, failure) => {
      const directory = await createMigrationDirectory()
      const client = createClient((query) =>
        query.includes('SELECT 1') ? [] : Object.assign(new Error(), { code }),
      )

      await expect(
        initializeDatabase(createConfig(), {
          migrationsDirectory: directory,
          createDatabaseClient: () => client,
        }),
      ).rejects.toMatchObject({ failure })
      expect(client.close).toHaveBeenCalledOnce()
    },
  )

  test.each(['42501', '57014'] as const)(
    'maps SELECT 1 SQLSTATE %s to a database connection failure',
    async (code) => {
      const directory = await createMigrationDirectory()
      const client = createClient((query) =>
        query.includes('SELECT 1') ? Object.assign(new Error(), { code }) : [],
      )

      await expect(
        initializeDatabase(createConfig(), {
          migrationsDirectory: directory,
          createDatabaseClient: () => client,
        }),
      ).rejects.toMatchObject({ failure: 'databaseConnectionFailed' })
      expect(client.close).toHaveBeenCalledOnce()
    },
  )

  test('closes the client before reporting incompatible local migration assets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'poker-broken-migrations-'))
    temporaryDirectories.push(directory)
    const close = vi.fn(async () => undefined)
    const client = createClient(() => [])
    client.close.mockImplementation(close)

    await expect(
      initializeDatabase(createConfig(), {
        migrationsDirectory: directory,
        createDatabaseClient: () => client,
      }),
    ).rejects.toMatchObject({
      failure: 'schemaVersionIncompatible',
    } satisfies Partial<StartupError>)
    expect(close).toHaveBeenCalledOnce()
  })
})
