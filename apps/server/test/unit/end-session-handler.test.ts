import type { Sql } from 'postgres'
import { describe, expect, test, vi } from 'vitest'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import { startPokerHand } from '../../src/poker/poker-engine.js'
import { POKER_RULE_SET_VERSION } from '../../src/poker/poker-rule-set.js'
import { createPokerTableState } from '../../src/poker/state.js'
import { createPrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'
import { createEndSessionHandlerBinding } from '../../src/sessions/command-execution/end-session-handler.js'
import { createHandStartCheckpoint } from '../../src/sessions/hand-audit/hand-start-checkpoint.js'
import { createTestCompletedPokerResult } from '../poker/create-test-completed-poker-result.js'
import { createTestPokerState } from '../poker/create-test-poker-state.js'

const sessionId = '20000000-0000-4000-8000-000000000001'
const handId = '10000000-0000-4000-8000-000000000009'
const commandId = '30000000-0000-4000-8000-000000000001'
const failedPlayerRunId = '70000000-0000-4000-8000-000000000001'
const databaseOwnerId = '11111111-1111-4111-8111-111111111111'
const command = Object.freeze({
  sessionId,
  commandId,
  expectedStateVersion: 7,
  type: 'endSession' as const,
  payload: Object.freeze({}),
})
const idleSession = Object.freeze({
  sessionId,
  lifecycleStatus: 'active' as const,
  endedAt: null,
  stateVersion: 7,
  nextEventSeq: 4,
  currentHandId: null,
  diagnosticCode: null,
  diagnosedAt: null,
  agentRunState: 'idle' as const,
  activePlayerRunId: null,
  activeDecisionRequestId: null,
})

async function owner() {
  const sql = (() => Promise.resolve([{ databaseOwnerId }])) as unknown as Sql
  return resolveOwnerScope(sql, { ownerId: 'local-user' })
}

function betweenHandsState(stateVersion = 7) {
  const poker = createTestPokerState()
  return createPrivateTableState({
    stateVersion,
    poker,
    completedHandCount: 1,
    seatAccounting: poker.seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      cumulativeBuyIn: 2_000,
    })),
    lastCompletedHandSummary:
      createTestCompletedPokerResult().completedHand.summary,
  })
}

function pausedFixture() {
  const restored = betweenHandsState(6)
  const started = startPokerHand(restored.poker, {
    handId,
    completedHandCountBeforeStart: restored.completedHandCount,
    randomSource: { nextInt: () => 0 },
  })
  const poker = createPokerTableState({
    ...started.state,
    hand: { ...started.state.hand!, currentActorSeatNumber: 1 },
  })
  const current = createPrivateTableState({
    stateVersion: 7,
    poker,
    completedHandCount: restored.completedHandCount,
    seatAccounting: restored.seatAccounting,
    lastCompletedHandSummary: restored.lastCompletedHandSummary,
  })
  const checkpoint = createHandStartCheckpoint({
    pokerRuleSetVersion: POKER_RULE_SET_VERSION,
    stateBeforeStartCommand: restored,
    startedHand: started.startedHand,
  })
  return { restored, current, checkpoint }
}

function withReversedPokerSeats(
  state: ReturnType<typeof createPrivateTableState>,
) {
  return createPrivateTableState({
    ...state,
    poker: createPokerTableState({
      ...state.poker,
      seats: [...state.poker.seats].reverse(),
    }),
  })
}

