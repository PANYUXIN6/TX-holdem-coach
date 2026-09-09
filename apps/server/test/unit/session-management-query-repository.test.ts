import type { Sql, TransactionSql } from 'postgres'
import { describe, expect, it } from 'vitest'
import { createSessionManagementFactsRepository } from '../../src/persistence/session-management-query-repository.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'

const ownerId = '10000000-0000-4000-8000-000000000001'
const sessionId = '10000000-0000-4000-8000-000000000002'
const timestamp = '2026-09-08T00:00:00.000000Z'

function roster() {
  return Array.from({ length: 6 }, (_, seatNumber) => ({
    participantId: `20000000-0000-4000-8000-00000000000${seatNumber + 1}`,
    participantType: seatNumber === 0 ? 'user' : 'agent',
    seatNumber,
    displayName: seatNumber === 0 ? null : `AI ${seatNumber}`,
    avatarColor: seatNumber === 0 ? null : '#123456',
    personaId: seatNumber === 0 ? null : `persona-${seatNumber}`,
    personaVersion: seatNumber === 0 ? null : 1,
    configSnapshotKey: seatNumber === 0 ? null : 'a'.repeat(64),
  }))
}

function sqlMock(): Sql {
  const responses: unknown[] = [
    [{ databaseOwnerId: ownerId }],
    [],
    [
      {
        sessionId,
        lifecycle: 'readonlyDiagnostic',
        createdAt: timestamp,
        endedAt: null,
        stateVersion: 1,
        currentHandId: null,
        completedHandCount: 0,
        snapshotPayloadVersion: null,
        snapshotPayload: null,
        checkpointPayloadVersion: null,
        checkpointPayload: null,
        roster: roster(),
      },
      { corruptSentinel: true },
    ],
  ]
  const tag = (() => Promise.resolve(responses.shift())) as unknown as Sql
  Object.assign(tag, {
    begin: <Result>(
      callback: (transaction: TransactionSql) => Promise<Result>,
    ) => callback(tag as unknown as TransactionSql),
    unsafe: () => Promise.resolve(responses.shift()),
  })
  return tag
}

describe('M5.5 场次管理查询 Repository', () => {
  it('只解码 limit 内的业务行，额外根行仅用于 hasMore', async () => {
    const sql = sqlMock()
    const owner = await resolveOwnerScope(sql, { ownerId: 'local-user' })
    const repository = createSessionManagementFactsRepository({ sql, owner })

    await expect(
      repository.listSessionManagementFacts({
        lifecycle: 'all',
        from: null,
        to: null,
        sort: 'newest',
        limit: 1,
        after: null,
      }),
    ).resolves.toMatchObject({
      items: [{ sessionId }],
      hasMore: true,
    })
  })
})
