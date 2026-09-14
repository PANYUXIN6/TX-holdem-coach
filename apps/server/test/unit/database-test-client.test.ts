import { describe, expect, test, vi } from 'vitest'
import type { Sql, TransactionSql } from 'postgres'
import { protectDatabaseTestTransactions } from '../integration/database-test-client.js'

const applicationName = 'txhc-dbtest:0123456789abcdef:m55-primary'

function fixture(
  settings?: {
    readonly applicationName?: string
    readonly statementTimeout?: string
    readonly idleTimeout?: string
  },
  signal?: AbortSignal,
) {
  const queries: string[] = []
  const transaction = Object.assign(
    vi.fn(async () => []),
    {
      unsafe: vi.fn((statement: string) => {
        queries.push(statement)
        return {
          simple: async () => [
            [],
            [],
            [],
            [
              {
                application_name: settings?.applicationName ?? applicationName,
              },
            ],
            [{ statement_timeout: settings?.statementTimeout ?? '90s' }],
            [
              {
                idle_in_transaction_session_timeout:
                  settings?.idleTimeout ?? '1min',
              },
            ],
          ],
        }
      }),
    },
  ) as unknown as TransactionSql
  const begin = vi.fn(async (...args: unknown[]) => {
    const callback = args.at(-1) as (tx: TransactionSql) => unknown
    const result = callback(transaction)
    return Array.isArray(result) ? Promise.all(result) : result
  })
  const raw = Object.assign(vi.fn(), { begin }) as unknown as Sql
  return {
    client: protectDatabaseTestTransactions(raw, applicationName, signal),
    transaction,
    begin,
    queries,
  }
}

describe('database test transaction protection', () => {
  test('verifies transaction-local settings before business SQL without taking a query snapshot', async () => {
    const f = fixture()
    await expect(
      f.client.begin(
        'isolation level repeatable read read only',
        async (tx) => {
          expect(f.queries).toHaveLength(1)
          expect(f.queries[0]).toContain(
            `SET LOCAL application_name = '${applicationName}'`,
          )
          expect(f.queries[0]).toContain('SET LOCAL statement_timeout')
          expect(f.queries[0]).toContain(
            'SET LOCAL idle_in_transaction_session_timeout',
          )
          expect(f.queries[0]).not.toMatch(/\bSELECT\b/i)
          await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`
          return 'completed'
        },
      ),
    ).resolves.toBe('completed')
    expect(f.begin.mock.calls[0]?.[0]).toBe(
      'isolation level repeatable read read only',
    )
  })

  test.each([
    { applicationName: 'Supavisor' },
    { statementTimeout: '2min' },
    { idleTimeout: '0' },
  ])(
    'rejects ineffective pooler settings before invoking the transaction callback: %j',
    async (settings) => {
      const f = fixture(settings)
      const operation = vi.fn()
      await expect(f.client.begin(operation)).rejects.toThrow(
        '数据库测试事务配置未生效',
      )
      expect(operation).not.toHaveBeenCalled()
    },
  )

  test('aborts an idle callback for rollback and rejects subsequent business SQL', async () => {
    const controller = new AbortController()
    const failure = new Error('test aborted')
    const f = fixture(undefined, controller.signal)
    let reportStarted!: (tx: TransactionSql) => void
    const started = new Promise<TransactionSql>((resolve) => {
      reportStarted = resolve
    })
    const completion = f.client.begin(async (tx) => {
      reportStarted(tx)
      await new Promise<void>(() => undefined)
    })
    const transaction = await started
    controller.abort(failure)
    await expect(completion).rejects.toBe(failure)
    expect(() => transaction`SELECT 1`).toThrow(failure)
    expect(() => transaction.unsafe('SELECT 1')).toThrow(failure)
    expect(() => f.client.begin(() => undefined)).toThrow(failure)
    expect(() => f.client`SELECT 1`).toThrow(failure)
  })

  test('preserves the driver callback-array contract and the original business failure', async () => {
    const f = fixture()
    await expect(
      f.client.begin(() => [Promise.resolve(1), Promise.resolve(2)]),
    ).resolves.toEqual([1, 2])
    const failure = new Error('business failure')
    await expect(
      f.client.begin(() => {
        throw failure
      }),
    ).rejects.toBe(failure)
  })
})
