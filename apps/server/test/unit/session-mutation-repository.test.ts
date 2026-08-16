import type { Sql, TransactionSql } from 'postgres'
import { describe, expect, test, vi } from 'vitest'
import { createHandStartedEventDraft } from '../../src/poker/hand-result.js'
import {
  createSessionMutationRepository,
  lockSessionForMutation,
  persistSessionMutation,
  validateSessionMutation,
  type SessionMutationEventInput,
} from '../../src/persistence/session-mutation-repository.js'
import {
  DatabaseOperationError,
  RepositoryInputValidationError,
  ResourceNotFoundError,
  SessionMutationTransitionError,
} from '../../src/persistence/errors.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import { encodeCurrentPrivateEvent } from '../../src/sessions/authoritative-state/private-event-codec.js'
import { currentPrivateEventProtocol } from '../../src/sessions/authoritative-state/current-private-event-protocol.js'
import { createPrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'
import { encodeSnapshot } from '../../src/sessions/authoritative-state/snapshot-codec.js'
import { createTestPokerState } from '../poker/create-test-poker-state.js'

const sessionId = '22222222-2222-4222-8222-222222222222'
const databaseOwnerId = '11111111-1111-4111-8111-111111111111'
const eventId = '33333333-3333-4333-8333-333333333333'
const secondEventId = '33333333-3333-4333-8333-333333333334'
const handId = '44444444-4444-4444-8444-444444444444'
const otherHandId = '44444444-4444-4444-8444-444444444445'
const firstLedgerId = '55555555-5555-4555-8555-555555555555'
const secondLedgerId = '55555555-5555-4555-8555-555555555556'
const playerRunId = '77777777-7777-4777-8777-777777777777'
const decisionRequestId = '88888888-8888-4888-8888-888888888888'
const otherDecisionRequestId = '88888888-8888-4888-8888-888888888889'
const mutationAt = '2026-08-03T09:00:00.000Z'

function createTransactionMock(responses: readonly unknown[]): TransactionSql {
  const pending = [...responses]
  const transaction = ((input: unknown, ...parameters: unknown[]) => {
    if (Array.isArray(input) && !('raw' in input)) {
      return { rows: input, columns: parameters }
    }
    const response = pending.shift()
    return response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(response)
  }) as unknown as TransactionSql
  Object.assign(transaction, {
    json: (value: unknown) => value,
    typed: (value: string) => JSON.parse(value) as unknown,
  })
  return transaction
}

function createTrackedTransaction(responses: readonly unknown[]) {
  const pending = [...responses]
  let sqlCallCount = 0
  const sqlParameters: unknown[][] = []
  const transaction = ((input: unknown, ...parameters: unknown[]) => {
    if (Array.isArray(input) && !('raw' in input)) {
      return { rows: input, columns: parameters }
    }
    sqlCallCount += 1
    sqlParameters.push(parameters)
    const response = pending.shift()
    return response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(response)
  }) as unknown as TransactionSql
  Object.assign(transaction, {
    json: (value: unknown) => value,
    typed: (value: string) => JSON.parse(value) as unknown,
  })
  return {
    transaction,
    getSqlCallCount: () => sqlCallCount,
    getSqlParameters: () => sqlParameters,
  }
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
    stateVersion: 7,
    nextEventSeq: 20,
    currentHandId: null,
    diagnosticCode: null,
    diagnosedAt: null,
    agentRunState: 'idle' as const,
    activePlayerRunId: null,
    activeDecisionRequestId: null,
    ...overrides,
  }
}

function publicSnapshot(
  stateVersion = 8,
  eventSeq = 20,
  overrides: Readonly<
    Partial<{
      sessionId: string
      lifecycleStatus: 'active' | 'ended' | 'readonlyDiagnostic'
      agentRunState: 'idle' | 'thinking' | 'paused'
      activeDecision: {
        decisionRequestId: string
        actorSeatNumber: number
      } | null
    }>
  > = {},
) {
  return {
    sessionId,
    stateVersion,
    eventSeq,
    pokerPhase: 'betweenHands' as const,
    lifecycleStatus: 'active' as const,
    agentRunState: 'idle' as const,
    activeDecision: null,
    seats: Array.from({ length: 6 }, (_, seatNumber) => ({
      seatNumber,
      playerId: `66666666-6666-4666-8666-${seatNumber.toString().padStart(12, '0')}`,
      displayName: seatNumber === 0 ? '玩家' : `AI ${seatNumber}`,
      avatarColor: '#0f766e',
      isUser: seatNumber === 0,
      stack: 2_000,
      status: 'active' as const,
    })),
    hand: null,
    lastCompletedHandSummary: null,
    ...overrides,
  }
}

