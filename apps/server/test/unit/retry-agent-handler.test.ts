import { describe, expect, test, vi } from 'vitest'
import type { PersistedAgentRun } from '../../src/agents/foundation/agent-run-types.js'
import { createRunConfigurationSnapshot } from '../../src/agents/foundation/agent-run-coordinator.js'
import { playerRuntimeDefinition } from '../../src/agents/player/foundation-definition.js'
import { createRetryAgentHandlerBinding } from '../../src/agents/player/retry-agent-handler.js'
import { encodeStrategyPackAuditReference } from '../../src/agents/player/player-strategy-pack-audit-reference.js'
import { StrategyPackUnavailableError } from '../../src/poker-strategy/strategy-pack-repository.js'
import { createPrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'
import { createTestBettingPokerState } from '../poker/create-test-poker-state.js'

const sessionId = '20000000-0000-4000-8000-000000000001'
const commandId = '30000000-0000-4000-8000-000000000001'
const handId = '10000000-0000-4000-8000-000000000001'
const predecessorRunId = '40000000-0000-4000-8000-000000000001'
const replacementRunId = '40000000-0000-4000-8000-000000000002'
const requestId = '50000000-0000-4000-8000-000000000001'
const strategyDependencies = [
  encodeStrategyPackAuditReference({
    datasetId: 'm45-empty-authorized',
    datasetVersion: 1,
  }),
]
const strategyPackRepository = {
  resolveActiveForNewRun: vi.fn(),
  read: vi.fn().mockReturnValue({}),
}

const predecessor = Object.freeze({
  runId: predecessorRunId,
  runtimeType: 'player',
  sessionId,
  handId,
  participantId: '00000000-0000-4000-8000-000000000002',
  sourceStateVersion: 7,
  lifecycle: 'failed',
  replacementRunId: null,
  runtimeDefinitionVersion: 1,
  runConfiguration: createRunConfigurationSnapshot(
    playerRuntimeDefinition,
    strategyDependencies,
  ),
}) as unknown as PersistedAgentRun<'player'>

function state() {
  const poker = createTestBettingPokerState({
    hand: { currentActorSeatNumber: 1 },
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

function session() {
  return {
    sessionId,
    lifecycleStatus: 'active' as const,
    endedAt: null,
    stateVersion: 7,
    nextEventSeq: 8,
    currentHandId: handId,
    diagnosticCode: null,
    diagnosedAt: null,
    agentRunState: 'paused' as const,
    activePlayerRunId: null,
    activeDecisionRequestId: null,
  }
}

describe('retryAgent handler', () => {
  test('binds the paused AI turn to one superseding run without changing poker state', async () => {
    const binding = createRetryAgentHandlerBinding({
      owner: {} as never,
      registry: {
        resolveExact: vi.fn().mockReturnValue(playerRuntimeDefinition),
      } as never,
      strategyPackRepository,
      nextRunId: () => replacementRunId,
      nextDecisionRequestId: () => requestId,
    })
    const loadFailedPlayerLeafForRetry = vi.fn().mockResolvedValue(predecessor)
    const prepared = await binding.handler.prepare({
      command: {
        sessionId,
        commandId,
        expectedStateVersion: 7,
        type: 'retryAgent',
        payload: {},
      },
      state: state(),
      session: session(),
      reads: { loadFailedPlayerLeafForRetry },
    })

    expect(loadFailedPlayerLeafForRetry).toHaveBeenCalledWith({
      sessionId,
      handId,
      participantId: predecessor.participantId,
      sourceStateVersion: 7,
    })
    expect(prepared).toMatchObject({
      kind: 'prepared',
      mutation: {
        stateEffect: { kind: 'stateUnchanged' },
        playerCoordinationAfter: {
          agentRunState: 'thinking',
          activePlayerRunId: replacementRunId,
          activeDecisionRequestId: requestId,
        },
        privateEventDrafts: [
          {
            type: 'agentStarted',
            trigger: 'manualRetry',
            supersedesRunId: predecessorRunId,
          },
        ],
      },
    })
  })

  test('rejects retry when no matching failed player leaf remains', async () => {
    const binding = createRetryAgentHandlerBinding({
      owner: {} as never,
      registry: { resolveExact: vi.fn() } as never,
      strategyPackRepository,
      nextRunId: () => replacementRunId,
      nextDecisionRequestId: () => requestId,
    })

    await expect(
      binding.handler.prepare({
        command: {
          sessionId,
          commandId,
          expectedStateVersion: 7,
          type: 'retryAgent',
          payload: {},
        },
        state: state(),
        session: session(),
        reads: {
          loadFailedPlayerLeafForRetry: vi.fn().mockResolvedValue(null),
        },
      }),
    ).resolves.toEqual({
      kind: 'rejected',
      rejection: { kind: 'agentRetryNotAllowed' },
    })
  })

  test('keeps commandAt outside the strict relation plan while writing its replacement', async () => {
    const budget = Object.freeze({ maxWallClockMs: 120_000 })
    const completePredecessor = Object.freeze({
      ...predecessor,
      budget,
    }) as PersistedAgentRun<'player'>
    const replacement = Object.freeze({
      ...completePredecessor,
      runId: replacementRunId,
      decisionRequestId: requestId,
      parentRunId: predecessorRunId,
    }) as PersistedAgentRun<'player'>
    const runRepository = {
      lockPlayerRunForCoordination: vi
        .fn()
        .mockResolvedValue(completePredecessor),
      createOrReuse: vi.fn().mockResolvedValue({
        kind: 'created',
        run: replacement,
      }),
      linkReplacement: vi.fn().mockResolvedValue(undefined),
    }
    const binding = createRetryAgentHandlerBinding({
      owner: {} as never,
      registry: {
        resolveExact: vi.fn().mockReturnValue(playerRuntimeDefinition),
      } as never,
      strategyPackRepository,
      nextRunId: () => replacementRunId,
      nextDecisionRequestId: () => requestId,
      runRepository: runRepository as never,
    })
    const writes = binding.bindWritePort({} as never)

    await expect(
      writes.createManualRetryReplacement({
        kind: 'retryAgent',
        sessionId,
        handId,
        actorParticipantId: predecessor.participantId,
        sourceStateVersion: 7,
        predecessorRunId,
        agentRunId: replacementRunId,
        decisionRequestId: requestId,
        idempotencyKey: 'retry-agent:test',
        commandAt: '2026-08-28T00:00:00.000Z',
      }),
    ).resolves.toBe(replacement)

    expect(runRepository.createOrReuse).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        agentRunId: replacementRunId,
        createdAt: '2026-08-28T00:00:00.000Z',
        deadlineAt: '2026-08-28T00:02:00.000Z',
      }),
    )
    expect(runRepository.linkReplacement).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      {
        predecessorRunId,
        replacementRunId,
      },
    )
  })

  test('rejects retry when the predecessor pinned StrategyPack is unavailable', async () => {
    const binding = createRetryAgentHandlerBinding({
      owner: {} as never,
      registry: {
        resolveExact: vi.fn().mockReturnValue(playerRuntimeDefinition),
      } as never,
      strategyPackRepository: {
        resolveActiveForNewRun: vi.fn(),
        read: () => {
          throw new StrategyPackUnavailableError('revoked')
        },
      },
      nextRunId: () => replacementRunId,
      nextDecisionRequestId: () => requestId,
    })

    await expect(
      binding.handler.prepare({
        command: {
          sessionId,
          commandId,
          expectedStateVersion: 7,
          type: 'retryAgent',
          payload: {},
        },
        state: state(),
        session: session(),
        reads: {
          loadFailedPlayerLeafForRetry: vi.fn().mockResolvedValue(predecessor),
        },
      }),
    ).resolves.toEqual({
      kind: 'rejected',
      rejection: { kind: 'agentRetryNotAllowed' },
    })
  })
})
