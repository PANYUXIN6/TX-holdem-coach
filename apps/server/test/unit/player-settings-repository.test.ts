import type { Sql, TransactionSql } from 'postgres'
import { describe, expect, test } from 'vitest'
import { patchPlayerTimeoutSettings } from '../../src/persistence/player-settings-repository.js'
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
  })
  return { sql: tag, calls }
}

const ownerScope = { ownerId: 'local-user' } as const
const databaseOwnerId = '11111111-1111-4111-8111-111111111111'

describe('player timeout settings repository', () => {
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
