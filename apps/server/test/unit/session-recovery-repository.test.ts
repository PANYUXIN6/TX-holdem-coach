import type { Sql, TransactionSql } from 'postgres'
import { describe, expect, test, vi } from 'vitest'
import { createHandStartedEventDraft } from '../../src/poker/hand-result.js'
import {
  createSessionRecoveryRepository,
  productionSessionRecoveryRepository,
} from '../../src/persistence/session-recovery-repository.js'
import {
  createSessionMutationRepository,
  productionSessionMutationRepository,
} from '../../src/persistence/session-mutation-repository.js'
import {
  ActiveSessionConflictError,
  DatabaseOperationError,
  isRepositoryDomainError,
  RepositoryInputValidationError,
  SessionRecoveryTransitionError,
  SessionMutationTransitionError,
} from '../../src/persistence/errors.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import { encodeCurrentPrivateEvent } from '../../src/sessions/authoritative-state/private-event-codec.js'
import { currentPrivateEventProtocol } from '../../src/sessions/authoritative-state/current-private-event-protocol.js'
import { createPrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'
import { encodeSnapshot } from '../../src/sessions/authoritative-state/snapshot-codec.js'
import { createTestPokerState } from '../poker/create-test-poker-state.js'

const { recoverSessionForMutation, retryReadonlySessionRecovery } =
  productionSessionRecoveryRepository
const sessionId = '22222222-2222-4222-8222-222222222222'
const databaseOwnerId = '11111111-1111-4111-8111-111111111111'
const handId = '44444444-4444-4444-8444-444444444444'
const recoveryAt = '2026-08-04T09:00:00.000Z'
function createTransactionMock(responses: readonly unknown[]) {
  const pending = [...responses]
  let sqlCallCount = 0
  const transaction = ((input: unknown, ...parameters: unknown[]) => {
    if (Array.isArray(input) && !('raw' in input)) {
      return { rows: input, columns: parameters }
    }
    sqlCallCount += 1
    const response = pending.shift()
    return response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(response)
  }) as unknown as TransactionSql
  Object.assign(transaction, {
    json: (value: unknown) => value,
  })
  return { transaction, getSqlCallCount: () => sqlCallCount }
}

async function resolvedOwner() {
  const sql = (() => Promise.resolve([{ databaseOwnerId }])) as unknown as Sql
  return resolveOwnerScope(sql, { ownerId: 'local-user' })
}

function lockedRow(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    sessionId,
    lifecycleStatus: 'active' as const,
    endedAt: null,
    stateVersion: 1,
    nextEventSeq: 1,
    currentHandId: null,
    diagnosticCode: null,
    diagnosedAt: null,
    agentRunState: 'idle' as const,
    activePlayerRunId: null,
    activeDecisionRequestId: null,
    ...overrides,
  }
}

function storedRows() {
  const poker = createTestPokerState()
  const snapshot = encodeSnapshot(
    createPrivateTableState({
      stateVersion: 1,
      poker,
      completedHandCount: 0,
      seatAccounting: poker.seats.map((seat) => ({
        seatNumber: seat.seatNumber,
        cumulativeBuyIn: 2_000,
      })),
      lastCompletedHandSummary: null,
    }),
  )
  const event = encodeCurrentPrivateEvent(
    createHandStartedEventDraft({
      handId,
      handNumber: 1,
      participantSeatNumbers: [0, 1, 2, 3, 4, 5],
      buttonSeatNumber: 0,
      smallBlindSeatNumber: 1,
      bigBlindSeatNumber: 2,
      positions: [
        { seatNumber: 0, position: 'BTN' },
        { seatNumber: 1, position: 'SB' },
        { seatNumber: 2, position: 'BB' },
        { seatNumber: 3, position: 'UTG' },
        { seatNumber: 4, position: 'HJ' },
        { seatNumber: 5, position: 'CO' },
      ],
      startingStacks: [0, 1, 2, 3, 4, 5].map((seatNumber) => ({
        seatNumber,
        stack: 2_000,
      })),
    }),
  )
  return {
    snapshot: [
      {
        rowPayloadVersion: snapshot.payloadVersion,
        payload: snapshot.payload,
      },
    ],
    hands: [],
    events: [
      {
        eventSeq: 0,
        handId,
        stateVersionBefore: 0,
        stateVersionAfter: 1,
        rowPayloadVersion: event.payloadVersion,
        payload: event.payload,
      },
    ],
    state: snapshot.payload.state,
  }
}

