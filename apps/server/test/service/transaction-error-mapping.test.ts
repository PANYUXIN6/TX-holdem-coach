import type { Sql } from 'postgres'
import { describe, expect, test } from 'vitest'
import { DatabaseOperationError } from '../../src/persistence/errors.js'
import type { ResolvedOwnerScope } from '../../src/persistence/owner-scope.js'
import { createPlayerAgentSettingsService } from '../../src/settings/player-agent-settings-service.js'
import { createSessionDataDeletionService } from '../../src/sessions/session-data-deletion-service.js'
import { runDatabaseTransaction } from '../../src/persistence/database-transaction.js'

const owner = {} as ResolvedOwnerScope
const failingSql = {
  begin: async () => {
    throw new Error('raw commit failure with private database detail')
  },
} as unknown as Sql

describe('transaction failure mapping', () => {
  test('sanitizes transaction shell failures without rewriting callback errors', async () => {
    await expect(
      runDatabaseTransaction(failingSql, async () => 'unused'),
    ).rejects.toBeInstanceOf(DatabaseOperationError)

    const domainError = new Error('domain invariant')
    const callbackSql = {
      begin: async (operation: (transaction: never) => Promise<unknown>) =>
        operation({} as never),
    } as unknown as Sql
    await expect(
      runDatabaseTransaction(callbackSql, async () => {
        throw domainError
      }),
    ).rejects.toBe(domainError)
  })
  test('sanitizes Player settings transaction/commit failures', async () => {
    const service = createPlayerAgentSettingsService({ sql: failingSql, owner })

    await expect(
      service.update({
        settings: { attemptTimeoutSeconds: 20 },
      }),
    ).rejects.toBeInstanceOf(DatabaseOperationError)
  })

  test('sanitizes deletion transaction/commit failures', async () => {
    const service = createSessionDataDeletionService({ sql: failingSql, owner })

    await expect(
      service.deleteEndedSession('2a0dc0dd-843a-4e53-a62e-e5ac22f90a3e', {
        confirmation: '永久删除本场',
      }),
    ).rejects.toBeInstanceOf(DatabaseOperationError)
    await expect(
      service.clearAll({
        confirmation: '永久清空全部数据',
      }),
    ).rejects.toBeInstanceOf(DatabaseOperationError)
  })
})
