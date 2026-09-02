import type { Sql, TransactionSql } from 'postgres'
import { describe, expect, test, vi } from 'vitest'
import { z } from 'zod'
import { createRunConfigurationSnapshot } from '../../src/agents/foundation/agent-run-coordinator.js'
import type { PersistedAgentRun } from '../../src/agents/foundation/agent-run-types.js'
import { issueRuntimeCommitAuthority } from '../../src/agents/foundation/runtime-ports.js'
import { playerRuntimeDefinition } from '../../src/agents/player/foundation-definition.js'
import { createSessionAgentCoordinator } from '../../src/agents/player/session-agent-coordinator.js'
import { encodeStrategyPackAuditReference } from '../../src/agents/player/player-strategy-pack-audit-reference.js'
import { StrategyPackUnavailableError } from '../../src/poker-strategy/strategy-pack-repository.js'
import { currentPrivateEventProtocol } from '../../src/sessions/authoritative-state/current-private-event-protocol.js'
import { createPrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'
import type { ReadySessionRecovery } from '../../src/persistence/session-recovery-repository.js'
import { createTestBettingPokerState } from '../poker/create-test-poker-state.js'

const sessionId = '20000000-0000-4000-8000-000000000001'
const handId = '10000000-0000-4000-8000-000000000001'
const runId = '40000000-0000-4000-8000-000000000001'
const replacementRunId = '40000000-0000-4000-8000-000000000002'
const decisionRequestId = '50000000-0000-4000-8000-000000000001'
const replacementDecisionRequestId = '50000000-0000-4000-8000-000000000002'
const attemptId = '60000000-0000-4000-8000-000000000001'
const actorParticipantId = '00000000-0000-4000-8000-000000000004'
const settledAt = '2026-08-28T00:00:10.000Z'

const PlayerProcessRestartRecoveryResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('unchanged') }),
  z.strictObject({ kind: z.literal('paused') }),
  z.strictObject({
    kind: z.literal('reconciledWithoutReplacement'),
    newlyPersistedEvents: z.array(z.unknown()),
  }),
  z.strictObject({
    kind: z.literal('replacementQueued'),
    replacementRunId: z.uuid(),
    newlyPersistedEvents: z.tuple([z.unknown()]).rest(z.unknown()),
  }),
])

function createState() {
  const poker = createTestBettingPokerState({
    hand: { currentActorSeatNumber: 3 },
  })
  return createPrivateTableState({
    stateVersion: 7,
    poker,
    completedHandCount: 0,
    seatAccounting: poker.seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      cumulativeBuyIn: 2_000,
    })),
    lastCompletedHandSummary: null,
  })
}

function createSql(state: ReturnType<typeof createState>): Sql {
  const roster = state.poker.seats.map((seat) => ({
    seatNumber: seat.seatNumber,
    playerId: seat.playerId,
    participantType: seat.isUser ? 'user' : 'agent',
    displayName: seat.isUser ? null : `AI ${seat.seatNumber}`,
    avatarColor: seat.isUser ? null : '#123456',
  }))
  const transaction = (async (strings: TemplateStringsArray) => {
    const query = strings.join('')
    if (query.includes('FROM app_private.session_participants')) return roster
    if (query.includes('FROM app_private.session_events')) return []
    throw new Error(`测试事务收到未预期查询：${query}`)
  }) as unknown as TransactionSql
  return Object.assign(transaction, {
    begin: async <Value>(
      operation: (input: TransactionSql) => Promise<Value>,
    ): Promise<Value> => operation(transaction),
  }) as unknown as Sql
}

function createRecovery(
  state: ReturnType<typeof createState>,
): ReadySessionRecovery {
  const session = Object.freeze({
    sessionId,
    lifecycleStatus: 'active' as const,
    endedAt: null,
    stateVersion: state.stateVersion,
    nextEventSeq: 8,
    currentHandId: handId,
    diagnosticCode: null,
    diagnosedAt: null,
    agentRunState: 'thinking' as const,
    activePlayerRunId: runId,
    activeDecisionRequestId: decisionRequestId,
  })
  return Object.freeze({
    kind: 'ready' as const,
    lifecycleStatus: 'active' as const,
    state,
    locked: session,
    session,
    pointerRepair: null,
  }) as ReadySessionRecovery
}

