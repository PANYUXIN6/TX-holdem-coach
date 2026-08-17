import type { Sql, TransactionSql } from 'postgres'
import { describe, expect, test } from 'vitest'
import {
  DatabaseOperationError,
  OwnerScopeResolutionError,
  PersistenceDataCorruptionError,
} from '../../src/persistence/errors.js'
import {
  DEFAULT_PLAYER_TIMEOUT_SETTINGS,
  patchPlayerTimeoutSettings,
  readPlayerTimeoutSettings,
  writePlayerTimeoutSettings,
} from '../../src/persistence/player-settings-repository.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import { RepositoryInputValidationError } from '../../src/persistence/errors.js'

interface SqlCall {
  readonly text: string
  readonly parameters: readonly unknown[]
}

function createSqlMock(responses: readonly unknown[]): {
  readonly sql: Sql
  readonly calls: SqlCall[]
} {
  const pending = [...responses]
  const calls: SqlCall[] = []
  const tag = ((template: TemplateStringsArray, ...parameters: unknown[]) => {
    calls.push({ text: template.join('?'), parameters })
    const response = pending.shift()
    if (response instanceof Error) {
      return Promise.reject(response)
    }
    return Promise.resolve(response)
  }) as unknown as Sql
  Object.assign(tag, {
    begin: <Result>(
      callback: (transaction: TransactionSql) => Promise<Result>,
    ) => callback(tag as unknown as TransactionSql),
    json: (value: unknown) => value,
    typed: (value: string) => JSON.parse(value) as unknown,
  })
  return { sql: tag, calls }
}

const ownerScope = { ownerId: 'local-user' } as const
const databaseOwnerId = '11111111-1111-4111-8111-111111111111'

