import type { Sql, TransactionSql } from 'postgres'
import { describe, expect, test, vi } from 'vitest'
import {
  createSessionCommandHandlerMap,
  SessionCommandCompositionError,
} from '../../src/sessions/command-execution/command-handler-map.js'
import {
  createSessionCommandExecutor,
  SessionCommandInvariantError,
} from '../../src/sessions/command-execution/session-command-executor.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import { ResourceNotFoundError } from '../../src/persistence/errors.js'
import { createPrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'
import { createTestPokerState } from '../poker/create-test-poker-state.js'
import { productionSnapshotVersionRegistry } from '../../src/sessions/authoritative-state/snapshot-version-registry.js'
import { productionPrivateEventVersionRegistry } from '../../src/sessions/authoritative-state/private-event-version-registry.js'
import { currentPrivateEventProtocol } from '../../src/sessions/authoritative-state/current-private-event-protocol.js'
import type { PrepareCommandResult } from '../../src/sessions/command-execution/command-handler.js'
import { createGuardedPort } from '../../src/sessions/command-execution/command-handler.js'
import type { SessionMutationBatch } from '../../src/persistence/session-mutation-repository.js'
import type { SnapshotProjectionInput } from '../../src/sessions/command-execution/snapshot-projector.js'

function testBinding(commandType: 'endSession' = 'endSession') {
  return {
    commandType,
    handler: {
      prepare: async () => ({
        kind: 'rejected' as const,
        rejection: {
          kind: 'commandNotAllowedInPhase' as const,
          phase: 'betweenHands' as const,
        },
      }),
      applyRelations: async () => {},
    },
    bindReadPort: () => Object.freeze({}),
    bindWritePort: () => Object.freeze({}),
  }
}

async function createExecutionFixture(input: {
  commandType: 'rebuy' | 'endSession'
  state: ReturnType<typeof createPrivateTableState>
  preparedResult: PrepareCommandResult
  lifecycleAfter: 'active' | 'ended'
  logPointerRepair?: (repair: unknown) => void
}) {
  const sessionId = '22222222-2222-4222-8222-222222222222'
  const commandId = '33333333-3333-4333-8333-333333333333'
  const ledgerId = '44444444-4444-4444-8444-444444444444'
  const eventId = '55555555-5555-4555-8555-555555555555'
  const transaction = (() => Promise.resolve([])) as unknown as TransactionSql
  const sql = Object.assign((() => Promise.resolve([])) as unknown as Sql, {
    begin: vi.fn(async (callback: (tx: TransactionSql) => unknown) =>
      callback(transaction),
    ),
  })
  const owner = await resolveOwnerScope(
    (() =>
      Promise.resolve([
        { databaseOwnerId: '11111111-1111-4111-8111-111111111111' },
      ])) as unknown as Sql,
    { ownerId: 'local-user' },
  )
  const locked = {
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
  } as never
  const applyRelations = vi.fn(
    async (_context: unknown, _capability: unknown) => {},
  )
  const binding = {
    commandType: input.commandType,
    handler: {
      prepare: vi.fn(async (_context: unknown) => input.preparedResult),
      applyRelations,
    },
    bindReadPort: vi.fn(() => Object.freeze({ read: () => 'ok' })),
    bindWritePort: vi.fn(() => Object.freeze({ write: () => 'ok' })),
  }
  const persistSessionMutation = vi.fn(
    async (
      _tx: TransactionSql,
      _locked: unknown,
      batch: SessionMutationBatch,
    ) => ({
      sessionId,
      finalStateVersion: batch.finalStateVersion,
      nextEventSeq: 20 + batch.events.length,
      firstEventSeq: 20,
      lastEventSeq: 19 + batch.events.length,
      events: batch.events.map((event) => event.publicEvent),
    }),
  )
  const validateSessionMutation = vi.fn(
    (_tx: TransactionSql, _locked: unknown, batch: SessionMutationBatch) => {
      if (
        batch.events.some(
          (event) =>
            event.publicEvent.sessionId.toLowerCase() !== sessionId ||
            event.publicEvent.payload.snapshot.sessionId.toLowerCase() !==
              sessionId,
        )
      ) {
        throw new SessionCommandInvariantError()
      }
    },
  )
  const mutationRepository = {
    currentPrivateEventProtocol,
    lockSessionForMutation: vi.fn(),
    validateSessionMutation,
    persistSessionMutation,
  }
  const recoveryRepository = {
    sessionMutationRepository: mutationRepository,
    recoverSessionForMutation: vi.fn(async () => ({
      kind: 'ready' as const,
      lifecycleStatus: 'active' as const,
      state: input.state,
      locked,
      session: locked,
      pointerRepair: null,
    })),
    retryReadonlySessionRecovery: vi.fn(),
  }
  const completeCommand = vi.fn(async () => {})
  const registerCommand = vi.fn(async (_tx, _owner, prepared) => ({
    status: 'acquired' as const,
    ledgerId,
    sessionId,
    commandId,
    canonicalPayloadDigest: prepared.canonicalPayloadDigest,
    owner,
  }))
  const readExistingCommandResult = vi.fn()
  const failCommand = vi.fn()
  const snapshotProjector = {
    project: vi.fn(
      async ({ state, session, eventSeq }: SnapshotProjectionInput) => ({
        protocolVersion: 1 as const,
        sessionId,
        stateVersion: state.stateVersion,
        eventSeq,
        pokerPhase: state.poker.pokerPhase,
        lifecycleStatus: input.lifecycleAfter,
        agentRunState: session.agentRunState,
        activeDecision: null,
        seats: state.poker.seats.map((seat) => ({
          seatNumber: seat.seatNumber,
          playerId: seat.playerId,
          displayName: seat.isUser ? '玩家' : `AI ${seat.seatNumber}`,
          avatarColor: '#0f766e',
          isUser: seat.isUser,
          stack: seat.stack,
          status: seat.status,
        })),
        hand: null,
        lastCompletedHandSummary: null,
      }),
    ),
  }
  const executorInput = {
    sql,
    owner,
    handlers: createSessionCommandHandlerMap({
      enabledCommandTypes: [input.commandType],
      bindings: [binding as never],
    }),
    mutationRepository: mutationRepository as never,
    recoveryRepository: recoveryRepository as never,
    recoveryRegistries: {
      snapshot: productionSnapshotVersionRegistry,
      privateEvent: productionPrivateEventVersionRegistry,
    },
    commandLedgerRepository: {
      registerCommand: registerCommand as never,
      readExistingCommandResult: readExistingCommandResult as never,
      completeCommand: completeCommand as never,
      failCommand: failCommand as never,
    },
    snapshotProjectorBinding: {
      projector: snapshotProjector,
      bindReadPort: () => Object.freeze({}),
    },
    now: () => '2026-08-05T10:00:00.000Z',
    nextEventId: () => eventId,
    ...(input.logPointerRepair === undefined
      ? {}
      : { logPointerRepair: input.logPointerRepair }),
  }
  const executor = createSessionCommandExecutor(executorInput)
  return {
    executor,
    executorInput,
    sessionId,
    commandId,
    eventId,
    binding,
    applyRelations,
    persistSessionMutation,
    validateSessionMutation,
    completeCommand,
    registerCommand,
    readExistingCommandResult,
    failCommand,
    recoveryRepository,
    mutationRepository,
    state: input.state,
    snapshotProjector,
    locked,
  }
}

describe('session command execution', () => {
  test('constructs an immutable handler map with an exact enabled command set', () => {
    const binding = testBinding()
    const handlers = createSessionCommandHandlerMap({
      enabledCommandTypes: ['endSession'],
      bindings: [binding],
    })

    expect(handlers.has('endSession')).toBe(true)
    const composedBinding = handlers.get('endSession')
    expect(composedBinding).not.toBe(binding)
    expect(Object.isFrozen(composedBinding)).toBe(true)
    expect(Object.isFrozen(composedBinding.handler)).toBe(true)
    const replacement = vi.fn(async () => ({
      kind: 'rejected' as const,
      rejection: {
        kind: 'commandNotAllowedInPhase' as const,
        phase: 'betweenHands' as const,
      },
    }))
    ;(
      binding as unknown as { handler: { prepare: typeof replacement } }
    ).handler.prepare = replacement
    expect(composedBinding.handler.prepare).not.toBe(replacement)
    expect(Object.isFrozen(handlers)).toBe(true)
    expect(() => handlers.get('rebuy')).toThrow(SessionCommandCompositionError)
    expect(() =>
      createSessionCommandHandlerMap({
        enabledCommandTypes: ['endSession'],
        bindings: [],
      }),
    ).toThrow(SessionCommandCompositionError)
    expect(() =>
      createSessionCommandHandlerMap({
        enabledCommandTypes: ['endSession'],
        bindings: [binding, binding],
      }),
    ).toThrow(SessionCommandCompositionError)
  })

  test('preserves the original handler receiver while capturing its methods', async () => {
    class StatefulHandler {
      readonly #phase = 'betweenHands' as const

      async prepare() {
        return {
          kind: 'rejected' as const,
          rejection: {
            kind: 'commandNotAllowedInPhase' as const,
            phase: this.#phase,
          },
        }
      }

      async applyRelations() {
        void this.#phase
      }
    }

    const handler = new StatefulHandler()
    const handlers = createSessionCommandHandlerMap({
      enabledCommandTypes: ['endSession'],
      bindings: [
        {
          commandType: 'endSession',
          handler,
          bindReadPort: () => Object.freeze({}),
          bindWritePort: () => Object.freeze({}),
        },
      ],
    })

    await expect(
      handlers.get('endSession').handler.prepare({} as never),
    ).resolves.toMatchObject({
      rejection: { phase: 'betweenHands' },
    })
  })

  test('guards nested transaction ports after their phase expires', () => {
    const lifetime = { active: true }
    const nested = {
      read: vi.fn(() => 'nested'),
      deeper: { write: vi.fn(() => 'deeper') },
    }
    const guarded = createGuardedPort({ nested }, lifetime)
    const leakedNested = guarded.nested
    const leakedDeeper = guarded.nested.deeper

    expect(Object.keys(guarded)).toEqual(['nested'])
    expect(Object.keys(leakedNested)).toEqual(['read', 'deeper'])
    expect(leakedNested.read()).toBe('nested')
    expect(leakedDeeper.write()).toBe('deeper')
    lifetime.active = false

    expect(() => leakedNested.read()).toThrow(
      'Transaction port is no longer active.',
    )
    expect(() => leakedDeeper.write()).toThrow(
      'Transaction port is no longer active.',
    )
  })

  test('preserves runtime types of domain values returned by port methods', () => {
    const lifetime = { active: true }
    const rows = Object.freeze([1, 2])
    const occurredAt = new Date('2026-08-05T10:00:00.000Z')
    const guarded = createGuardedPort(
      {
        readRows: () => rows,
        readOccurredAt: () => occurredAt,
      },
      lifetime,
    )

    const returnedRows = guarded.readRows()
    const returnedOccurredAt = guarded.readOccurredAt()

    expect(returnedRows).toBe(rows)
    expect(Array.isArray(returnedRows)).toBe(true)
    expect(structuredClone(returnedRows)).toEqual([1, 2])
    expect(returnedOccurredAt).toBe(occurredAt)
    expect(returnedOccurredAt).toBeInstanceOf(Date)
    expect(returnedOccurredAt.toISOString()).toBe('2026-08-05T10:00:00.000Z')
  })

  test('captures executor dependencies supplied at composition time', async () => {
    const poker = createTestPokerState()
    const state = createPrivateTableState({
      stateVersion: 7,
      poker,
      completedHandCount: 0,
      seatAccounting: poker.seats.map((seat) => ({
        seatNumber: seat.seatNumber,
        cumulativeBuyIn: 2_000,
      })),
      lastCompletedHandSummary: null,
    })
    const fixture = await createExecutionFixture({
      commandType: 'endSession',
      state,
      lifecycleAfter: 'ended',
      preparedResult: {
        kind: 'prepared',
        mutation: {
          stateEffect: { kind: 'stateUnchanged' },
          lifecycleAfter: 'ended',
          currentHandIdAfter: null,
          playerCoordinationAfter: {
            agentRunState: 'idle',
            activePlayerRunId: null,
            activeDecisionRequestId: null,
          },
          privateEventDrafts: [
            { type: 'sessionEnded', reason: 'userRequested' },
          ],
          relationPlan: Object.freeze({ kind: 'endSession' }),
        },
      },
    })
    const replacementParseDraft = vi.fn(() => {
      throw new Error('replacement mutation repository was used')
    })
    const replacementMutationRepository = {
      ...fixture.mutationRepository,
      currentPrivateEventProtocol: {
        ...currentPrivateEventProtocol,
        parseDraft: replacementParseDraft,
      },
    }
    ;(
      fixture.executorInput as { mutationRepository: unknown }
    ).mutationRepository = replacementMutationRepository

    await expect(
      fixture.executor.execute({
        sessionId: fixture.sessionId,
        commandId: fixture.commandId,
        expectedStateVersion: 7,
        type: 'endSession',
        payload: {},
      }),
    ).resolves.toMatchObject({ kind: 'completed', origin: 'newCommit' })
    expect(replacementParseDraft).not.toHaveBeenCalled()
    expect(fixture.validateSessionMutation).toHaveBeenCalledOnce()
  })

  test('commits a stable handler rejection without creating a write port', async () => {
    const sessionId = '22222222-2222-4222-8222-222222222222'
    const commandId = '33333333-3333-4333-8333-333333333333'
    const ledgerId = '44444444-4444-4444-8444-444444444444'
    const poker = createTestPokerState()
    const state = createPrivateTableState({
      stateVersion: 7,
      poker,
      completedHandCount: 0,
      seatAccounting: poker.seats.map((seat) => ({
        seatNumber: seat.seatNumber,
        cumulativeBuyIn: 2_000,
      })),
      lastCompletedHandSummary: null,
    })
    const snapshot = {
      protocolVersion: 1 as const,
      sessionId,
      stateVersion: 7,
      eventSeq: 19,
      pokerPhase: 'betweenHands' as const,
      lifecycleStatus: 'active' as const,
      agentRunState: 'idle' as const,
      activeDecision: null,
      seats: poker.seats.map((seat) => ({
        seatNumber: seat.seatNumber,
        playerId: seat.playerId,
        displayName: seat.isUser ? '玩家' : `AI ${seat.seatNumber}`,
        avatarColor: '#0f766e',
        isUser: seat.isUser,
        stack: seat.stack,
        status: seat.status,
      })),
      hand: null,
      lastCompletedHandSummary: null,
    }
    const transaction = (() => Promise.resolve([])) as unknown as TransactionSql
    const begin = vi.fn(async (callback: (tx: TransactionSql) => unknown) =>
      callback(transaction),
    )
    const sql = Object.assign((() => Promise.resolve([])) as unknown as Sql, {
      begin,
    })
    const owner = await resolveOwnerScope(
      (() =>
        Promise.resolve([
          { databaseOwnerId: '11111111-1111-4111-8111-111111111111' },
        ])) as unknown as Sql,
      { ownerId: 'local-user' },
    )
    const bindWritePort = vi.fn(() => Object.freeze({}))
    const binding = { ...testBinding(), bindWritePort }
    const handlers = createSessionCommandHandlerMap({
      enabledCommandTypes: ['endSession'],
      bindings: [binding],
    })
    const failCommand = vi.fn(async () => {})
    const mutationRepository = {
      currentPrivateEventProtocol: {
        identity: { rowPayloadVersion: 2, envelopeSchemaVersion: 2 },
        parseDraft: (input: unknown) => input as never,
        encodeCurrent: (input: never) => input,
        decodeStoredCurrent: (input: unknown) => input as never,
      },
      lockSessionForMutation: vi.fn(),
      persistSessionMutation: vi.fn(),
    }
    const recoveryRepository = {
      sessionMutationRepository: mutationRepository,
      recoverSessionForMutation: vi.fn(async () => ({
        kind: 'ready' as const,
        lifecycleStatus: 'active' as const,
        state,
        locked: {
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
        } as never,
        session: {
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
        },
        pointerRepair: null,
      })),
      retryReadonlySessionRecovery: vi.fn(),
    }
    const executor = createSessionCommandExecutor({
      sql,
      owner,
      handlers,
      mutationRepository: mutationRepository as never,
      recoveryRepository: recoveryRepository as never,
      recoveryRegistries: {
        snapshot: productionSnapshotVersionRegistry,
        privateEvent: productionPrivateEventVersionRegistry,
      },
      commandLedgerRepository: {
        registerCommand: vi.fn(async (_tx, _owner, prepared) => ({
          status: 'acquired' as const,
          ledgerId,
          sessionId,
          commandId,
          canonicalPayloadDigest: prepared.canonicalPayloadDigest,
          owner,
        })) as never,
        readExistingCommandResult: vi.fn() as never,
        completeCommand: vi.fn() as never,
        failCommand: failCommand as never,
      },
      snapshotProjectorBinding: {
        projector: { project: vi.fn(async () => snapshot) },
        bindReadPort: () => Object.freeze({}),
      },
      now: () => '2026-08-05T10:00:00.000Z',
      nextEventId: () => '55555555-5555-4555-8555-555555555555',
    })

    await expect(
      executor.execute({
        sessionId,
        commandId,
        expectedStateVersion: 7,
        type: 'endSession',
        payload: {},
      }),
    ).resolves.toMatchObject({
      kind: 'rejected',
      origin: 'ledgerCommit',
      response: {
        code: 'COMMAND_NOT_ALLOWED_IN_PHASE',
        latestSnapshot: snapshot,
      },
    })
    expect(failCommand).toHaveBeenCalledOnce()
    expect(bindWritePort).not.toHaveBeenCalled()
  })

  test('assigns one final version and persists a validated stateChanged command', async () => {
    const baseline = createTestPokerState()
    const poker = createTestPokerState({
      seats: baseline.seats.map((seat) =>
        seat.seatNumber === 0 ? { ...seat, stack: 1_000 } : seat,
      ),
    })
    const state = createPrivateTableState({
      stateVersion: 7,
      poker,
      completedHandCount: 0,
      seatAccounting: poker.seats.map((seat) => ({
        seatNumber: seat.seatNumber,
        cumulativeBuyIn: seat.stack,
      })),
      lastCompletedHandSummary: null,
    })
    const finalPoker = createTestPokerState({
      seats: poker.seats.map((seat) =>
        seat.seatNumber === 0 ? { ...seat, stack: 1_500 } : seat,
      ),
    })
    const fixture = await createExecutionFixture({
      commandType: 'rebuy',
      state,
      lifecycleAfter: 'active',
      preparedResult: {
        kind: 'prepared',
        mutation: {
          stateEffect: {
            kind: 'stateChanged',
            stateContent: {
              poker: finalPoker,
              completedHandCount: 0,
              seatAccounting: finalPoker.seats.map((seat) => ({
                seatNumber: seat.seatNumber,
                cumulativeBuyIn: seat.stack,
              })),
              lastCompletedHandSummary: null,
            },
          },
          lifecycleAfter: 'active',
          currentHandIdAfter: null,
          playerCoordinationAfter: {
            agentRunState: 'idle',
            activePlayerRunId: null,
            activeDecisionRequestId: null,
          },
          privateEventDrafts: [
            {
              type: 'userRebuy',
              seatNumber: 0,
              amount: 500,
              stackBefore: 1_000,
              stackAfter: 1_500,
              cumulativeBuyInBefore: 1_000,
              cumulativeBuyInAfter: 1_500,
            },
          ],
          relationPlan: Object.freeze({ kind: 'testRebuy' }),
        },
      },
    })

    const result = await fixture.executor.execute({
      sessionId: fixture.sessionId,
      commandId: fixture.commandId,
      expectedStateVersion: 7,
      type: 'rebuy',
      payload: { amount: 500 },
    })

    expect(result).toMatchObject({
      kind: 'completed',
      origin: 'newCommit',
      response: { snapshot: { stateVersion: 8, eventSeq: 20 } },
      newlyPersistedEvents: [
        {
          eventId: fixture.eventId,
          eventSeq: 20,
          stateVersion: 8,
          type: 'userRebuy',
        },
      ],
    })
    const batch = fixture.persistSessionMutation.mock.calls[0]?.[2]
    expect(batch).toMatchObject({
      finalStateVersion: 8,
      snapshot: { payload: { state: { stateVersion: 8 } } },
      events: [
        {
          eventSeq: 20,
          stateVersionBefore: 7,
          stateVersionAfter: 8,
          privateEvent: { payloadVersion: 2 },
        },
      ],
    })
    expect(fixture.applyRelations).toHaveBeenCalledOnce()
    expect(fixture.completeCommand).toHaveBeenCalledOnce()
    expect(Object.isFrozen(result)).toBe(true)
  })

  test('keeps the version and omits the snapshot for stateUnchanged lifecycle events', async () => {
    const poker = createTestPokerState()
    const state = createPrivateTableState({
      stateVersion: 7,
      poker,
      completedHandCount: 0,
      seatAccounting: poker.seats.map((seat) => ({
        seatNumber: seat.seatNumber,
        cumulativeBuyIn: 2_000,
      })),
      lastCompletedHandSummary: null,
    })
    const preparedResult: PrepareCommandResult = {
      kind: 'prepared',
      mutation: {
        stateEffect: { kind: 'stateUnchanged' },
        lifecycleAfter: 'ended',
        currentHandIdAfter: null,
        playerCoordinationAfter: {
          agentRunState: 'idle',
          activePlayerRunId: null,
          activeDecisionRequestId: null,
        },
        privateEventDrafts: [{ type: 'sessionEnded', reason: 'userRequested' }],
        relationPlan: Object.freeze({ kind: 'endSession' }),
      },
    }
    const fixture = await createExecutionFixture({
      commandType: 'endSession',
      state,
      lifecycleAfter: 'ended',
      preparedResult,
    })
    let leakedReads: { readonly read: () => string } | undefined
    let leakedWrites: { readonly write: () => string } | undefined
    fixture.binding.handler.prepare.mockImplementationOnce(async (context) => {
      leakedReads = (context as { readonly reads: typeof leakedReads }).reads
      return preparedResult
    })
    fixture.applyRelations.mockImplementationOnce(async (context) => {
      leakedWrites = (context as { readonly writes: typeof leakedWrites })
        .writes
    })

    await expect(
      fixture.executor.execute({
        sessionId: fixture.sessionId,
        commandId: fixture.commandId,
        expectedStateVersion: 7,
        type: 'endSession',
        payload: {},
      }),
    ).resolves.toMatchObject({
      kind: 'completed',
      origin: 'newCommit',
      response: {
        snapshot: { stateVersion: 7, lifecycleStatus: 'ended', eventSeq: 20 },
      },
    })
    expect(fixture.persistSessionMutation.mock.calls[0]?.[2]).toMatchObject({
      finalStateVersion: 7,
      lifecycleStatus: 'ended',
      currentHandId: null,
      snapshot: null,
      events: [
        {
          handId: null,
          privateEvent: {
            payloadVersion: 2,
            payload: { event: { type: 'sessionEnded' } },
          },
        },
      ],
    })
    expect(() => leakedReads?.read()).toThrow(
      'Transaction port is no longer active.',
    )
    expect(() => leakedWrites?.write()).toThrow(
      'Transaction port is no longer active.',
    )
  })

  test('rolls back malformed candidates and late resource failures', async () => {
    const poker = createTestPokerState()
    const state = createPrivateTableState({
      stateVersion: 7,
      poker,
      completedHandCount: 0,
      seatAccounting: poker.seats.map((seat) => ({
        seatNumber: seat.seatNumber,
        cumulativeBuyIn: 2_000,
      })),
      lastCompletedHandSummary: null,
    })
    const nestedRelationPlan = Object.freeze({
      kind: 'endSession',
      nested: {},
    })
    const malformed = await createExecutionFixture({
      commandType: 'endSession',
      state,
      lifecycleAfter: 'ended',
      preparedResult: {
        kind: 'prepared',
        mutation: {
          stateEffect: { kind: 'stateUnchanged' },
          lifecycleAfter: 'ended',
          currentHandIdAfter: null,
          playerCoordinationAfter: {
            agentRunState: 'idle',
            activePlayerRunId: null,
            activeDecisionRequestId: null,
          },
          privateEventDrafts: [
            { type: 'sessionEnded', reason: 'userRequested' },
          ],
          relationPlan: nestedRelationPlan,
        },
      },
    })
    await expect(
      malformed.executor.execute({
        sessionId: malformed.sessionId,
        commandId: malformed.commandId,
        expectedStateVersion: 7,
        type: 'endSession',
        payload: {},
      }),
    ).rejects.toBeInstanceOf(SessionCommandInvariantError)
    expect(malformed.binding.bindWritePort).not.toHaveBeenCalled()
    expect(malformed.persistSessionMutation).not.toHaveBeenCalled()
    expect(malformed.failCommand).not.toHaveBeenCalled()

    const logPointerRepair = vi.fn()
    const lateFailure = await createExecutionFixture({
      commandType: 'endSession',
      state,
      lifecycleAfter: 'ended',
      logPointerRepair,
      preparedResult: {
        kind: 'prepared',
        mutation: {
          stateEffect: { kind: 'stateUnchanged' },
          lifecycleAfter: 'ended',
          currentHandIdAfter: null,
          playerCoordinationAfter: {
            agentRunState: 'idle',
            activePlayerRunId: null,
            activeDecisionRequestId: null,
          },
          privateEventDrafts: [
            { type: 'sessionEnded', reason: 'userRequested' },
          ],
          relationPlan: Object.freeze({ kind: 'endSession' }),
        },
      },
    })
    lateFailure.recoveryRepository.recoverSessionForMutation.mockResolvedValueOnce(
      {
        kind: 'ready',
        lifecycleStatus: 'active',
        state,
        locked: lateFailure.locked,
        session: lateFailure.locked,
        pointerRepair: { from: null, to: null },
      } as never,
    )
    lateFailure.applyRelations.mockRejectedValueOnce(
      new ResourceNotFoundError(),
    )
    await expect(
      lateFailure.executor.execute({
        sessionId: lateFailure.sessionId,
        commandId: lateFailure.commandId,
        expectedStateVersion: 7,
        type: 'endSession',
        payload: {},
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError)
    expect(logPointerRepair).not.toHaveBeenCalled()
    expect(lateFailure.failCommand).not.toHaveBeenCalled()
  })

  test('rejects malformed or phase-inconsistent stable rejections as internal failures', async () => {
    const poker = createTestPokerState()
    const state = createPrivateTableState({
      stateVersion: 7,
      poker,
      completedHandCount: 0,
      seatAccounting: poker.seats.map((seat) => ({
        seatNumber: seat.seatNumber,
        cumulativeBuyIn: 2_000,
      })),
      lastCompletedHandSummary: null,
    })
    for (const rejection of [
      {
        kind: 'commandNotAllowedInPhase',
        phase: 'invalid',
        extra: true,
      },
      { kind: 'commandNotAllowedInPhase', phase: 'inHand' },
    ]) {
      const fixture = await createExecutionFixture({
        commandType: 'endSession',
        state,
        lifecycleAfter: 'active',
        preparedResult: { kind: 'rejected', rejection } as never,
      })

      await expect(
        fixture.executor.execute({
          sessionId: fixture.sessionId,
          commandId: fixture.commandId,
          expectedStateVersion: 7,
          type: 'endSession',
          payload: {},
        }),
      ).rejects.toBeInstanceOf(SessionCommandInvariantError)
      expect(fixture.failCommand).not.toHaveBeenCalled()
      expect(fixture.binding.bindWritePort).not.toHaveBeenCalled()
    }
  })

  test('validates the complete mutation batch before binding the write port', async () => {
    const poker = createTestPokerState({
      seats: createTestPokerState().seats.map((seat) =>
        seat.seatNumber === 0 ? { ...seat, stack: 1_000 } : seat,
      ),
    })
    const state = createPrivateTableState({
      stateVersion: 7,
      poker,
      completedHandCount: 0,
      seatAccounting: poker.seats.map((seat) => ({
        seatNumber: seat.seatNumber,
        cumulativeBuyIn: seat.stack,
      })),
      lastCompletedHandSummary: null,
    })
    const finalPoker = createTestPokerState({
      seats: poker.seats.map((seat) =>
        seat.seatNumber === 0 ? { ...seat, stack: 1_500 } : seat,
      ),
    })
    const fixture = await createExecutionFixture({
      commandType: 'rebuy',
      state,
      lifecycleAfter: 'active',
      preparedResult: {
        kind: 'prepared',
        mutation: {
          stateEffect: {
            kind: 'stateChanged',
            stateContent: {
              poker: finalPoker,
              completedHandCount: 0,
              seatAccounting: finalPoker.seats.map((seat) => ({
                seatNumber: seat.seatNumber,
                cumulativeBuyIn: seat.stack,
              })),
              lastCompletedHandSummary: null,
            },
          },
          lifecycleAfter: 'active',
          currentHandIdAfter: null,
          playerCoordinationAfter: {
            agentRunState: 'idle',
            activePlayerRunId: null,
            activeDecisionRequestId: null,
          },
          privateEventDrafts: [
            {
              type: 'userRebuy',
              seatNumber: 0,
              amount: 500,
              stackBefore: 1_000,
              stackAfter: 1_500,
              cumulativeBuyInBefore: 1_000,
              cumulativeBuyInAfter: 1_500,
            },
          ],
          relationPlan: Object.freeze({ kind: 'testRebuy' }),
        },
      },
    })
    const project = fixture.snapshotProjector.project.getMockImplementation()!
    fixture.snapshotProjector.project.mockImplementationOnce(async () => ({
      ...(await project({
        state: createPrivateTableState({
          stateVersion: 8,
          poker: finalPoker,
          completedHandCount: 0,
          seatAccounting: finalPoker.seats.map((seat) => ({
            seatNumber: seat.seatNumber,
            cumulativeBuyIn: seat.stack,
          })),
          lastCompletedHandSummary: null,
        }),
        session: { agentRunState: 'idle' },
        eventSeq: 20,
      } as never)),
      sessionId: '22222222-2222-4222-8222-222222222223',
    }))

    await expect(
      fixture.executor.execute({
        sessionId: fixture.sessionId,
        commandId: fixture.commandId,
        expectedStateVersion: 7,
        type: 'rebuy',
        payload: { amount: 500 },
      }),
    ).rejects.toBeInstanceOf(SessionCommandInvariantError)
    expect(fixture.validateSessionMutation).toHaveBeenCalledOnce()
    expect(fixture.binding.bindWritePort).not.toHaveBeenCalled()
    expect(fixture.applyRelations).not.toHaveBeenCalled()
    expect(fixture.persistSessionMutation).not.toHaveBeenCalled()
  })

  test('separates version failures, active replays, ended replays and diagnostics', async () => {
    const poker = createTestPokerState()
    const state = createPrivateTableState({
      stateVersion: 7,
      poker,
      completedHandCount: 0,
      seatAccounting: poker.seats.map((seat) => ({
        seatNumber: seat.seatNumber,
        cumulativeBuyIn: 2_000,
      })),
      lastCompletedHandSummary: null,
    })
    const rejection: PrepareCommandResult = {
      kind: 'rejected',
      rejection: {
        kind: 'commandNotAllowedInPhase',
        phase: 'betweenHands',
      },
    }

    const conflict = await createExecutionFixture({
      commandType: 'endSession',
      state,
      lifecycleAfter: 'active',
      preparedResult: rejection,
    })
    await expect(
      conflict.executor.execute({
        sessionId: conflict.sessionId,
        commandId: conflict.commandId,
        expectedStateVersion: 6,
        type: 'endSession',
        payload: {},
      }),
    ).resolves.toMatchObject({
      kind: 'rejected',
      origin: 'ledgerCommit',
      response: { code: 'STATE_VERSION_CONFLICT' },
    })
    expect(conflict.binding.handler.prepare).not.toHaveBeenCalled()
    expect(conflict.binding.bindWritePort).not.toHaveBeenCalled()
    expect(conflict.failCommand).toHaveBeenCalledOnce()

    const replay = await createExecutionFixture({
      commandType: 'endSession',
      state,
      lifecycleAfter: 'active',
      preparedResult: rejection,
    })
    const replaySnapshot = await replay.snapshotProjector.project({
      command: {} as never,
      state,
      session: { agentRunState: 'idle' } as never,
      eventSeq: 19,
      newPrivateEvents: [],
      reads: {},
    })
    replay.registerCommand.mockImplementationOnce(
      async () =>
        ({
          status: 'completed',
          response: { protocolVersion: 1, snapshot: replaySnapshot },
        }) as never,
    )
    await expect(
      replay.executor.execute({
        sessionId: replay.sessionId,
        commandId: replay.commandId,
        expectedStateVersion: 7,
        type: 'endSession',
        payload: {},
      }),
    ).resolves.toMatchObject({ kind: 'completed', origin: 'replay' })
    expect(replay.binding.handler.prepare).not.toHaveBeenCalled()
    expect(replay.persistSessionMutation).not.toHaveBeenCalled()

    const ended = await createExecutionFixture({
      commandType: 'endSession',
      state,
      lifecycleAfter: 'ended',
      preparedResult: rejection,
    })
    ended.recoveryRepository.recoverSessionForMutation.mockImplementationOnce(
      async () =>
        ({
          kind: 'ended',
          state,
          pointerRepair: null,
          session: {
            sessionId: ended.sessionId,
            lifecycleStatus: 'ended',
            endedAt: '2026-08-05T09:00:00.000000Z',
            stateVersion: 7,
            nextEventSeq: 20,
            currentHandId: null,
            diagnosticCode: null,
            diagnosedAt: null,
            agentRunState: 'idle',
            activePlayerRunId: null,
            activeDecisionRequestId: null,
          },
        }) as never,
    )
    ended.readExistingCommandResult.mockImplementationOnce(
      async () =>
        ({
          status: 'completed',
          response: { protocolVersion: 1, snapshot: replaySnapshot },
        }) as never,
    )
    await expect(
      ended.executor.execute({
        sessionId: ended.sessionId,
        commandId: ended.commandId,
        expectedStateVersion: 7,
        type: 'endSession',
        payload: {},
      }),
    ).resolves.toMatchObject({ kind: 'completed', origin: 'replay' })
    expect(ended.registerCommand).not.toHaveBeenCalled()

    const diagnostic = await createExecutionFixture({
      commandType: 'endSession',
      state,
      lifecycleAfter: 'active',
      preparedResult: rejection,
    })
    diagnostic.recoveryRepository.recoverSessionForMutation.mockImplementationOnce(
      async () =>
        ({
          kind: 'readonlyDiagnostic',
          code: 'snapshotMissing',
          diagnosedAt: '2026-08-05T09:00:00.000000Z',
        }) as never,
    )
    await expect(
      diagnostic.executor.execute({
        sessionId: diagnostic.sessionId,
        commandId: diagnostic.commandId,
        expectedStateVersion: 7,
        type: 'endSession',
        payload: {},
      }),
    ).resolves.toMatchObject({
      kind: 'rejected',
      origin: 'unregistered',
      response: { code: 'SESSION_READONLY_DIAGNOSTIC' },
    })
    expect(diagnostic.registerCommand).not.toHaveBeenCalled()
    expect(diagnostic.readExistingCommandResult).not.toHaveBeenCalled()
  })

  test('serializes equivalent Session ids, continues after failure, and allows different Sessions in parallel', async () => {
    const poker = createTestPokerState()
    const state = createPrivateTableState({
      stateVersion: 7,
      poker,
      completedHandCount: 0,
      seatAccounting: poker.seats.map((seat) => ({
        seatNumber: seat.seatNumber,
        cumulativeBuyIn: 2_000,
      })),
      lastCompletedHandSummary: null,
    })
    const rejection: PrepareCommandResult = {
      kind: 'rejected',
      rejection: {
        kind: 'commandNotAllowedInPhase',
        phase: 'betweenHands',
      },
    }
    const fixture = await createExecutionFixture({
      commandType: 'endSession',
      state,
      lifecycleAfter: 'active',
      preparedResult: rejection,
    })
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let starts = 0
    fixture.binding.handler.prepare
      .mockImplementationOnce(async () => {
        starts += 1
        await firstGate
        throw new Error('first command failed')
      })
      .mockImplementationOnce(async () => {
        starts += 1
        return rejection
      })
    const first = fixture.executor
      .execute({
        sessionId: fixture.sessionId.toUpperCase(),
        commandId: fixture.commandId,
        expectedStateVersion: 7,
        type: 'endSession',
        payload: {},
      })
      .catch((error: unknown) => error)
    await vi.waitFor(() => expect(starts).toBe(1))
    const second = fixture.executor.execute({
      sessionId: fixture.sessionId,
      commandId: '33333333-3333-4333-8333-333333333334',
      expectedStateVersion: 7,
      type: 'endSession',
      payload: {},
    })
    await Promise.resolve()
    expect(starts).toBe(1)
    releaseFirst()
    await expect(first).resolves.toBeInstanceOf(Error)
    await expect(second).resolves.toMatchObject({
      kind: 'rejected',
      origin: 'ledgerCommit',
    })

    let releaseParallel!: () => void
    const parallelGate = new Promise<void>((resolve) => {
      releaseParallel = resolve
    })
    starts = 0
    fixture.binding.handler.prepare.mockImplementation(async () => {
      starts += 1
      await parallelGate
      return rejection
    })
    const parallel = [
      fixture.executor.execute({
        sessionId: fixture.sessionId,
        commandId: '33333333-3333-4333-8333-333333333335',
        expectedStateVersion: 7,
        type: 'endSession',
        payload: {},
      }),
      fixture.executor.execute({
        sessionId: '22222222-2222-4222-8222-222222222223',
        commandId: '33333333-3333-4333-8333-333333333336',
        expectedStateVersion: 7,
        type: 'endSession',
        payload: {},
      }),
    ]
    await vi.waitFor(() => expect(starts).toBe(2))
    releaseParallel()
    await expect(Promise.all(parallel)).resolves.toHaveLength(2)
  })
})
