import type { Sql } from 'postgres'
import { describe, expect, test, vi } from 'vitest'
import { DatabaseOperationError } from '../../src/persistence/errors.js'
import type { ResolvedOwnerScope } from '../../src/persistence/owner-scope.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
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

  test('keeps a committed deletion successful when interrupts and logging throw', async () => {
    const databaseOwnerId = '11111111-1111-4111-8111-111111111111'
    const sessionId = '2a0dc0dd-843a-4e53-a62e-e5ac22f90a3e'
    const runIds = [
      '3e4e4ced-ce4b-46cc-a778-7560ab89c22e',
      '7c63940e-696c-4476-a128-c9d1e6f6eb36',
    ] as const
    const ownerSql = ((
      _template: TemplateStringsArray,
      ..._parameters: unknown[]
    ) => Promise.resolve([{ databaseOwnerId }])) as unknown as Sql
    const resolvedOwner = await resolveOwnerScope(ownerSql, {
      ownerId: 'local-user',
    })
    const responses = [
      [{ sessionId, lifecycleStatus: 'ended' }],
      runIds.map((agentRunId, index) => ({
        agentRunId,
        runtime: index === 0 ? ('player' as const) : ('coach' as const),
      })),
      runIds.map((agentRunId) => ({ agentRunId })),
      [{ sessionId }],
      [{ sessionId }],
    ]
    const transaction = ((
      _template: TemplateStringsArray,
      ..._parameters: unknown[]
    ) => Promise.resolve(responses.shift())) as unknown as Sql
    const sql = Object.assign(transaction, {
      begin: (operation: (value: never) => Promise<unknown>) =>
        operation(transaction as never),
    }) as unknown as Sql
    const interrupt = vi.fn((run: { agentRunId: string }) => {
      if (run.agentRunId === runIds[0]) {
        throw new Error('synchronous interrupt failure')
      }
      return Promise.reject(new Error('asynchronous interrupt failure'))
    })
    const logInterruptFailure = vi.fn(() => {
      throw new Error('logging sink failure')
    })
    const service = createSessionDataDeletionService({
      sql,
      owner: resolvedOwner,
      interrupt: { interrupt },
      logInterruptFailure,
      now: () => '2026-08-11T00:00:00.000Z',
    })

    await expect(
      service.deleteEndedSession(sessionId, {
        confirmation: '永久删除本场',
      }),
    ).resolves.toEqual({
      deletedSessionId: sessionId,
      invalidatedRunCount: 2,
    })
    expect(interrupt).toHaveBeenCalledTimes(2)
    expect(logInterruptFailure).toHaveBeenCalledWith(2)
  })
})
