import { describe, expect, test, vi } from 'vitest'
import { startPokerHand } from '../../src/poker/poker-engine.js'
import { createPokerTableState } from '../../src/poker/state.js'
import { createPrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'
import {
  createPlayerActionHandlerBinding,
  PlayerActionHandlerInvariantError,
} from '../../src/sessions/command-execution/player-action-handler.js'
import {
  createTestBettingPokerState,
  createTestPokerState,
} from '../poker/create-test-poker-state.js'

const sessionId = '20000000-0000-4000-8000-000000000001'
const commandId = '30000000-0000-4000-8000-000000000001'
const handId = '10000000-0000-4000-8000-000000000001'

function privateState(poker = createTestBettingPokerState()) {
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

function session(overrides: Record<string, unknown> = {}) {
  return {
    sessionId,
    lifecycleStatus: 'active' as const,
    endedAt: null,
    stateVersion: 7,
    nextEventSeq: 2,
    currentHandId: handId,
    diagnosticCode: null,
    diagnosedAt: null,
    agentRunState: 'idle' as const,
    activePlayerRunId: null,
    activeDecisionRequestId: null,
    ...overrides,
  }
}

function command(action: unknown) {
  return {
    sessionId,
    commandId,
    expectedStateVersion: 7,
    type: 'playerAction' as const,
    payload: { action },
  }
}

function binding() {
  return createPlayerActionHandlerBinding({ owner: {} as never })
}

describe('player action handler', () => {
  test('prepares one normal user action without a relation write', async () => {
    const poker = createTestBettingPokerState({
      hand: { currentActorSeatNumber: 0 },
    })
    const prepared = await binding().handler.prepare({
      command: command({ type: 'fold' }) as never,
      state: privateState(poker),
      session: session() as never,
      reads: {},
    })

    expect(prepared).toMatchObject({
      kind: 'prepared',
      mutation: {
        stateEffect: {
          kind: 'stateChanged',
          stateContent: {
            completedHandCount: 0,
            lastCompletedHandSummary: null,
          },
        },
        lifecycleAfter: 'active',
        currentHandIdAfter: handId,
        privateEventDrafts: [{ type: 'actionCommitted' }],
        relationPlan: { kind: 'continueHand', handId },
      },
    })
    if (prepared.kind !== 'prepared') throw new Error('Expected preparation.')
    expect(Object.isFrozen(prepared.mutation.relationPlan)).toBe(true)
    const completeHand = vi.fn()
    await binding().handler.applyRelations(
      {
        writes: { completeHand },
        commandAt: '2026-08-10T10:00:00.000Z',
      },
      { relationPlan: prepared.mutation.relationPlan } as never,
    )
    expect(completeHand).not.toHaveBeenCalled()
  })

  test('prepares terminal settlement and applies hand completion at commandAt', async () => {
    const started = startPokerHand(createTestPokerState(), {
      handId,
      completedHandCountBeforeStart: 0,
      randomSource: { nextInt: () => 0 },
    }).state
    const poker = createPokerTableState({
      ...started,
      seats: started.seats.map((seat) => ({
        ...seat,
        status:
          seat.seatNumber === 0 || seat.seatNumber === 2
            ? ('active' as const)
            : ('folded' as const),
      })),
      hand: { ...started.hand!, currentActorSeatNumber: 0 },
    })
    const prepared = await binding().handler.prepare({
      command: command({ type: 'fold' }) as never,
      state: privateState(poker),
      session: session() as never,
      reads: {},
    })

    expect(prepared).toMatchObject({
      kind: 'prepared',
      mutation: {
        stateEffect: {
          kind: 'stateChanged',
          stateContent: {
            poker: { pokerPhase: 'betweenHands', hand: null },
            completedHandCount: 1,
          },
        },
        currentHandIdAfter: null,
        privateEventDrafts: [
          { type: 'actionCommitted' },
          { type: 'uncalledBetReturned' },
          { type: 'handCompleted' },
        ],
        relationPlan: { kind: 'completeHand', sessionId, handId },
      },
    })
    if (prepared.kind !== 'prepared') throw new Error('Expected preparation.')
    const completeHand = vi.fn(async () => ({}))
    const commandAt = '2026-08-10T10:00:00.000Z'
    await binding().handler.applyRelations(
      { writes: { completeHand } as never, commandAt },
      { relationPlan: prepared.mutation.relationPlan } as never,
    )
    expect(completeHand).toHaveBeenCalledWith({
      sessionId,
      handId,
      result: expect.objectContaining({ handId }),
      completedAt: commandAt,
    })
  })

  test('returns stable phase, actor, action and target rejections', async () => {
    const handler = binding().handler
    const betweenHands = privateState(createTestPokerState())
    await expect(
      handler.prepare({
        command: command({ type: 'fold' }) as never,
        state: betweenHands,
        session: session({ currentHandId: null }) as never,
        reads: {},
      }),
    ).resolves.toMatchObject({
      kind: 'rejected',
      rejection: { kind: 'commandNotAllowedInPhase' },
    })

    const aiActorState = privateState()
    await expect(
      handler.prepare({
        command: command({ type: 'fold' }) as never,
        state: aiActorState,
        session: session({
          agentRunState: 'thinking',
          activePlayerRunId: '40000000-0000-4000-8000-000000000001',
          activeDecisionRequestId: '50000000-0000-4000-8000-000000000001',
        }) as never,
        reads: {},
      }),
    ).resolves.toMatchObject({
      kind: 'rejected',
      rejection: { kind: 'playerNotCurrentActor' },
    })

    const userPoker = createTestBettingPokerState({
      hand: { currentActorSeatNumber: 0 },
    })
    const userState = privateState(userPoker)
    await expect(
      handler.prepare({
        command: command({ type: 'check' }) as never,
        state: userState,
        session: session() as never,
        reads: {},
      }),
    ).resolves.toMatchObject({
      kind: 'rejected',
      rejection: { kind: 'pokerActionNotLegal' },
    })
    await expect(
      handler.prepare({
        command: command({
          type: 'raise',
          targetStreetCommitment: 39,
        }) as never,
        state: userState,
        session: session() as never,
        reads: {},
      }),
    ).resolves.toMatchObject({
      kind: 'rejected',
      rejection: { kind: 'pokerActionTargetOutOfRange' },
    })
  })

  test('treats pointer and user-turn coordination mismatches as internal failures', async () => {
    const poker = createTestBettingPokerState({
      hand: { currentActorSeatNumber: 0 },
    })
    const state = privateState(poker)
    await expect(
      binding().handler.prepare({
        command: command({ type: 'fold' }) as never,
        state,
        session: session({
          currentHandId: '10000000-0000-4000-8000-000000000002',
        }) as never,
        reads: {},
      }),
    ).rejects.toBeInstanceOf(PlayerActionHandlerInvariantError)
    await expect(
      binding().handler.prepare({
        command: command({ type: 'fold' }) as never,
        state,
        session: session({
          agentRunState: 'paused',
          activePlayerRunId: null,
          activeDecisionRequestId: null,
        }) as never,
        reads: {},
      }),
    ).rejects.toBeInstanceOf(PlayerActionHandlerInvariantError)
  })
})
