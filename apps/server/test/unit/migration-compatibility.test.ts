import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, test } from 'vitest'
import {
  assertExactMigrationSequence,
  assertMigrationSequence,
  buildExpectedMigrationSequence,
  MigrationCompatibilityError,
} from '../../src/db/migration-compatibility.js'

const temporaryDirectories: string[] = []

async function createMigrationDirectory(
  entries: readonly { idx: number; when: number; tag: string }[],
  sqlByTag: Readonly<Record<string, string>>,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'poker-migrations-'))
  temporaryDirectories.push(directory)
  await mkdir(join(directory, 'meta'))
  await writeFile(
    join(directory, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: entries.map((entry) => ({
        ...entry,
        version: '7',
        breakpoints: true,
      })),
    }),
  )

  await Promise.all(
    Object.entries(sqlByTag).map(([tag, sql]) =>
      writeFile(join(directory, `${tag}.sql`), sql),
    ),
  )

  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  )
})

describe('migration compatibility', () => {
  test('builds the expected sequence with Drizzle-compatible SQL hashes', async () => {
    const sql = 'CREATE SCHEMA IF NOT EXISTS "app_private";\n'
    const directory = await createMigrationDirectory(
      [{ idx: 0, when: 1_700_000_000_000, tag: '0000_baseline' }],
      { '0000_baseline': sql },
    )

    await expect(buildExpectedMigrationSequence(directory)).resolves.toEqual([
      {
        when: 1_700_000_000_000,
        hash: createHash('sha256').update(sql).digest('hex'),
      },
    ])
  })

  test.each([
    {
      entries: [{ idx: 1, when: 1, tag: '0000_baseline' }],
      sqlByTag: { '0000_baseline': 'SELECT 1;' },
    },
    {
      entries: [
        { idx: 0, when: 2, tag: '0000_baseline' },
        { idx: 1, when: 1, tag: '0001_next' },
      ],
      sqlByTag: { '0000_baseline': 'SELECT 1;', '0001_next': 'SELECT 2;' },
    },
    {
      entries: [{ idx: 0, when: 1, tag: '0000_missing' }],
      sqlByTag: {},
    },
    {
      entries: [
        { idx: 0, when: 1, tag: '0000_baseline' },
        { idx: 1, when: 2, tag: '0000_baseline' },
      ],
      sqlByTag: { '0000_baseline': 'SELECT 1;' },
    },
  ])(
    'rejects invalid local migration assets',
    async ({ entries, sqlByTag }) => {
      const directory = await createMigrationDirectory(entries, sqlByTag)

      await expect(
        buildExpectedMigrationSequence(directory),
      ).rejects.toMatchObject({
        failure: 'schemaVersionIncompatible',
      } satisfies Partial<MigrationCompatibilityError>)
    },
  )

  test('allows migration IDs with sequence gaps when ordered records match', () => {
    expect(() =>
      assertExactMigrationSequence(
        [
          { when: 10, hash: 'first' },
          { when: 20, hash: 'second' },
        ],
        [
          { createdAt: '10', hash: 'first' },
          { createdAt: '20', hash: 'second' },
        ],
      ),
    ).not.toThrow()
  })

  test.each([
    {
      actual: [{ createdAt: '10', hash: 'first' }],
      failure: 'migrationRecordsMissing',
    },
    {
      actual: [
        { createdAt: '10', hash: 'first' },
        { createdAt: '20', hash: 'second' },
        { createdAt: '30', hash: 'extra' },
      ],
      failure: 'schemaVersionIncompatible',
    },
    {
      actual: [
        { createdAt: '20', hash: 'second' },
        { createdAt: '10', hash: 'first' },
      ],
      failure: 'schemaVersionIncompatible',
    },
    {
      actual: [
        { createdAt: '10', hash: 'first' },
        { createdAt: '21', hash: 'second' },
      ],
      failure: 'schemaVersionIncompatible',
    },
    {
      actual: [
        { createdAt: '10', hash: 'first' },
        { createdAt: '20', hash: 'changed' },
      ],
      failure: 'schemaVersionIncompatible',
    },
  ])('classifies exact-sequence differences', ({ actual, failure }) => {
    expect(() =>
      assertExactMigrationSequence(
        [
          { when: 10, hash: 'first' },
          { when: 20, hash: 'second' },
        ],
        actual,
      ),
    ).toThrow(
      expect.objectContaining({
        failure,
      }),
    )
  })

  test.each([
    ['exact', []],
    ['prefix', []],
    ['prefix', [{ createdAt: '10', hash: 'first' }]],
    [
      'prefix',
      [
        { createdAt: '10', hash: 'first' },
        { createdAt: '20', hash: 'second' },
      ],
    ],
  ] as const)('applies the %s migration-state matrix', (mode, actual) => {
    const assertion = () =>
      assertMigrationSequence(
        [
          { when: 10, hash: 'first' },
          { when: 20, hash: 'second' },
        ],
        actual,
        mode,
      )

    if (mode === 'exact' && actual.length === 0) {
      expect(assertion).toThrow(
        expect.objectContaining({ failure: 'migrationRecordsMissing' }),
      )
    } else {
      expect(assertion).not.toThrow()
    }
  })

  test.each([
    {
      name: 'database ahead of the artifact',
      actual: [
        { createdAt: '10', hash: 'first' },
        { createdAt: '20', hash: 'second' },
        { createdAt: '30', hash: 'third' },
      ],
    },
    {
      name: 'created_at divergence',
      actual: [{ createdAt: '11', hash: 'first' }],
    },
    {
      name: 'SQL hash divergence',
      actual: [{ createdAt: '10', hash: 'changed' }],
    },
  ])('rejects a prefix with $name', ({ actual }) => {
    expect(() =>
      assertMigrationSequence(
        [
          { when: 10, hash: 'first' },
          { when: 20, hash: 'second' },
        ],
        actual,
        'prefix',
      ),
    ).toThrow(expect.objectContaining({ failure: 'schemaVersionIncompatible' }))
  })
})
