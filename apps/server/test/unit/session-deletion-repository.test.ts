import type { Sql, TransactionSql } from 'postgres'
import { describe, expect, test } from 'vitest'
import {
  DatabaseOperationError,
  isRepositoryDomainError,
  OwnerScopeResolutionError,
  RepositoryInputValidationError,
  ResourceNotFoundError,
  SessionDeletionTransitionError,
} from '../../src/persistence/errors.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import {
  clearOwnerSessionData,
  deleteEndedSessionData,
} from '../../src/persistence/session-deletion-repository.js'

const databaseOwnerId = '11111111-1111-4111-8111-111111111111'
const sessionId = '22222222-2222-4222-8222-222222222222'
const secondSessionId = '33333333-3333-4333-8333-333333333333'
const playerRunId = '55555555-5555-4555-8555-555555555555'
const coachRunId = '44444444-4444-4444-8444-444444444444'
const unexpectedId = '66666666-6666-4666-8666-666666666666'
const deletedAt = '2026-08-05T04:00:00.000Z'

function lockedSessionRow(
  lifecycleStatus: 'active' | 'ended' | 'readonlyDiagnostic',
) {
  return { sessionId, lifecycleStatus }
}

async function resolvedOwner() {
  const sql = (() => Promise.resolve([{ databaseOwnerId }])) as unknown as Sql
  return resolveOwnerScope(sql, { ownerId: 'local-user' })
}

function createTransactionBoundary(responses: readonly unknown[] = []) {
  const pending = [...responses]
  let sqlCallCount = 0
  const transaction = (() => {
    sqlCallCount += 1
    const response = pending.shift()
    return response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(response ?? [])
  }) as unknown as TransactionSql
  return {
    transaction,
    getSqlCallCount: () => sqlCallCount,
    getRemainingResponseCount: () => pending.length,
  }
}

