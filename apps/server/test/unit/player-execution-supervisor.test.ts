import { afterEach, describe, expect, test, vi } from 'vitest'
import type { LeasedAgentRun } from '../../src/agents/foundation/agent-run-types.js'
import { PlayerRuntimeExecutionError } from '../../src/agents/player/player-runtime-executor.js'
import { createPlayerExecutionSupervisor } from '../../src/agents/player/player-execution-supervisor.js'

const RUN = Object.freeze({
  ownerId: 'local-user',
  runId: '00000000-0000-4000-8000-000000000001',
  runtimeType: 'player',
  sessionId: '00000000-0000-4000-8000-000000000002',
  handId: '00000000-0000-4000-8000-000000000003',
  triggerType: 'initial',
  lifecycle: 'running',
  idempotencyKey: 'test-run',
  parentRunId: null,
  replacementRunId: null,
  leaseOwner: 'player-test',
  leaseExpiresAt: '2026-08-28T00:01:00.000Z',
  fencingToken: 1,
  deadlineAt: '2026-08-28T00:02:00.000Z',
  runtimeDefinitionVersion: 1,
  terminationReason: null,
  runConfiguration: {},
  budget: {},
  createdAt: '2026-08-28T00:00:00.000Z',
  startedAt: '2026-08-28T00:00:00.000Z',
  completedAt: null,
  updatedAt: '2026-08-28T00:00:00.000Z',
  participantId: '00000000-0000-4000-8000-000000000004',
  sourceStateVersion: 7,
  decisionRequestId: '00000000-0000-4000-8000-000000000005',
}) as unknown as LeasedAgentRun<'player'>

const NO_EFFECTS = Object.freeze({
  sessionEvents: [],
  runEffects: [],
  queuedRunId: null,
})

afterEach(() => vi.restoreAllMocks())

describe('Player execution supervisor', () => {
  test.each([
    {
      error: new PlayerRuntimeExecutionError(
        'player_decision_dependency_missing',
      ),
      reason: 'player_dependency_unavailable',
    },
    {
      error: Object.assign(new Error('sensitive-message-marker'), {
        name: 'sensitive-name-marker',
        code: 'sensitive-code-marker',
        failure: 'sensitive-failure-marker',
      }),
      reason: 'player_internal_failure',
    },
  ])(
    'pauses with $reason and logs only the stable classification',
    async ({ error, reason }) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      const pauseAfterFailure = vi.fn().mockResolvedValue({
        kind: 'paused',
        effects: NO_EFFECTS,
      })
      const reconcileStale = vi.fn()
      const executor = {
        runtimeType: 'player' as const,
        execute: vi.fn().mockRejectedValue(error),
      }
      const supervisor = createPlayerExecutionSupervisor({
        executor,
        coordinator: {
          reconcileCurrentTurn: vi.fn(),
          pauseAfterFailure,
          reconcileStale,
          startIfNeeded: vi.fn(),
          startCorrectionAttempt: vi.fn(),
          recoverAfterProcessRestart: vi.fn(),
        },
        now: () => '2026-08-28T00:00:10.000Z',
      })

      await expect(
        supervisor.execute(RUN, new AbortController().signal),
      ).resolves.toBeUndefined()

      expect(pauseAfterFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: RUN.sessionId,
          agentRunId: RUN.runId,
          decisionRequestId: RUN.decisionRequestId,
          reason,
        }),
      )
      expect(reconcileStale).not.toHaveBeenCalled()
      expect(log).toHaveBeenCalledExactlyOnceWith(
        JSON.stringify({
          category: 'player_execution_failed',
          runId: RUN.runId,
          sessionId: RUN.sessionId,
          kind: 'finalFailure',
          reason,
        }),
      )
    },
  )

  test('keeps deferred persistence failures unsettled and sends stale failures to replacement reconciliation', async () => {
    const pauseAfterFailure = vi.fn()
    const reconcileStale = vi.fn().mockResolvedValue({
      kind: 'noTarget',
      effects: NO_EFFECTS,
    })
    const executor = {
      runtimeType: 'player' as const,
      execute: vi
        .fn()
        .mockRejectedValueOnce(
          new PlayerRuntimeExecutionError(
            'player_decision_persistence_rejected',
          ),
        )
        .mockRejectedValueOnce(
          new PlayerRuntimeExecutionError('player_decision_authority_lost'),
        ),
    }
    const supervisor = createPlayerExecutionSupervisor({
      executor,
      coordinator: {
        reconcileCurrentTurn: vi.fn(),
        pauseAfterFailure,
        reconcileStale,
        startIfNeeded: vi.fn(),
        startCorrectionAttempt: vi.fn(),
        recoverAfterProcessRestart: vi.fn(),
      },
      now: () => '2026-08-28T00:00:10.000Z',
      nextRunId: () => '00000000-0000-4000-8000-000000000006',
      nextDecisionRequestId: () => '00000000-0000-4000-8000-000000000007',
      nextIdempotencyKey: () => 'stale-replacement-test',
    })

    await supervisor.execute(RUN, new AbortController().signal)
    await supervisor.execute(RUN, new AbortController().signal)

    expect(pauseAfterFailure).not.toHaveBeenCalled()
    expect(reconcileStale).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'player_decision_authority_lost',
        replacementRunId: '00000000-0000-4000-8000-000000000006',
        replacementDecisionRequestId: '00000000-0000-4000-8000-000000000007',
        replacementIdempotencyKey: 'stale-replacement-test',
      }),
    )
  })
})