function validBatch() {
  const poker = createTestPokerState()
  const privateState = createPrivateTableState({
    stateVersion: 8,
    poker,
    completedHandCount: 0,
    seatAccounting: poker.seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      cumulativeBuyIn: 2_000,
    })),
    lastCompletedHandSummary: null,
  })
  const privateEvent = encodeCurrentPrivateEvent(
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
  const snapshot = publicSnapshot()
  const publicEvent = {
    eventId,
    sessionId,
    eventSeq: 20,
    stateVersion: 8,
    type: 'handStarted' as const,
    payload: { snapshot },
  }
  return {
    finalStateVersion: 8,
    lifecycleStatus: 'active' as const,
    currentHandId: null,
    agentRunState: 'idle' as const,
    activePlayerRunId: null,
    activeDecisionRequestId: null,
    snapshot: encodeSnapshot(privateState),
    events: [
      {
        eventId,
        eventSeq: 20,
        handId,
        commandLedgerId: null,
        stateVersionBefore: 7,
        stateVersionAfter: 8,
        privateEvent,
        publicEvent,
        createdAt: mutationAt,
      },
    ] as const,
    mutationAt,
  }
}

function validTwoEventBatch() {
  const batch = validBatch()
  const firstEvent = batch.events[0]!
  return {
    ...batch,
    events: [
      firstEvent,
      {
        ...firstEvent,
        eventId: secondEventId,
        eventSeq: 21,
        publicEvent: {
          ...firstEvent.publicEvent,
          eventId: secondEventId,
          eventSeq: 21,
          payload: { snapshot: publicSnapshot(8, 21) },
        },
      },
    ] as const,
  }
}

function validNoSnapshotEndedBatch() {
  const batch = validBatch()
  const event = batch.events[0]!
  return {
    ...batch,
    finalStateVersion: 7,
    lifecycleStatus: 'ended' as const,
    snapshot: null,
    events: [
      {
        ...event,
        stateVersionAfter: 7,
        publicEvent: {
          ...event.publicEvent,
          stateVersion: 7,
          payload: {
            snapshot: publicSnapshot(7, 20, {
              lifecycleStatus: 'ended',
            }),
          },
        },
      },
    ] as const,
  }
}