describe('session deletion repository', () => {
  test('classifies deletion transition failures as repository domain errors', () => {
    const error = new SessionDeletionTransitionError()

    expect(isRepositoryDomainError(error)).toBe(true)
    expect(error).toMatchObject({
      name: 'SessionDeletionTransitionError',
      message: '场次删除状态无法推进。',
    })
  })

  test('rejects a non-callable transaction before the database boundary', async () => {
    await expect(
      deleteEndedSessionData(undefined as never, await resolvedOwner(), {
        sessionId,
        deletedAt,
      }),
    ).rejects.toBeInstanceOf(RepositoryInputValidationError)
  })

  test('rejects a forged owner capability before the database boundary', async () => {
    const boundary = createTransactionBoundary()
    const owner = await resolvedOwner()

    await expect(
      deleteEndedSessionData(boundary.transaction, { ...owner } as never, {
        sessionId,
        deletedAt,
      }),
    ).rejects.toBeInstanceOf(RepositoryInputValidationError)
    expect(boundary.getSqlCallCount()).toBe(0)
  })

  test('rejects unknown delete input fields before the database boundary', async () => {
    const boundary = createTransactionBoundary()

    await expect(
      deleteEndedSessionData(boundary.transaction, await resolvedOwner(), {
        sessionId,
        deletedAt,
        unexpected: true,
      } as never),
    ).rejects.toBeInstanceOf(RepositoryInputValidationError)
    expect(boundary.getSqlCallCount()).toBe(0)
  })

  test('rejects a non-UUID session id before the database boundary', async () => {
    const boundary = createTransactionBoundary()

    await expect(
      deleteEndedSessionData(boundary.transaction, await resolvedOwner(), {
        sessionId: 'not-a-session-id',
        deletedAt,
      }),
    ).rejects.toBeInstanceOf(RepositoryInputValidationError)
    expect(boundary.getSqlCallCount()).toBe(0)
  })

  test('rejects a non-canonical deletion timestamp before the database boundary', async () => {
    const boundary = createTransactionBoundary()

    await expect(
      deleteEndedSessionData(boundary.transaction, await resolvedOwner(), {
        sessionId,
        deletedAt: '2026-08-05T12:00:00+08:00',
      }),
    ).rejects.toBeInstanceOf(RepositoryInputValidationError)
    expect(boundary.getSqlCallCount()).toBe(0)
  })

  test('converts a session lock database failure without exposing its cause', async () => {
    const boundary = createTransactionBoundary([
      Object.assign(new Error('raw database failure'), {
        query: 'SELECT private_payload',
        databaseUrl: 'postgres://secret@example.invalid/database',
      }),
    ])

    let failure: unknown
    try {
      await deleteEndedSessionData(
        boundary.transaction,
        await resolvedOwner(),
        { sessionId, deletedAt },
      )
    } catch (error) {
      failure = error
    }

    expect(failure).toMatchObject({
      name: 'DatabaseOperationError',
      message: '数据库操作失败。',
    })
    expect(Object.hasOwn(failure as object, 'cause')).toBe(false)
    expect(boundary.getRemainingResponseCount()).toBe(0)
  })

  test('does not distinguish a missing or cross-owner session', async () => {
    const boundary = createTransactionBoundary([[]])

    await expect(
      deleteEndedSessionData(boundary.transaction, await resolvedOwner(), {
        sessionId,
        deletedAt,
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError)
  })

  test('rejects a locked active session before touching its runs', async () => {
    const boundary = createTransactionBoundary([
      [lockedSessionRow('active')],
      new Error('run boundary must remain untouched'),
    ])

    await expect(
      deleteEndedSessionData(boundary.transaction, await resolvedOwner(), {
        sessionId,
        deletedAt,
      }),
    ).rejects.toBeInstanceOf(SessionDeletionTransitionError)
    expect(boundary.getRemainingResponseCount()).toBe(1)
  })

  test('rejects a locked diagnostic session before touching its runs', async () => {
    const boundary = createTransactionBoundary([
      [lockedSessionRow('readonlyDiagnostic')],
      new Error('run boundary must remain untouched'),
    ])

    await expect(
      deleteEndedSessionData(boundary.transaction, await resolvedOwner(), {
        sessionId,
        deletedAt,
      }),
    ).rejects.toBeInstanceOf(SessionDeletionTransitionError)
    expect(boundary.getRemainingResponseCount()).toBe(1)
  })

  test('deletes one ended session with no active runs and freezes the result', async () => {
    const boundary = createTransactionBoundary([
      [lockedSessionRow('ended')],
      [],
      [],
      [{ sessionId }],
      [{ sessionId }],
    ])

    const result = await deleteEndedSessionData(
      boundary.transaction,
      await resolvedOwner(),
      { sessionId, deletedAt },
    )

    expect(result).toEqual({ sessionId, invalidatedRuns: [] })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.invalidatedRuns)).toBe(true)
  })

  test('returns single-session run references in stable order and deeply frozen', async () => {
    const boundary = createTransactionBoundary([
      [lockedSessionRow('ended')],
      [
        { agentRunId: playerRunId, runtime: 'player' },
        { agentRunId: coachRunId, runtime: 'coach' },
      ],
      [{ agentRunId: coachRunId }, { agentRunId: playerRunId }],
      [{ sessionId }],
      [{ sessionId }],
    ])

    const result = await deleteEndedSessionData(
      boundary.transaction,
      await resolvedOwner(),
      { sessionId, deletedAt },
    )

    expect(result.invalidatedRuns).toEqual([
      { agentRunId: coachRunId, runtime: 'coach' },
      { agentRunId: playerRunId, runtime: 'player' },
    ])
    expect(Object.isFrozen(result.invalidatedRuns[0])).toBe(true)
  })

  test('rejects a run cancellation identity mismatch before session mutation', async () => {
    const boundary = createTransactionBoundary([
      [lockedSessionRow('ended')],
      [{ agentRunId: playerRunId, runtime: 'player' }],
      [],
      new Error('session mutation must remain untouched'),
    ])

    await expect(
      deleteEndedSessionData(boundary.transaction, await resolvedOwner(), {
        sessionId,
        deletedAt,
      }),
    ).rejects.toBeInstanceOf(SessionDeletionTransitionError)
    expect(boundary.getRemainingResponseCount()).toBe(1)
  })

  test('rejects a session pointer update mismatch before the final delete', async () => {
    const boundary = createTransactionBoundary([
      [lockedSessionRow('ended')],
      [],
      [],
      [],
      new Error('final delete must remain untouched'),
    ])

    await expect(
      deleteEndedSessionData(boundary.transaction, await resolvedOwner(), {
        sessionId,
        deletedAt,
      }),
    ).rejects.toBeInstanceOf(SessionDeletionTransitionError)
    expect(boundary.getRemainingResponseCount()).toBe(1)
  })

  test('rejects a final single-session delete mismatch', async () => {
    const boundary = createTransactionBoundary([
      [lockedSessionRow('ended')],
      [],
      [],
      [{ sessionId }],
      [],
    ])

    await expect(
      deleteEndedSessionData(boundary.transaction, await resolvedOwner(), {
        sessionId,
        deletedAt,
      }),
    ).rejects.toBeInstanceOf(SessionDeletionTransitionError)
  })

  test('rejects a non-callable clear transaction before the database boundary', async () => {
    await expect(
      clearOwnerSessionData(undefined as never, await resolvedOwner(), {
        deletedAt,
      }),
    ).rejects.toBeInstanceOf(RepositoryInputValidationError)
  })

  test('rejects a forged owner capability for clear before the database boundary', async () => {
    const boundary = createTransactionBoundary()
    const owner = await resolvedOwner()

    await expect(
      clearOwnerSessionData(boundary.transaction, { ...owner } as never, {
        deletedAt,
      }),
    ).rejects.toBeInstanceOf(RepositoryInputValidationError)
    expect(boundary.getSqlCallCount()).toBe(0)
  })

  test('rejects unknown clear input fields before the database boundary', async () => {
    const boundary = createTransactionBoundary()

    await expect(
      clearOwnerSessionData(boundary.transaction, await resolvedOwner(), {
        deletedAt,
        unexpected: true,
      } as never),
    ).rejects.toBeInstanceOf(RepositoryInputValidationError)
    expect(boundary.getSqlCallCount()).toBe(0)
  })

  test('rejects a non-canonical clear timestamp before the database boundary', async () => {
    const boundary = createTransactionBoundary()

    await expect(
      clearOwnerSessionData(boundary.transaction, await resolvedOwner(), {
        deletedAt: '2026-08-05T12:00:00+08:00',
      }),
    ).rejects.toBeInstanceOf(RepositoryInputValidationError)
    expect(boundary.getSqlCallCount()).toBe(0)
  })

  test('clears an owner with no sessions without touching settings', async () => {
    const boundary = createTransactionBoundary([[{ databaseOwnerId }], []])

    const result = await clearOwnerSessionData(
      boundary.transaction,
      await resolvedOwner(),
      { deletedAt },
    )

    expect(result).toEqual({ deletedSessionCount: 0, invalidatedRuns: [] })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.invalidatedRuns)).toBe(true)
    expect(boundary.getSqlCallCount()).toBe(2)
  })

  test('rejects clear when the resolved owner row no longer exists', async () => {
    const boundary = createTransactionBoundary([[]])

    await expect(
      clearOwnerSessionData(boundary.transaction, await resolvedOwner(), {
        deletedAt,
      }),
    ).rejects.toBeInstanceOf(OwnerScopeResolutionError)
    expect(boundary.getSqlCallCount()).toBe(1)
  })

  test.each([
    { stage: 'owner lock', responsesBeforeFailure: [] },
    {
      stage: 'session lock',
      responsesBeforeFailure: [[{ databaseOwnerId }]],
    },
    {
      stage: 'run lock',
      responsesBeforeFailure: [
        [{ databaseOwnerId }],
        [{ sessionId }, { sessionId: secondSessionId }],
      ],
    },
    {
      stage: 'run cancellation',
      responsesBeforeFailure: [
        [{ databaseOwnerId }],
        [{ sessionId }, { sessionId: secondSessionId }],
        [{ agentRunId: playerRunId, runtime: 'player' }],
      ],
    },
    {
      stage: 'session pointer update',
      responsesBeforeFailure: [
        [{ databaseOwnerId }],
        [{ sessionId }, { sessionId: secondSessionId }],
        [{ agentRunId: playerRunId, runtime: 'player' }],
        [{ agentRunId: playerRunId }],
      ],
    },
    {
      stage: 'final session delete',
      responsesBeforeFailure: [
        [{ databaseOwnerId }],
        [{ sessionId }, { sessionId: secondSessionId }],
        [{ agentRunId: playerRunId, runtime: 'player' }],
        [{ agentRunId: playerRunId }],
        [{ sessionId }, { sessionId: secondSessionId }],
      ],
    },
  ])(
    'sanitizes a clear $stage failure and stops without further modification',
    async ({ responsesBeforeFailure }) => {
      const rawFailure = Object.assign(new Error('raw database failure'), {
        query: 'private SQL',
        databaseUrl: 'postgres://secret@example.invalid/database',
      })
      const boundary = createTransactionBoundary([
        ...responsesBeforeFailure,
        rawFailure,
        new Error('later modification must remain untouched'),
      ])

      let failure: unknown
      try {
        await clearOwnerSessionData(
          boundary.transaction,
          await resolvedOwner(),
          { deletedAt },
        )
      } catch (error) {
        failure = error
      }

      expect(failure).toBeInstanceOf(DatabaseOperationError)
      expect(failure).toMatchObject({
        name: 'DatabaseOperationError',
        message: '数据库操作失败。',
      })
      expect(Object.hasOwn(failure as object, 'cause')).toBe(false)
      expect(boundary.getRemainingResponseCount()).toBe(1)
    },
  )

  test('rejects a clear run cancellation count mismatch before session mutation', async () => {
    const boundary = createTransactionBoundary([
      [{ databaseOwnerId }],
      [{ sessionId }, { sessionId: secondSessionId }],
      [{ agentRunId: playerRunId, runtime: 'player' }],
      [],
      new Error('session mutation must remain untouched'),
    ])

    await expect(
      clearOwnerSessionData(boundary.transaction, await resolvedOwner(), {
        deletedAt,
      }),
    ).rejects.toBeInstanceOf(SessionDeletionTransitionError)
    expect(boundary.getRemainingResponseCount()).toBe(1)
  })

  test('rejects a clear run cancellation identity mismatch with the same count', async () => {
    const boundary = createTransactionBoundary([
      [{ databaseOwnerId }],
      [{ sessionId }, { sessionId: secondSessionId }],
      [{ agentRunId: playerRunId, runtime: 'player' }],
      [{ agentRunId: unexpectedId }],
      new Error('session mutation must remain untouched'),
    ])

    await expect(
      clearOwnerSessionData(boundary.transaction, await resolvedOwner(), {
        deletedAt,
      }),
    ).rejects.toBeInstanceOf(SessionDeletionTransitionError)
    expect(boundary.getRemainingResponseCount()).toBe(1)
  })

  test('rejects a clear session pointer update count mismatch before the final delete', async () => {
    const boundary = createTransactionBoundary([
      [{ databaseOwnerId }],
      [{ sessionId }, { sessionId: secondSessionId }],
      [],
      [],
      [{ sessionId }],
      new Error('final delete must remain untouched'),
    ])

    await expect(
      clearOwnerSessionData(boundary.transaction, await resolvedOwner(), {
        deletedAt,
      }),
    ).rejects.toBeInstanceOf(SessionDeletionTransitionError)
    expect(boundary.getRemainingResponseCount()).toBe(1)
  })

  test('rejects a clear session pointer update identity mismatch with the same count', async () => {
    const boundary = createTransactionBoundary([
      [{ databaseOwnerId }],
      [{ sessionId }, { sessionId: secondSessionId }],
      [],
      [],
      [{ sessionId }, { sessionId: unexpectedId }],
      new Error('final delete must remain untouched'),
    ])

    await expect(
      clearOwnerSessionData(boundary.transaction, await resolvedOwner(), {
        deletedAt,
      }),
    ).rejects.toBeInstanceOf(SessionDeletionTransitionError)
    expect(boundary.getRemainingResponseCount()).toBe(1)
  })

  test('rejects a final clear session delete count mismatch', async () => {
    const boundary = createTransactionBoundary([
      [{ databaseOwnerId }],
      [{ sessionId }, { sessionId: secondSessionId }],
      [],
      [],
      [{ sessionId }, { sessionId: secondSessionId }],
      [{ sessionId }],
    ])

    await expect(
      clearOwnerSessionData(boundary.transaction, await resolvedOwner(), {
        deletedAt,
      }),
    ).rejects.toBeInstanceOf(SessionDeletionTransitionError)
  })

  test('rejects a final clear session delete identity mismatch with the same count', async () => {
    const boundary = createTransactionBoundary([
      [{ databaseOwnerId }],
      [{ sessionId }, { sessionId: secondSessionId }],
      [],
      [],
      [{ sessionId }, { sessionId: secondSessionId }],
      [{ sessionId }, { sessionId: unexpectedId }],
    ])

    await expect(
      clearOwnerSessionData(boundary.transaction, await resolvedOwner(), {
        deletedAt,
      }),
    ).rejects.toBeInstanceOf(SessionDeletionTransitionError)
  })

  test('clears every locked session and returns sorted frozen run references', async () => {
    const boundary = createTransactionBoundary([
      [{ databaseOwnerId }],
      [{ sessionId }, { sessionId: secondSessionId }],
      [
        { agentRunId: playerRunId, runtime: 'player' },
        { agentRunId: coachRunId, runtime: 'coach' },
      ],
      [{ agentRunId: coachRunId }, { agentRunId: playerRunId }],
      [{ sessionId: secondSessionId }, { sessionId }],
      [{ sessionId }, { sessionId: secondSessionId }],
    ])

    const result = await clearOwnerSessionData(
      boundary.transaction,
      await resolvedOwner(),
      { deletedAt },
    )

    expect(result).toEqual({
      deletedSessionCount: 2,
      invalidatedRuns: [
        { agentRunId: coachRunId, runtime: 'coach' },
        { agentRunId: playerRunId, runtime: 'player' },
      ],
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.invalidatedRuns)).toBe(true)
    expect(Object.isFrozen(result.invalidatedRuns[0])).toBe(true)
    expect(boundary.getRemainingResponseCount()).toBe(0)
  })
})