function createRun(
  input: Partial<PersistedAgentRun<'player'>> = {},
): PersistedAgentRun<'player'> {
  const dependencies = [
    encodeStrategyPackAuditReference({
      datasetId: 'm45-empty-authorized',
      datasetVersion: 1,
    }),
  ]
  return Object.freeze({
    ownerId: 'local-user',
    runId,
    runtimeType: 'player',
    sessionId,
    handId,
    triggerType: 'initial',
    lifecycle: 'running',
    idempotencyKey: 'unit-m48-run',
    parentRunId: null,
    replacementRunId: null,
    leaseOwner: 'unit-m48:player:0',
    leaseExpiresAt: '2026-08-28T00:01:00.000Z',
    fencingToken: 1,
    deadlineAt: '2026-08-28T00:01:00.000Z',
    runtimeDefinitionVersion: 1,
    terminationReason: null,
    runConfiguration: createRunConfigurationSnapshot(
      playerRuntimeDefinition,
      dependencies,
    ),
    budget: { maxWallClockMs: 60_000 },
    createdAt: '2026-08-28T00:00:00.000Z',
    startedAt: '2026-08-28T00:00:00.000Z',
    completedAt: null,
    updatedAt: '2026-08-28T00:00:00.000Z',
    participantId: actorParticipantId,
    sourceStateVersion: 7,
    decisionRequestId,
    ...input,
  }) as PersistedAgentRun<'player'>
}

function authority() {
  return issueRuntimeCommitAuthority({
    runtimeType: 'player',
    runId,
    leaseOwner: 'unit-m48:player:0',
    fencingToken: 1,
  })
}

function createCoordinator(
  input: {
    readonly run?: PersistedAgentRun<'player'>
    readonly strategyPackRead?: () => unknown
  } = {},
) {
  const state = createState()
  const recovered = createRecovery(state)
  const run = input.run ?? createRun()
  const sql = createSql(state)
  const persistedBatches: unknown[] = []
  const runEventPort = { publish: vi.fn().mockResolvedValue(undefined) }
  const runRepository = {
    lockPlayerRunForCoordination: vi.fn().mockResolvedValue(run),
    terminateForCoordination: vi
      .fn()
      .mockImplementation(async (_transaction, _owner, termination) =>
        createRun({
          ...run,
          lifecycle: termination.lifecycle,
          terminationReason: termination.terminationReason,
          completedAt: termination.completedAt,
          leaseOwner: null,
          leaseExpiresAt: null,
        }),
      ),
    createOrReuse: vi.fn().mockResolvedValue({
      kind: 'created',
      run: createRun({
        runId: replacementRunId,
        decisionRequestId: replacementDecisionRequestId,
        lifecycle: 'queued',
        parentRunId: runId,
        leaseOwner: null,
        leaseExpiresAt: null,
        fencingToken: 0,
        startedAt: null,
      }),
    }),
    linkReplacement: vi.fn().mockResolvedValue(undefined),
  }
  const decisionRepository = {
    markTerminalForCoordination: vi.fn().mockResolvedValue(undefined),
  }
  const foundationRepository = {
    startBudgetedAgentAttemptAudit: vi.fn().mockResolvedValue({
      kind: 'started',
      attemptId,
      attemptNumber: 1,
      actualTimeoutMs: 1_000,
      maximumOutputTokens: 20,
    }),
  }
  const recoveryRepository = {
    recoverSessionForMutation: vi.fn().mockResolvedValue(recovered),
    sessionMutationRepository: {
      currentPrivateEventProtocol,
      validateSessionMutation: vi.fn(),
      persistSessionMutation: vi
        .fn()
        .mockImplementation(async (_transaction, _locked, batch) => {
          persistedBatches.push(batch)
          return {
            sessionId,
            finalStateVersion: batch.finalStateVersion,
            nextEventSeq: batch.events.at(-1).eventSeq + 1,
            firstEventSeq: batch.events[0].eventSeq,
            lastEventSeq: batch.events.at(-1).eventSeq,
            events: batch.events.map(
              (event: { readonly publicEvent: unknown }) => event.publicEvent,
            ),
          }
        }),
    },
  }
  const runCoordinator = { createOrReuse: vi.fn() }
  const coordinator = createSessionAgentCoordinator({
    sql,
    owner: {} as never,
    registry: {
      resolveExact: vi.fn().mockReturnValue(playerRuntimeDefinition),
    } as never,
    runCoordinator: runCoordinator as never,
    recoveryRepository: recoveryRepository as never,
    runRepository: runRepository as never,
    decisionRepository: decisionRepository as never,
    foundationRepository: foundationRepository as never,
    strategyPackRepository: {
      resolveActiveForNewRun: vi.fn().mockReturnValue({
        datasetId: 'm45-empty-authorized',
        datasetVersion: 1,
      }),
      read: vi.fn(input.strategyPackRead ?? (() => ({}))),
    },
    runEventPort,
  } as never)
  return {
    coordinator,
    recovered,
    sql,
    persistedBatches,
    runRepository,
    decisionRepository,
    foundationRepository,
    runEventPort,
    runCoordinator,
    recoveryRepository,
  }
}