describe('session mutation repository', () => {
  test('captures the current event protocol supplied at composition time', async () => {
    const originalDecode = vi.fn(
      currentPrivateEventProtocol.decodeStoredCurrent,
    )
    const replacementDecode = vi.fn(
      currentPrivateEventProtocol.decodeStoredCurrent,
    )
    const originalProtocol = {
      ...currentPrivateEventProtocol,
      decodeStoredCurrent: originalDecode,
    }
    const replacementProtocol = {
      ...currentPrivateEventProtocol,
      decodeStoredCurrent: replacementDecode,
    }
    const options = { currentPrivateEventProtocol: originalProtocol }
    const repository = createSessionMutationRepository(options)
    ;(
      options as { currentPrivateEventProtocol: typeof replacementProtocol }
    ).currentPrivateEventProtocol = replacementProtocol
    const transaction = createTransactionMock([[lockedRow()]])
    const locked = await repository.lockSessionForMutation(
      transaction,
      await resolvedOwner(),
      sessionId,
    )

    expect(() =>
      repository.validateSessionMutation(transaction, locked, validBatch()),
    ).not.toThrow()
    expect(repository.currentPrivateEventProtocol).toBe(originalProtocol)
    expect(originalDecode).toHaveBeenCalledOnce()
    expect(replacementDecode).not.toHaveBeenCalled()
  })

  test('rejects a lock capability created by another repository instance', async () => {
    const first = createSessionMutationRepository({
      currentPrivateEventProtocol,
    })
    const second = createSessionMutationRepository({
      currentPrivateEventProtocol,
    })
    const transaction = createTransactionMock([[lockedRow()]])
    const locked = await first.lockSessionForMutation(
      transaction,
      await resolvedOwner(),
      sessionId,
    )

    await expect(
      second.persistSessionMutation(transaction, locked, validBatch()),
    ).rejects.toBeInstanceOf(SessionMutationTransitionError)
  })

  test('locks one owner-scoped session and returns a frozen transaction capability', async () => {
    const transaction = createTransactionMock([[lockedRow()]])

    const locked = await lockSessionForMutation(
      transaction,
      await resolvedOwner(),
      sessionId,
    )

    expect(locked).toEqual({
      sessionId,
      lifecycleStatus: 'active',
      endedAt: null,
      stateVersion: 7,
      nextEventSeq: 20,
      currentHandId: null,
      diagnosticCode: null,
      diagnosedAt: null,
      agentRunState: 'idle',
      activePlayerRunId: null,
      activeDecisionRequestId: null,
    })
    expect(Object.isFrozen(locked)).toBe(true)
  })

  test('persists one snapshot event and returns the uncommitted event range', async () => {
    const transaction = createTransactionMock([
      [lockedRow()],
      [{ sessionId }],
      [{ sessionId }],
      [{ eventId }],
    ])
    const locked = await lockSessionForMutation(
      transaction,
      await resolvedOwner(),
      sessionId,
    )

    const persisted = await persistSessionMutation(
      transaction,
      locked,
      validBatch(),
    )

    expect(persisted).toEqual({
      sessionId,
      finalStateVersion: 8,
      nextEventSeq: 21,
      firstEventSeq: 20,
      lastEventSeq: 20,
      events: [validBatch().events[0]?.publicEvent],
    })
    expect(Object.isFrozen(persisted)).toBe(true)
    expect(Object.isFrozen(persisted.events)).toBe(true)
  })

  test('validates a complete batch without SQL or consuming the lock capability', async () => {
    const tracked = createTrackedTransaction([
      [lockedRow()],
      [{ sessionId }],
      [{ sessionId }],
      [{ eventId }],
    ])
    const locked = await lockSessionForMutation(
      tracked.transaction,
      await resolvedOwner(),
      sessionId,
    )
    const batch = validBatch()
    const event = batch.events[0]!
    const invalidBatch = {
      ...batch,
      events: [
        {
          ...event,
          publicEvent: {
            ...event.publicEvent,
            payload: {
              snapshot: publicSnapshot(8, 20, {
                sessionId: otherHandId,
              }),
            },
          },
        },
      ],
    }

    expect(() =>
      validateSessionMutation(tracked.transaction, locked, invalidBatch),
    ).toThrow(RepositoryInputValidationError)
    expect(tracked.getSqlCallCount()).toBe(1)
    expect(() =>
      validateSessionMutation(tracked.transaction, locked, batch),
    ).not.toThrow()
    expect(tracked.getSqlCallCount()).toBe(1)
    await expect(
      persistSessionMutation(tracked.transaction, locked, batch),
    ).resolves.toMatchObject({ finalStateVersion: 8 })
  })

  test('rejects split final versions before writing and leaves the lock capability available', async () => {
    const tracked = createTrackedTransaction([
      [lockedRow()],
      [{ sessionId }],
      [{ sessionId }],
      [{ eventId }],
    ])
    const locked = await lockSessionForMutation(
      tracked.transaction,
      await resolvedOwner(),
      sessionId,
    )
    const batch = validBatch()
    const event = batch.events[0]!
    const invalidBatch = {
      ...batch,
      events: [
        {
          ...event,
          stateVersionAfter: 7,
          publicEvent: {
            ...event.publicEvent,
            stateVersion: 7,
            payload: { snapshot: publicSnapshot(7, 20) },
          },
        },
      ],
    }

    await expect(
      persistSessionMutation(tracked.transaction, locked, invalidBatch),
    ).rejects.toBeInstanceOf(RepositoryInputValidationError)
    expect(tracked.getSqlCallCount()).toBe(1)

    await expect(
      persistSessionMutation(tracked.transaction, locked, batch),
    ).resolves.toMatchObject({ finalStateVersion: 8, nextEventSeq: 21 })
    expect(tracked.getSqlCallCount()).toBe(4)
  })

  test('enforces multi-event ordering, identity, relation and canonical public-state mirrors', async () => {
    const validTransaction = createTransactionMock([
      [lockedRow()],
      [{ sessionId }],
      [{ sessionId }],
      [{ eventId }, { eventId: secondEventId }],
    ])
    const validLocked = await lockSessionForMutation(
      validTransaction,
      await resolvedOwner(),
      sessionId,
    )
    await expect(
      persistSessionMutation(
        validTransaction,
        validLocked,
        validTwoEventBatch(),
      ),
    ).resolves.toMatchObject({
      nextEventSeq: 22,
      firstEventSeq: 20,
      lastEventSeq: 21,
    })

    const base = validTwoEventBatch()
    const [first, second] = base.events
    const differentSnapshot = {
      ...second.publicEvent.payload.snapshot,
      seats: second.publicEvent.payload.snapshot.seats.map((seat) =>
        seat.seatNumber === 5 ? { ...seat, stack: 1_999 } : seat,
      ),
    }
    const invalidEventLists: readonly (readonly SessionMutationEventInput[])[] =
      [
        [second, first],
        [
          first,
          {
            ...second,
            eventId,
            publicEvent: { ...second.publicEvent, eventId },
          },
        ],
        [
          { ...first, commandLedgerId: firstLedgerId },
          { ...second, commandLedgerId: secondLedgerId },
        ],
        [
          first,
          {
            ...second,
            publicEvent: {
              ...second.publicEvent,
              payload: { snapshot: differentSnapshot },
            },
          },
        ],
        [{ ...first, eventId: secondLedgerId }, second],
        [
          first,
          {
            ...second,
            publicEvent: { ...second.publicEvent, type: 'actionCommitted' },
          },
        ],
        [first, { ...second, handId: otherHandId }],
      ]

    for (const events of invalidEventLists) {
      const tracked = createTrackedTransaction([[lockedRow()]])
      const locked = await lockSessionForMutation(
        tracked.transaction,
        await resolvedOwner(),
        sessionId,
      )
      await expect(
        persistSessionMutation(tracked.transaction, locked, {
          ...base,
          events,
        }),
      ).rejects.toBeInstanceOf(RepositoryInputValidationError)
      expect(tracked.getSqlCallCount()).toBe(1)
    }
  })

  test('persists the no-snapshot same-version ended branch and requires ended player coordination to be idle', async () => {
    const validTransaction = createTransactionMock([
      [lockedRow()],
      [{ sessionId }],
      [{ eventId }],
    ])
    const validLocked = await lockSessionForMutation(
      validTransaction,
      await resolvedOwner(),
      sessionId,
    )
    await expect(
      persistSessionMutation(
        validTransaction,
        validLocked,
        validNoSnapshotEndedBatch(),
      ),
    ).resolves.toMatchObject({ finalStateVersion: 7, nextEventSeq: 21 })

    const tracked = createTrackedTransaction([[lockedRow()]])
    const locked = await lockSessionForMutation(
      tracked.transaction,
      await resolvedOwner(),
      sessionId,
    )
    await expect(
      persistSessionMutation(tracked.transaction, locked, {
        ...validNoSnapshotEndedBatch(),
        agentRunState: 'paused',
      }),
    ).rejects.toBeInstanceOf(RepositoryInputValidationError)
    expect(tracked.getSqlCallCount()).toBe(1)
  })

  test('rejects public snapshots that disagree with the final session identity or coordination state', async () => {
    const otherSessionId = '22222222-2222-4222-8222-222222222223'
    const base = validBatch()
    const event = base.events[0]!
    const ended = validNoSnapshotEndedBatch()
    const endedEvent = ended.events[0]!
    const invalidBatches = [
      {
        ...base,
        events: [
          {
            ...event,
            publicEvent: {
              ...event.publicEvent,
              payload: {
                snapshot: publicSnapshot(8, 20, {
                  sessionId: otherSessionId,
                }),
              },
            },
          },
        ],
      },
      {
        ...ended,
        events: [
          {
            ...endedEvent,
            publicEvent: {
              ...endedEvent.publicEvent,
              payload: { snapshot: publicSnapshot(7, 20) },
            },
          },
        ],
      },
      {
        ...base,
        agentRunState: 'paused' as const,
      },
      {
        ...base,
        agentRunState: 'thinking' as const,
        activePlayerRunId: playerRunId,
        activeDecisionRequestId: decisionRequestId,
        events: [
          {
            ...event,
            publicEvent: {
              ...event.publicEvent,
              payload: {
                snapshot: publicSnapshot(8, 20, {
                  agentRunState: 'thinking',
                  activeDecision: {
                    decisionRequestId: otherDecisionRequestId,
                    actorSeatNumber: 1,
                  },
                }),
              },
            },
          },
        ],
      },
    ]

    for (const batch of invalidBatches) {
      const tracked = createTrackedTransaction([[lockedRow()]])
      const locked = await lockSessionForMutation(
        tracked.transaction,
        await resolvedOwner(),
        sessionId,
      )

      await expect(
        persistSessionMutation(tracked.transaction, locked, batch),
      ).rejects.toBeInstanceOf(RepositoryInputValidationError)
      expect(tracked.getSqlCallCount()).toBe(1)
    }
  })

  test('accepts a canonical UUID returned by PostgreSQL for uppercase event input', async () => {
    const lowercaseEventId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const uppercaseEventId = lowercaseEventId.toUpperCase()
    const batch = validBatch()
    const event = batch.events[0]!
    const transaction = createTransactionMock([
      [lockedRow()],
      [{ sessionId }],
      [{ sessionId }],
      [{ eventId: lowercaseEventId }],
    ])
    const locked = await lockSessionForMutation(
      transaction,
      await resolvedOwner(),
      sessionId,
    )

    await expect(
      persistSessionMutation(transaction, locked, {
        ...batch,
        events: [
          {
            ...event,
            eventId: uppercaseEventId,
            publicEvent: {
              ...event.publicEvent,
              eventId: uppercaseEventId,
            },
          },
        ],
      }),
    ).resolves.toMatchObject({ firstEventSeq: 20, lastEventSeq: 20 })
  })

  test('passes event payloads to the postgres bulk helper as JSON objects', async () => {
    const tracked = createTrackedTransaction([
      [lockedRow()],
      [{ sessionId }],
      [{ sessionId }],
      [{ eventId }],
    ])
    const locked = await lockSessionForMutation(
      tracked.transaction,
      await resolvedOwner(),
      sessionId,
    )

    await persistSessionMutation(tracked.transaction, locked, validBatch())

    const eventRows = tracked.getSqlParameters().flat().find(Array.isArray) as
      readonly unknown[] | undefined
    const eventRow = eventRows?.[0] as
      | {
          readonly private_event_payload: unknown
          readonly public_event_payload: unknown
        }
      | undefined
    expect(eventRow?.private_event_payload).toEqual(
      validBatch().events[0]?.privateEvent.payload,
    )
    expect(eventRow?.public_event_payload).toEqual(
      validBatch().events[0]?.publicEvent,
    )
    expect(tracked.getSqlParameters().flat()).toContainEqual(
      validBatch().snapshot.payload,
    )
  })

  test('converts each SQL-stage failure, stops immediately and consumes the lock capability', async () => {
    const stageResponses = [
      [new Error('session update failed')],
      [[{ sessionId }], new Error('snapshot upsert failed')],
      [[{ sessionId }], [{ sessionId }], new Error('event insert failed')],
    ]

    for (const responses of stageResponses) {
      const tracked = createTrackedTransaction([[lockedRow()], ...responses])
      const locked = await lockSessionForMutation(
        tracked.transaction,
        await resolvedOwner(),
        sessionId,
      )

      await expect(
        persistSessionMutation(tracked.transaction, locked, validBatch()),
      ).rejects.toBeInstanceOf(DatabaseOperationError)
      const callsAfterFailure = tracked.getSqlCallCount()
      expect(callsAfterFailure).toBe(responses.length + 1)

      await expect(
        persistSessionMutation(tracked.transaction, locked, validBatch()),
      ).rejects.toBeInstanceOf(SessionMutationTransitionError)
      expect(tracked.getSqlCallCount()).toBe(callsAfterFailure)
    }
  })

  test('rejects forged and cross-transaction lock capabilities', async () => {
    const transaction = createTransactionMock([[lockedRow()]])
    const locked = await lockSessionForMutation(
      transaction,
      await resolvedOwner(),
      sessionId,
    )

    await expect(
      persistSessionMutation(
        transaction,
        { ...locked } as typeof locked,
        validBatch(),
      ),
    ).rejects.toBeInstanceOf(RepositoryInputValidationError)
    await expect(
      persistSessionMutation(createTransactionMock([]), locked, validBatch()),
    ).rejects.toBeInstanceOf(SessionMutationTransitionError)
  })

  test('rejects mutation of ended and readonly-diagnostic locked sessions', async () => {
    for (const row of [
      lockedRow({
        lifecycleStatus: 'ended',
        endedAt: '2026-08-03T08:00:00.000000Z',
      }),
      lockedRow({
        lifecycleStatus: 'readonlyDiagnostic',
        diagnosticCode: 'snapshotMissing',
        diagnosedAt: '2026-08-03T08:00:00.000000Z',
      }),
    ]) {
      const tracked = createTrackedTransaction([[row]])
      const locked = await lockSessionForMutation(
        tracked.transaction,
        await resolvedOwner(),
        sessionId,
      )

      await expect(
        persistSessionMutation(tracked.transaction, locked, validBatch()),
      ).rejects.toBeInstanceOf(SessionMutationTransitionError)
      expect(tracked.getSqlCallCount()).toBe(1)
    }
  })

  test('rejects state-version and event-sequence overflow before writing', async () => {
    const maximum = Number.MAX_SAFE_INTEGER
    const base = validBatch()
    const maximumStateSnapshot = encodeSnapshot({
      ...base.snapshot.payload.state,
      stateVersion: maximum,
    })
    const event = base.events[0]!
    const versionOverflowBatch = {
      ...base,
      finalStateVersion: maximum,
      snapshot: maximumStateSnapshot,
      events: [
        {
          ...event,
          stateVersionBefore: maximum,
          stateVersionAfter: maximum,
          publicEvent: {
            ...event.publicEvent,
            stateVersion: maximum,
            payload: { snapshot: publicSnapshot(maximum, 20) },
          },
        },
      ],
    }
    const sequenceBase = validNoSnapshotEndedBatch()
    const sequenceEvent = sequenceBase.events[0]!
    const sequenceOverflowBatch = {
      ...sequenceBase,
      events: [
        {
          ...sequenceEvent,
          eventSeq: maximum,
          publicEvent: {
            ...sequenceEvent.publicEvent,
            eventSeq: maximum,
            payload: { snapshot: publicSnapshot(7, maximum) },
          },
        },
      ],
    }

    for (const [row, batch] of [
      [lockedRow({ stateVersion: maximum }), versionOverflowBatch],
      [lockedRow({ nextEventSeq: maximum }), sequenceOverflowBatch],
    ] as const) {
      const tracked = createTrackedTransaction([[row]])
      const locked = await lockSessionForMutation(
        tracked.transaction,
        await resolvedOwner(),
        sessionId,
      )
      await expect(
        persistSessionMutation(tracked.transaction, locked, batch),
      ).rejects.toBeInstanceOf(RepositoryInputValidationError)
      expect(tracked.getSqlCallCount()).toBe(1)
    }
  })

  test('desensitizes lock database errors and owner-scoped absence', async () => {
    await expect(
      lockSessionForMutation(
        createTransactionMock([new Error('driver details')]),
        await resolvedOwner(),
        sessionId,
      ),
    ).rejects.toBeInstanceOf(DatabaseOperationError)
    await expect(
      lockSessionForMutation(
        createTransactionMock([[]]),
        await resolvedOwner(),
        sessionId,
      ),
    ).rejects.toBeInstanceOf(ResourceNotFoundError)
  })

  test('rejects a locked active row whose lifecycle or player-run mirrors are corrupt', async () => {
    for (const corruptRow of [
      {
        endedAt: '2026-08-03T09:00:00.000000Z',
        agentRunState: 'idle',
        activePlayerRunId: null,
        activeDecisionRequestId: null,
      },
      {
        endedAt: null,
        agentRunState: 'thinking',
        activePlayerRunId: null,
        activeDecisionRequestId: null,
      },
      {
        endedAt: null,
        agentRunState: 'idle',
        activePlayerRunId: null,
        activeDecisionRequestId: null,
        diagnosticCode: 'snapshotMissing',
        diagnosedAt: '2026-08-03T09:00:00.000000Z',
      },
    ] as const) {
      const transaction = createTransactionMock([
        [
          {
            sessionId,
            lifecycleStatus: 'active',
            stateVersion: 7,
            nextEventSeq: 20,
            currentHandId: null,
            diagnosticCode: null,
            diagnosedAt: null,
            ...corruptRow,
          },
        ],
      ])

      await expect(
        lockSessionForMutation(transaction, await resolvedOwner(), sessionId),
      ).rejects.toMatchObject(
        expect.objectContaining({
          name: 'PersistenceDataCorruptionError',
          corruption: 'invalidSessionMutationState',
        }),
      )
    }
  })
})
