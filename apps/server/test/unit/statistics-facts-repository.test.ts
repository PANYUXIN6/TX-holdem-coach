import type {
  HandStatisticsQuery,
  SessionStatisticsQuery,
} from '@tx-holdem-coach/contracts'
import type { Sql, TransactionSql } from 'postgres'
import { describe, expect, test } from 'vitest'
import { createStatisticsFactsRepository } from '../../src/persistence/statistics-facts-repository.js'
import { DatabaseOperationError } from '../../src/persistence/errors.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import type { StatisticsFactsReader } from '../../src/sessions/statistics/statistics.js'

const databaseOwnerId = '11111111-1111-4111-8111-111111111111'
const transactionSettingsFailure = new Error('transaction settings unavailable')

function createSqlMock(responses: readonly unknown[]): Sql {
  const pending = [...responses]
  const tag = (() => {
    const response = pending.shift()
    if (response instanceof Error) return Promise.reject(response)
    return Promise.resolve(response)
  }) as unknown as Sql
  Object.assign(tag, {
    begin: <Result>(
      callback: (transaction: TransactionSql) => Promise<Result>,
    ) => callback(tag as unknown as TransactionSql),
  })
  return tag
}

const handQuery: HandStatisticsQuery = {
  scope: 'hands',
  subject: 'user',
  from: null,
  to: null,
  sessionId: null,
  personaId: null,
  personaVersion: null,
  personaName: null,
  configSnapshotKey: null,
  position: null,
  groupBy: 'none',
}

const sessionQuery: SessionStatisticsQuery = {
  scope: 'sessions',
  subject: 'user',
  from: null,
  to: null,
  sessionId: null,
  personaId: null,
  personaVersion: null,
  personaName: null,
  configSnapshotKey: null,
  groupBy: 'none',
}

async function createReaderWithFailingTransactionSettings(): Promise<StatisticsFactsReader> {
  const sql = createSqlMock([[{ databaseOwnerId }], transactionSettingsFailure])
  const owner = await resolveOwnerScope(sql, { ownerId: 'local-user' })
  return createStatisticsFactsRepository({ sql, owner })
}

describe('statistics facts repository', () => {
  test.each([
    [
      'hands',
      (reader: StatisticsFactsReader) =>
        reader.scanHandFacts(handQuery, async () => undefined),
    ],
    [
      'sessions',
      (reader: StatisticsFactsReader) =>
        reader.scanSessionFacts(sessionQuery, async () => undefined),
    ],
  ])(
    'maps %s transaction settings failures to database errors',
    async (_, scan) => {
      const reader = await createReaderWithFailingTransactionSettings()

      await expect(scan(reader)).rejects.toBeInstanceOf(DatabaseOperationError)
    },
  )
})