describe('SessionAgentCoordinator M4.8 settlement', () => {
  test('re-reads an idle AI turn and atomically starts its canonical initial Run', async () => {
    const {
      coordinator,
      recovered,
      runCoordinator,
      recoveryRepository,
      persistedBatches,
    } = createCoordinator()
    const initialRun = createRun({
      lifecycle: 'queued',
      leaseOwner: null,
      leaseExpiresAt: null,
      fencingToken: 0,
      startedAt: null,
    })
    recoveryRepository.recoverSessionForMutation.mockResolvedValue(
      Object.freeze({
        ...recovered,
        session: Object.freeze({
          ...recovered.session,
          agentRunState: 'idle' as const,
          activePlayerRunId: null,
          activeDecisionRequestId: null,
        }),
      }),
    )
    runCoordinator.createOrReuse.mockResolvedValue({
      kind: 'created',
      run: initialRun,
      committedEffects: [],
    })

    await expect(
      coordinator.reconcileCurrentTurn({
        sessionId,
        trigger: 'sessionCommitted',
        observedAt: settledAt,
      }),
    ).resolves.toEqual({ kind: 'started', runId })

    expect(runCoordinator.createOrReuse).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runtimeType: 'player',
        triggerType: 'action_required',
        idempotencyKey: `player-initial:${sessionId}:7:${actorParticipantId}`,
        dataDependencies: [
          { id: 'strategy-pack/m45-empty-authorized', version: 1 },
        ],
      }),
    )
    expect(persistedBatches).toHaveLength(1)
  })

  test('pauses an otherwise-current authority when its execution deadline is exhausted', async () => {
    const run = createRun({ deadlineAt: settledAt })
    const { coordinator, runRepository, runEventPort } = createCoordinator({
      run,
    })

    await expect(
      coordinator.pauseAfterFailure({
        sessionId,
        agentRunId: runId,
        decisionRequestId,
        authority: authority(),
        reason: 'execution_deadline_exhausted',
        settledAt,
      }),
    ).resolves.toMatchObject({
      kind: 'paused',
      effects: {
        runEffects: [
          {
            runId,
            event: { kind: 'failed', runId },
          },
        ],
      },
    })
    expect(runRepository.terminateForCoordination).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        lifecycle: 'failed',
        terminationReason: 'execution_deadline_exhausted',
      }),
    )
    expect(runEventPort.publish).toHaveBeenCalledWith([
      { runtimeType: 'player', kind: 'failed', runId },
    ])
  })

  test('pauses a final provider failure that settles at the execution deadline', async () => {
    const run = createRun({ deadlineAt: settledAt })
    const { coordinator, runRepository } = createCoordinator({ run })

    await expect(
      coordinator.pauseAfterFailure({
        sessionId,
        agentRunId: runId,
        decisionRequestId,
        authority: authority(),
        reason: 'provider_timeout',
        settledAt,
      }),
    ).resolves.toMatchObject({ kind: 'paused' })
    expect(runRepository.terminateForCoordination).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        lifecycle: 'failed',
        terminationReason: 'provider_timeout',
      }),
    )
  })

  test('records the correction Attempt and its strict repair event in one coordinator transaction', async () => {
    const { coordinator, persistedBatches, foundationRepository } =
      createCoordinator()

    await expect(
      coordinator.startCorrectionAttempt({
        sessionId,
        agentRunId: runId,
        decisionRequestId,
        authority: authority(),
        attemptAt: settledAt,
        stage: 'player.bounded-choice',
        provider: 'deepseek',
        model: 'deepseek-chat',
        attemptType: 'correction',
        routingReasonCode: 'content_correction',
        estimatedInputTokens: 10,
        requestedMaximumOutputTokens: 20,
        reservedCostMicrounits: 30,
        requestProjectionHash: 'a'.repeat(64),
      }),
    ).resolves.toMatchObject({ kind: 'started', attemptId })

    expect(
      foundationRepository.startBudgetedAgentAttemptAudit,
    ).toHaveBeenCalledTimes(1)
    expect(
      Object.keys(
        foundationRepository.startBudgetedAgentAttemptAudit.mock.calls[0]![3],
      ).sort(),
    ).toEqual([
      'agentRunId',
      'attemptType',
      'estimatedInputTokens',
      'model',
      'provider',
      'requestProjectionHash',
      'requestedMaximumOutputTokens',
      'reservedCostMicrounits',
      'routingReasonCode',
      'sessionId',
      'stage',
    ])
    expect(persistedBatches).toHaveLength(1)
    expect(persistedBatches[0]).toMatchObject({
      events: [
        {
          privateEvent: {
            payload: {
              event: {
                type: 'agentRepairAttempted',
                agentRunId: runId,
                decisionRequestId,
                actorSeatNumber: 3,
                attemptId,
                repairOrdinal: 1,
              },
            },
          },
        },
      ],
    })
  })

  test.each(['missing', 'revoked'] as const)(
    'pauses instead of creating a replacement when the pinned StrategyPack is %s',
    async (reason) => {
      const { coordinator, runRepository } = createCoordinator({
        strategyPackRead: () => {
          throw new StrategyPackUnavailableError(reason)
        },
      })

      await expect(
        coordinator.reconcileStale({
          sessionId,
          agentRunId: runId,
          decisionRequestId,
          authority: authority(),
          replacementRunId,
          replacementDecisionRequestId,
          replacementIdempotencyKey: `replacement-${reason}`,
          settledAt,
          reason: 'player_commit_decision_stale',
        } as never),
      ).resolves.toMatchObject({ kind: 'paused' })
      expect(runRepository.createOrReuse).not.toHaveBeenCalled()
    },
  )

  test('projects process-restart recovery to the frozen public union', async () => {
    const { coordinator, recovered, sql } = createCoordinator()

    const result = await coordinator.recoverAfterProcessRestart(sql as never, {
      owner: {} as never,
      recovery: recovered,
      recoveryAt: settledAt,
    })

    expect(
      PlayerProcessRestartRecoveryResultSchema.parse(result),
    ).toMatchObject({
      kind: 'replacementQueued',
    })
    expect('runEffects' in result).toBe(false)
  })

  test('keeps restart Run effects outside the frozen projection until the outer transaction commits', async () => {
    const { coordinator, recovered, runEventPort, sql } = createCoordinator()

    const transactionResult =
      await coordinator.recoverAfterProcessRestartWithEffects(sql as never, {
        owner: {} as never,
        recovery: recovered,
        recoveryAt: settledAt,
      })

    expect(
      PlayerProcessRestartRecoveryResultSchema.parse(
        transactionResult.recovery,
      ),
    ).toMatchObject({ kind: 'replacementQueued' })
    expect(transactionResult.runEffects).toMatchObject([
      { event: { kind: 'cancelled', runId } },
      { event: { kind: 'queued', runId: replacementRunId } },
    ])
    expect(runEventPort.publish).not.toHaveBeenCalled()

    await coordinator.publishCommittedRestartRunEffects(
      transactionResult.runEffects,
    )

    expect(runEventPort.publish).toHaveBeenCalledWith([
      { runtimeType: 'player', kind: 'cancelled', runId },
      { runtimeType: 'player', kind: 'queued', runId: replacementRunId },
    ])
  })

  test('preserves the stale reason and publishes both terminal and queued Run effects', async () => {
    const { coordinator, decisionRepository, runRepository, runEventPort } =
      createCoordinator()

    await expect(
      coordinator.reconcileStale({
        sessionId,
        agentRunId: runId,
        decisionRequestId,
        authority: authority(),
        replacementRunId,
        replacementDecisionRequestId,
        replacementIdempotencyKey: 'stale-replacement',
        settledAt,
        reason: 'player_commit_decision_stale',
      } as never),
    ).resolves.toMatchObject({
      kind: 'replacementQueued',
      effects: {
        runEffects: [
          { event: { kind: 'stale', runId } },
          { event: { kind: 'queued', runId: replacementRunId } },
        ],
      },
    })
    expect(decisionRepository.markTerminalForCoordination).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ reason: 'player_commit_decision_stale' }),
    )
    expect(runRepository.terminateForCoordination).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        lifecycle: 'stale',
        terminationReason: 'player_commit_decision_stale',
      }),
    )
    expect(runEventPort.publish).toHaveBeenCalledWith([
      { runtimeType: 'player', kind: 'stale', runId },
      { runtimeType: 'player', kind: 'queued', runId: replacementRunId },
    ])
  })
})