describe('session recovery repository', () => {
  test('captures the mutation repository supplied at composition time', async () => {
    const originalError = new Error('original repository')
    const replacementError = new Error('replacement repository')
    const originalLock = vi.fn(async () => {
      throw originalError
    })
    const replacementLock = vi.fn(async () => {
      throw replacementError
    })
    const originalMutationRepository = {
      lockSessionForMutation: originalLock,
    } as never
    const replacementMutationRepository = {
      lockSessionForMutation: replacementLock,
    } as never
    const options = {
      sessionMutationRepository: originalMutationRepository,
    }
    const repository = createSessionRecoveryRepository(options)
    ;(
      options as { sessionMutationRepository: unknown }
    ).sessionMutationRepository = replacementMutationRepository

    await expect(
      repository.recoverSessionForMutation(
        (() => Promise.resolve([])) as unknown as TransactionSql,
        await resolvedOwner(),
        sessionId,
        recoveryAt,
      ),
    ).rejects.toBe(originalError)
    expect(repository.sessionMutationRepository).toBe(
      originalMutationRepository,
    )
    expect(originalLock).toHaveBeenCalledOnce()
    expect(replacementLock).not.toHaveBeenCalled()
  })

  test('returns a capability owned by its injected mutation repository instance', async () => {
    const stored = storedRows()
    const mutationRepository = createSessionMutationRepository({
      currentPrivateEventProtocol,
    })
    const recoveryRepository = createSessionRecoveryRepository({
      sessionMutationRepository: mutationRepository,
    })
    const tracked = createTransactionMock([
      [lockedRow()],
      stored.snapshot,
      stored.hands,
      stored.events,
    ])
    const result = await recoveryRepository.recoverSessionForMutation(
      tracked.transaction,
      await resolvedOwner(),
      sessionId,
      recoveryAt,
    )
    if (result.kind !== 'ready') throw new Error('Expected ready recovery.')

    await expect(
      productionSessionMutationRepository.persistSessionMutation(
        tracked.transaction,
        result.locked,
        {} as never,
      ),
    ).rejects.toBeInstanceOf(SessionMutationTransitionError)
  })

  test('returns a current-transaction mutation capability for a valid active Session', async () => {
    const stored = storedRows()
    const tracked = createTransactionMock([
      [lockedRow()],
      stored.snapshot,
      stored.hands,
      stored.events,
    ])

    const result = await recoverSessionForMutation(
      tracked.transaction,
      await resolvedOwner(),
      sessionId,
      recoveryAt,
    )

    expect(result).toMatchObject({
      kind: 'ready',
      lifecycleStatus: 'active',
      state: stored.state,
      pointerRepair: null,
      locked: { sessionId },
    })
    expect(tracked.getSqlCallCount()).toBe(4)
  })

  test('rejects every call input before the first SQL statement', async () => {
    const tracked = createTransactionMock([])

    await expect(
      recoverSessionForMutation(
        tracked.transaction,
        await resolvedOwner(),
        sessionId,
        '2026-08-04T09:00:00Z',
      ),
    ).rejects.toBeInstanceOf(RepositoryInputValidationError)
    expect(tracked.getSqlCallCount()).toBe(0)
  })

  test('short-circuits an existing diagnostic without scanning or refreshing it', async () => {
    const diagnosedAt = '2026-08-03T08:00:00.000000Z'
    const tracked = createTransactionMock([
      [
        lockedRow({
          lifecycleStatus: 'readonlyDiagnostic',
          diagnosticCode: 'snapshotMissing',
          diagnosedAt,
        }),
      ],
    ])

    await expect(
      recoverSessionForMutation(
        tracked.transaction,
        await resolvedOwner(),
        sessionId,
        recoveryAt,
      ),
    ).resolves.toEqual({
      kind: 'readonlyDiagnostic',
      code: 'snapshotMissing',
      diagnosedAt,
    })
    expect(tracked.getSqlCallCount()).toBe(1)
  })

  test('repairs the current-hand mirror defensively and returns the relocked capability', async () => {
    const stored = storedRows()
    const staleHandId = '44444444-4444-4444-8444-444444444445'
    const tracked = createTransactionMock([
      [lockedRow({ currentHandId: staleHandId })],
      stored.snapshot,
      stored.hands,
      stored.events,
      [{ sessionId }],
      [lockedRow()],
    ])

    await expect(
      recoverSessionForMutation(
        tracked.transaction,
        await resolvedOwner(),
        sessionId,
        recoveryAt,
      ),
    ).resolves.toMatchObject({
      kind: 'ready',
      locked: { currentHandId: null },
      pointerRepair: { from: staleHandId, to: null },
    })
    expect(tracked.getSqlCallCount()).toBe(6)
  })

  test('converts a zero-row defensive repair into a recovery transition error', async () => {
    const stored = storedRows()
    const tracked = createTransactionMock([
      [
        lockedRow({
          currentHandId: '44444444-4444-4444-8444-444444444445',
        }),
      ],
      stored.snapshot,
      stored.hands,
      stored.events,
      [],
    ])

    await expect(
      recoverSessionForMutation(
        tracked.transaction,
        await resolvedOwner(),
        sessionId,
        recoveryAt,
      ),
    ).rejects.toBeInstanceOf(SessionRecoveryTransitionError)
    expect(tracked.getSqlCallCount()).toBe(5)
  })

  test('writes the first diagnostic in the locked transaction and preserves its input time', async () => {
    const stored = storedRows()
    const tracked = createTransactionMock([
      [lockedRow()],
      [],
      stored.hands,
      stored.events,
      [{ sessionId }],
    ])

    await expect(
      recoverSessionForMutation(
        tracked.transaction,
        await resolvedOwner(),
        sessionId,
        recoveryAt,
      ),
    ).resolves.toEqual({
      kind: 'readonlyDiagnostic',
      code: 'snapshotMissing',
      diagnosedAt: recoveryAt,
    })
    expect(tracked.getSqlCallCount()).toBe(5)
  })

  test('stops immediately after a recovery-read database error', async () => {
    const tracked = createTransactionMock([
      [lockedRow()],
      new Error('snapshot query failed'),
    ])

    await expect(
      recoverSessionForMutation(
        tracked.transaction,
        await resolvedOwner(),
        sessionId,
        recoveryAt,
      ),
    ).rejects.toBeInstanceOf(DatabaseOperationError)
    expect(tracked.getSqlCallCount()).toBe(2)
  })

  test('preserves a concrete diagnostic code and first time on failed retry', async () => {
    const stored = storedRows()
    const diagnosedAt = '2026-08-02T08:00:00.000000Z'
    const tracked = createTransactionMock([
      [
        lockedRow({
          lifecycleStatus: 'readonlyDiagnostic',
          diagnosticCode: 'eventVersionUnknown',
          diagnosedAt,
        }),
      ],
      [],
      stored.hands,
      stored.events,
    ])

    await expect(
      retryReadonlySessionRecovery(
        tracked.transaction,
        await resolvedOwner(),
        sessionId,
        recoveryAt,
      ),
    ).resolves.toEqual({
      kind: 'readonlyDiagnostic',
      code: 'eventVersionUnknown',
      diagnosedAt,
    })
    expect(tracked.getSqlCallCount()).toBe(4)
  })

  test('clears diagnostics, restores active lifecycle and returns a new lock on successful retry', async () => {
    const stored = storedRows()
    const diagnosedAt = '2026-08-02T08:00:00.000000Z'
    const tracked = createTransactionMock([
      [
        lockedRow({
          lifecycleStatus: 'readonlyDiagnostic',
          diagnosticCode: 'snapshotMissing',
          diagnosedAt,
        }),
      ],
      stored.snapshot,
      stored.hands,
      stored.events,
      [{ sessionId }],
      [lockedRow()],
    ])

    await expect(
      retryReadonlySessionRecovery(
        tracked.transaction,
        await resolvedOwner(),
        sessionId,
        recoveryAt,
      ),
    ).resolves.toMatchObject({
      kind: 'ready',
      lifecycleStatus: 'active',
      locked: { diagnosticCode: null, diagnosedAt: null },
    })
    expect(tracked.getSqlCallCount()).toBe(6)
  })

  test('restores ended lifecycle on successful retry without exposing a mutation capability', async () => {
    const stored = storedRows()
    const diagnosedAt = '2026-08-02T08:00:00.000000Z'
    const endedAt = '2026-08-03T08:00:00.000000Z'
    const tracked = createTransactionMock([
      [
        lockedRow({
          lifecycleStatus: 'readonlyDiagnostic',
          endedAt,
          diagnosticCode: 'snapshotMissing',
          diagnosedAt,
        }),
      ],
      stored.snapshot,
      stored.hands,
      stored.events,
      [{ sessionId }],
      [
        lockedRow({
          lifecycleStatus: 'ended',
          endedAt,
        }),
      ],
    ])

    const result = await retryReadonlySessionRecovery(
      tracked.transaction,
      await resolvedOwner(),
      sessionId,
      recoveryAt,
    )

    expect(result).toMatchObject({
      kind: 'ended',
      state: stored.state,
      pointerRepair: null,
      session: {
        sessionId,
        lifecycleStatus: 'ended',
        stateVersion: 1,
        nextEventSeq: 1,
      },
    })
    expect('locked' in result).toBe(false)
    expect(tracked.getSqlCallCount()).toBe(6)
  })

  test('maps only the active-session constraint before generic database errors', async () => {
    const stored = storedRows()
    const diagnosedAt = '2026-08-02T08:00:00.000000Z'
    const conflict = Object.assign(new Error('unique violation'), {
      constraint_name: 'sessions_one_active_per_owner',
    })
    const tracked = createTransactionMock([
      [
        lockedRow({
          lifecycleStatus: 'readonlyDiagnostic',
          diagnosticCode: 'snapshotMissing',
          diagnosedAt,
        }),
      ],
      stored.snapshot,
      stored.hands,
      stored.events,
      conflict,
    ])

    await expect(
      retryReadonlySessionRecovery(
        tracked.transaction,
        await resolvedOwner(),
        sessionId,
        recoveryAt,
      ),
    ).rejects.toBeInstanceOf(ActiveSessionConflictError)
    expect(tracked.getSqlCallCount()).toBe(5)
  })

  test('returns ended state without exposing a mutation capability', async () => {
    const stored = storedRows()
    const tracked = createTransactionMock([
      [
        lockedRow({
          lifecycleStatus: 'ended',
          endedAt: '2026-08-03T08:00:00.000000Z',
        }),
      ],
      stored.snapshot,
      stored.hands,
      stored.events,
    ])

    const result = await recoverSessionForMutation(
      tracked.transaction,
      await resolvedOwner(),
      sessionId,
      recoveryAt,
    )

    expect(result.kind).toBe('ended')
    expect('locked' in result).toBe(false)
  })

  test('treats retrying a non-diagnostic Session as a domain transition error', async () => {
    const tracked = createTransactionMock([[lockedRow()]])

    await expect(
      retryReadonlySessionRecovery(
        tracked.transaction,
        await resolvedOwner(),
        sessionId,
        recoveryAt,
      ),
    ).rejects.toBeInstanceOf(SessionRecoveryTransitionError)
    expect(isRepositoryDomainError(new SessionRecoveryTransitionError())).toBe(
      true,
    )
  })
})
