import { describe, expect, test, vi } from 'vitest'
import { getLegalActions } from '../../src/poker/betting.js'
import { startPokerHand } from '../../src/poker/poker-engine.js'
import { createPokerTableState } from '../../src/poker/state.js'
import { createPrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'
import {
  createAiActionHandlerBinding,
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

function aiCommand(action: unknown, actorSeatNumber = 1) {
  return {
    sessionId,
    commandId,
    expectedStateVersion: 7,
    type: 'aiAction' as const,
    payload: {
      decisionRequestId: '50000000-0000-4000-8000-000000000001',
      handId,
      actorSeatNumber,
      candidateActionId: 'candidate-fold',
      action,
    },
  }
}

function binding() {
  return createPlayerActionHandlerBinding({ owner: {} as never })
}

function aiBinding() {
  return createAiActionHandlerBinding({ owner: {} as never })
}

function thinkingSession() {
  return session({
    agentRunState: 'thinking',
    activePlayerRunId: '40000000-0000-4000-8000-000000000001',
    activeDecisionRequestId: '50000000-0000-4000-8000-000000000001',
  })
}

function aiPokerState(actorSeatNumber: number, currentBet = 20) {
  const baseline = createTestBettingPokerState()
  const isPostflopCheckOrBet = currentBet === 0
  const extraSeats = [6, 7, 8].map((seatNumber) => ({
    seatNumber,
    playerId: `00000000-0000-4000-8000-${String(seatNumber + 1).padStart(12, '0')}`,
    isUser: false,
    stack: 2_000,
    status: 'active' as const,
    streetContribution: 0,
    totalContribution: 0,
  }))
  const hand = baseline.hand
  if (hand === null) throw new Error('AI action test requires a hand.')
  const bettingRound = hand.bettingRound
  if (bettingRound === null) throw new Error('AI action test requires betting.')
  return createPokerTableState({
    ...baseline,
    seats: [
      ...baseline.seats.map((seat) =>
        isPostflopCheckOrBet ? { ...seat, streetContribution: 0 } : seat,
      ),
      ...extraSeats,
    ],
    hand: {
      ...hand,
      street: isPostflopCheckOrBet ? 'flop' : hand.street,
      board: isPostflopCheckOrBet
        ? [
            { rank: 'A', suit: 'hearts' },
            { rank: 'K', suit: 'diamonds' },
            { rank: 'Q', suit: 'clubs' },
          ]
        : hand.board,
      holeCards: [
        ...hand.holeCards,
        ...[
          ['2', '3'],
          ['4', '5'],
          ['6', '7'],
        ].map(([firstRank, secondRank], index) => ({
          seatNumber: index + 6,
          cards: [
            { rank: firstRank as '2' | '4' | '6', suit: 'clubs' as const },
            { rank: secondRank as '3' | '5' | '7', suit: 'clubs' as const },
          ],
        })),
      ],
      currentActorSeatNumber: actorSeatNumber,
      bettingRound: {
        ...bettingRound,
        currentBet,
        seatStates: [
          ...bettingRound.seatStates,
          ...[6, 7, 8].map((seatNumber) => ({
            seatNumber,
            betLevelAfterLastAction: null,
          })),
        ],
      },
    },
  })
}

function pokerActionFromLegalAction(
  action: ReturnType<typeof getLegalActions>[number],
) {
  switch (action.type) {
    case 'bet':
    case 'raise':
      return {
        type: action.type,
        targetStreetCommitment: action.minTarget,
      }
    case 'fold':
    case 'check':
    case 'call':
    case 'allIn':
      return { type: action.type }
  }
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

  test('uses the same action core for an authenticated AI seat and clears coordination', async () => {
    const poker = createTestBettingPokerState({
      hand: { currentActorSeatNumber: 1 },
    })
    const prepared = await aiBinding().handler.prepare({
      command: aiCommand({ type: 'fold' }) as never,
      state: privateState(poker),
      session: session({
        agentRunState: 'thinking',
        activePlayerRunId: '40000000-0000-4000-8000-000000000001',
        activeDecisionRequestId: '50000000-0000-4000-8000-000000000001',
      }) as never,
      reads: {},
    })

    expect(prepared).toMatchObject({
      kind: 'prepared',
      mutation: {
        stateEffect: { kind: 'stateChanged' },
        currentHandIdAfter: handId,
        playerCoordinationAfter: {
          agentRunState: 'idle',
          activePlayerRunId: null,
          activeDecisionRequestId: null,
        },
        privateEventDrafts: [{ type: 'actionCommitted', actorSeatNumber: 1 }],
        relationPlan: { kind: 'continueHand', handId },
      },
    })
  })

  test('accepts every AI seat and every legal action family through the shared core', async () => {
    for (const actorSeatNumber of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const poker = aiPokerState(actorSeatNumber)
      const fold = getLegalActions(poker).find(({ type }) => type === 'fold')
      if (fold === undefined) throw new Error('AI seat test requires fold.')
      await expect(
        aiBinding().handler.prepare({
          command: aiCommand(
            pokerActionFromLegalAction(fold),
            actorSeatNumber,
          ) as never,
          state: privateState(poker),
          session: thinkingSession() as never,
          reads: {},
        }),
      ).resolves.toMatchObject({
        kind: 'prepared',
        mutation: {
          privateEventDrafts: [{ type: 'actionCommitted', actorSeatNumber }],
        },
      })
    }

    for (const { actorSeatNumber, poker, actionType } of [
      { actorSeatNumber: 1, poker: aiPokerState(1), actionType: 'fold' },
      { actorSeatNumber: 2, poker: aiPokerState(2), actionType: 'check' },
      { actorSeatNumber: 3, poker: aiPokerState(3), actionType: 'call' },
      { actorSeatNumber: 4, poker: aiPokerState(4), actionType: 'raise' },
      { actorSeatNumber: 5, poker: aiPokerState(5), actionType: 'allIn' },
      { actorSeatNumber: 6, poker: aiPokerState(6, 0), actionType: 'bet' },
    ] as const) {
      const action = getLegalActions(poker).find(
        ({ type }) => type === actionType,
      )
      if (action === undefined) {
        throw new Error(`AI action test requires ${actionType}.`)
      }
      await expect(
        aiBinding().handler.prepare({
          command: aiCommand(
            pokerActionFromLegalAction(action),
            actorSeatNumber,
          ) as never,
          state: privateState(poker),
          session: thinkingSession() as never,
          reads: {},
        }),
      ).resolves.toMatchObject({ kind: 'prepared' })
    }
  })

  test('uses the same AI relation path when an action completes a hand', async () => {
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
          seat.seatNumber === 1 || seat.seatNumber === 2
            ? ('active' as const)
            : ('folded' as const),
      })),
      hand: { ...started.hand!, currentActorSeatNumber: 1 },
    })
    const prepared = await aiBinding().handler.prepare({
      command: aiCommand({ type: 'fold' }, 1) as never,
      state: privateState(poker),
      session: thinkingSession() as never,
      reads: {},
    })
    if (prepared.kind !== 'prepared')
      throw new Error('Expected AI preparation.')
    expect(prepared.mutation.relationPlan).toMatchObject({
      kind: 'completeHand',
      sessionId,
      handId,
    })
    const completeHand = vi.fn(async () => ({}))
    await aiBinding().handler.applyRelations(
      {
        writes: { completeHand } as never,
        commandAt: '2026-08-10T10:00:00.000Z',
      },
      { relationPlan: prepared.mutation.relationPlan } as never,
    )
    expect(completeHand).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId, handId }),
    )
  })

  test('treats an AI action that no longer matches its current turn as an internal failure', async () => {
    const poker = createTestBettingPokerState({
      hand: { currentActorSeatNumber: 2 },
    })
    await expect(
      aiBinding().handler.prepare({
        command: aiCommand({ type: 'fold' }) as never,
        state: privateState(poker),
        session: session({
          agentRunState: 'thinking',
          activePlayerRunId: '40000000-0000-4000-8000-000000000001',
          activeDecisionRequestId: '50000000-0000-4000-8000-000000000001',
        }) as never,
        reads: {},
      }),
    ).rejects.toBeInstanceOf(PlayerActionHandlerInvariantError)
  })
})