describe('end session handler', () => {
  test('normal end preserves private state and performs no relation write', async () => {
    const binding = createEndSessionHandlerBinding({ owner: await owner() })
    const state = betweenHandsState()
    const prepared = await binding.handler.prepare({
      command,
      state,
      session: idleSession,
      reads: {} as never,
    })

    expect(prepared).toEqual({
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
        relationPlan: { kind: 'normalEnd' },
      },
    })
    if (prepared.kind !== 'prepared') throw new Error('Expected prepared.')
    await expect(
      binding.handler.applyRelations(
        { writes: {} as never, commandAt: '2026-08-11T04:00:00.000Z' },
        { relationPlan: prepared.mutation.relationPlan } as never,
      ),
    ).resolves.toBeUndefined()
  })

  test('paused AI turn restores the checkpoint and aborts the exact failed run', async () => {
    const binding = createEndSessionHandlerBinding({ owner: await owner() })
    const { restored, current, checkpoint } = pausedFixture()
    const loadPausedAbortContext = vi.fn().mockResolvedValue({
      handId,
      checkpoint,
      failedPlayerRunId,
      failureReasonCode: 'provider_timeout',
    })
    const prepared = await binding.handler.prepare({
      command,
      state: current,
      session: {
        ...idleSession,
        currentHandId: handId,
        agentRunState: 'paused',
      },
      reads: { loadPausedAbortContext },
    })

    expect(loadPausedAbortContext).toHaveBeenCalledWith({
      sessionId,
      handId,
      actorParticipantId: current.poker.seats.find(
        (seat) => seat.seatNumber === 1,
      )?.playerId,
      sourceStateVersion: 7,
    })
    expect(prepared.kind).toBe('prepared')
    if (prepared.kind !== 'prepared') throw new Error('Expected prepared.')
    expect(prepared.mutation).toMatchObject({
      stateEffect: {
        kind: 'stateChanged',
        stateContent: {
          poker: restored.poker,
          completedHandCount: restored.completedHandCount,
          seatAccounting: restored.seatAccounting,
        },
      },
      lifecycleAfter: 'ended',
      currentHandIdAfter: null,
      privateEventDrafts: [
        { type: 'handAborted', handId },
        { type: 'sessionEnded', reason: 'handAborted' },
      ],
      relationPlan: {
        kind: 'abortHand',
        failedPlayerRunId,
        failureReasonCode: 'provider_timeout',
      },
    })

    const abortHand = vi.fn().mockResolvedValue({ checkpoint })
    await binding.handler.applyRelations(
      {
        writes: { abortHand } as never,
        commandAt: '2026-08-11T04:00:00.000Z',
      },
      { relationPlan: prepared.mutation.relationPlan } as never,
    )
    expect(abortHand).toHaveBeenCalledWith({
      sessionId,
      handId,
      failedAgentRunId: failedPlayerRunId,
      reasonCode: 'provider_timeout',
      abortedAt: '2026-08-11T04:00:00.000Z',
    })
  })

  test('sorts handAborted seat mirrors when authoritative poker seats are unordered', async () => {
    const binding = createEndSessionHandlerBinding({ owner: await owner() })
    const fixture = pausedFixture()
    const restored = withReversedPokerSeats(fixture.restored)
    const current = withReversedPokerSeats(fixture.current)
    const checkpoint = createHandStartCheckpoint({
      pokerRuleSetVersion: POKER_RULE_SET_VERSION,
      stateBeforeStartCommand: restored,
      startedHand: fixture.checkpoint.startedHand,
    })
    const prepared = await binding.handler.prepare({
      command,
      state: current,
      session: {
        ...idleSession,
        currentHandId: handId,
        agentRunState: 'paused',
      },
      reads: {
        loadPausedAbortContext: vi.fn().mockResolvedValue({
          handId,
          checkpoint,
          failedPlayerRunId,
          failureReasonCode: 'provider_timeout',
        }),
      },
    })

    expect(prepared.kind).toBe('prepared')
    if (prepared.kind !== 'prepared') throw new Error('Expected prepared.')
    const event = prepared.mutation.privateEventDrafts[0]
    expect(event?.type).toBe('handAborted')
    if (event?.type !== 'handAborted') throw new Error('Expected handAborted.')
    expect(event.beforeAbort.seats.map((seat) => seat.seatNumber)).toEqual([
      0, 1, 2, 3, 4, 5,
    ])
    expect(event.restored.seats.map((seat) => seat.seatNumber)).toEqual([
      0, 1, 2, 3, 4, 5,
    ])
  })

  test('in-hand idle or thinking state remains a stable phase rejection', async () => {
    const binding = createEndSessionHandlerBinding({ owner: await owner() })
    const { current } = pausedFixture()
    for (const agentRunState of ['idle', 'thinking'] as const) {
      const thinking = agentRunState === 'thinking'
      await expect(
        binding.handler.prepare({
          command,
          state: current,
          session: {
            ...idleSession,
            currentHandId: handId,
            agentRunState,
            activePlayerRunId: thinking ? failedPlayerRunId : null,
            activeDecisionRequestId: thinking
              ? '80000000-0000-4000-8000-000000000001'
              : null,
          },
          reads: {} as never,
        }),
      ).resolves.toEqual({
        kind: 'rejected',
        rejection: { kind: 'commandNotAllowedInPhase', phase: 'inHand' },
      })
    }
  })
})

test('带失败目标的中止拒绝旧 Run，且不能退化为普通结束', async () => {
  const binding = createEndSessionHandlerBinding({ owner: await owner() })
  const { current, checkpoint } = pausedFixture()
  const target = { ...command, payload: { expectedPausedRunId: commandId } }
  const reads = {
    loadPausedAbortContext: vi.fn(async () => ({
      handId,
      checkpoint,
      failedPlayerRunId,
      failureReasonCode: 'provider_timeout',
    })),
  }
  expect(
    await binding.handler.prepare({
      command: target,
      state: current,
      session: {
        ...idleSession,
        currentHandId: handId,
        agentRunState: 'paused',
      },
      reads,
    }),
  ).toEqual({ kind: 'rejected', rejection: { kind: 'pausedRunConflict' } })
  expect(
    await binding.handler.prepare({
      command: target,
      state: betweenHandsState(),
      session: idleSession,
      reads,
    }),
  ).toEqual({ kind: 'rejected', rejection: { kind: 'pausedRunConflict' } })
  expect(
    await binding.handler.prepare({
      command: {
        ...target,
        payload: { expectedPausedRunId: failedPlayerRunId },
      },
      state: current,
      session: {
        ...idleSession,
        currentHandId: handId,
        agentRunState: 'paused',
      },
      reads,
    }),
  ).toMatchObject({
    kind: 'prepared',
    mutation: { relationPlan: { kind: 'abortHand', failedPlayerRunId } },
  })
})