describe('player timeout settings repository', () => {
  test('fails distinctly when the fixed Owner row is missing', async () => {
    const { sql, calls } = createSqlMock([[], []])

    await expect(
      readPlayerTimeoutSettings(sql, ownerScope),
    ).rejects.toBeInstanceOf(OwnerScopeResolutionError)
    await expect(
      writePlayerTimeoutSettings(sql, ownerScope, {
        attemptTimeoutSeconds: 10,
        decisionDeadlineSeconds: 30,
      }),
    ).rejects.toBeInstanceOf(OwnerScopeResolutionError)
    expect(calls).toHaveLength(2)
    expect(calls.every((call) => !call.text.includes('INSERT'))).toBe(true)
  })

  test('returns the deeply frozen code default without writing a missing row', async () => {
    const { sql, calls } = createSqlMock([[{ databaseOwnerId }], []])

    const settings = await readPlayerTimeoutSettings(sql, ownerScope)

    expect(settings).toBe(DEFAULT_PLAYER_TIMEOUT_SETTINGS)
    expect(Object.isFrozen(settings)).toBe(true)
    expect(calls).toHaveLength(2)
    expect(calls.every((call) => !call.text.includes('INSERT'))).toBe(true)
  })

  test.each([
    ['OwnerScope lookup', () => []],
    ['settings query', () => [[{ databaseOwnerId }]]],
  ])('does not expose the raw %s database failure', async (_name, prefix) => {
    const original = Object.assign(new Error('raw database failure'), {
      query: 'SELECT private_payload FROM app_private.app_settings',
      parameters: ['secret-parameter'],
      databaseUrl: 'postgres://user:password@example.invalid/database',
    })
    const { sql } = createSqlMock([...prefix(), original])

    let failure: unknown
    try {
      await readPlayerTimeoutSettings(sql, ownerScope)
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(DatabaseOperationError)
    expect(Object.hasOwn(failure as object, 'cause')).toBe(false)
    expect((failure as Error & { cause?: unknown }).cause).toBeUndefined()
  })

  test('reads a valid complete payload', async () => {
    const { sql } = createSqlMock([
      [{ databaseOwnerId }],
      [
        {
          settingPayload: {
            attemptTimeoutSeconds: 20,
            decisionDeadlineSeconds: 60,
          },
        },
      ],
    ])

    await expect(readPlayerTimeoutSettings(sql, ownerScope)).resolves.toEqual({
      attemptTimeoutSeconds: 20,
      decisionDeadlineSeconds: 60,
    })
  })

  test('does not hide corrupt persisted payloads behind defaults', async () => {
    const corrupt = createSqlMock([
      [{ databaseOwnerId }],
      [
        {
          settingPayload: {
            attemptTimeoutSeconds: 30,
            decisionDeadlineSeconds: 15,
          },
        },
      ],
    ])
    await expect(
      readPlayerTimeoutSettings(corrupt.sql, ownerScope),
    ).rejects.toBeInstanceOf(PersistenceDataCorruptionError)
  })

  test('does not expose the raw persisted settings payload through cause', async () => {
    const corrupt = createSqlMock([
      [{ databaseOwnerId }],
      [
        {
          settingPayload: {
            attemptTimeoutSeconds: 30,
            decisionDeadlineSeconds: 15,
            privateValue: 'secret-setting-value',
          },
        },
      ],
    ])

    let failure: unknown
    try {
      await readPlayerTimeoutSettings(corrupt.sql, ownerScope)
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(PersistenceDataCorruptionError)
    expect(Object.hasOwn(failure as object, 'cause')).toBe(false)
    expect((failure as Error & { cause?: unknown }).cause).toBeUndefined()
  })

  test('upserts only the app_settings row with a complete validated payload', async () => {
    const { sql, calls } = createSqlMock([[{ databaseOwnerId }], [], []])

    await expect(
      writePlayerTimeoutSettings(sql, ownerScope, {
        attemptTimeoutSeconds: 10,
        decisionDeadlineSeconds: 30,
      }),
    ).resolves.toEqual({
      attemptTimeoutSeconds: 10,
      decisionDeadlineSeconds: 30,
    })

    const writeCalls = calls.filter((call) => call.text.includes('INSERT'))
    expect(writeCalls).toHaveLength(1)
    expect(writeCalls[0]?.text).toContain('app_private.app_settings')
    expect(writeCalls[0]?.parameters).toContainEqual({
      attemptTimeoutSeconds: 10,
      decisionDeadlineSeconds: 30,
    })
    expect(writeCalls[0]?.text).not.toMatch(/agent_runs|agent_attempts/)
  })

  test('patches the locked latest value instead of a stale pre-read value', async () => {
    const { sql, calls } = createSqlMock([
      [{ databaseOwnerId }],
      [],
      [],
      [
        {
          settingPayload: {
            attemptTimeoutSeconds: 20,
            decisionDeadlineSeconds: 60,
          },
        },
      ],
      [
        {
          settingPayload: {
            attemptTimeoutSeconds: 20,
            decisionDeadlineSeconds: 90,
          },
        },
      ],
    ])
    const owner = await resolveOwnerScope(sql, ownerScope)

    await expect(
      patchPlayerTimeoutSettings(sql as never, owner, {
        decisionDeadlineSeconds: 90,
      }),
    ).resolves.toEqual({
      attemptTimeoutSeconds: 20,
      decisionDeadlineSeconds: 90,
    })

    expect(calls[1]?.text).toContain('pg_advisory_xact_lock')
    expect(calls[2]?.text).toContain('ON CONFLICT')
    expect(calls[2]?.text).toContain('DO NOTHING')
    expect(calls[3]?.text).toContain('FOR UPDATE')
    expect(calls[4]?.text).toContain('RETURNING')
    expect(calls[4]?.parameters).toContainEqual({
      attemptTimeoutSeconds: 20,
      decisionDeadlineSeconds: 90,
    })
  })

  test('rejects an invalid locked merge before updating', async () => {
    const { sql, calls } = createSqlMock([
      [{ databaseOwnerId }],
      [],
      [],
      [
        {
          settingPayload: {
            attemptTimeoutSeconds: 10,
            decisionDeadlineSeconds: 60,
          },
        },
      ],
    ])
    const owner = await resolveOwnerScope(sql, ownerScope)

    await expect(
      patchPlayerTimeoutSettings(sql as never, owner, {
        attemptTimeoutSeconds: 30,
        decisionDeadlineSeconds: 15,
      }),
    ).rejects.toBeInstanceOf(RepositoryInputValidationError)
    expect(
      calls.some((call) => call.text.trimStart().startsWith('UPDATE')),
    ).toBe(false)
  })
})
