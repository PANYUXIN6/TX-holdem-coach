import { describe, expect, test } from 'vitest'
import {
  applyPokerAction,
  startPokerHand,
} from '../../src/poker/poker-engine.js'
import { POKER_RULE_SET_VERSION } from '../../src/poker/poker-rule-set.js'
import { createPrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'
import { isCommandMutationConsistent } from '../../src/sessions/command-execution/command-event-policy.js'
import {
  createTestBettingPokerState,
  createTestPokerState,
} from '../poker/create-test-poker-state.js'
import { createPokerTableState } from '../../src/poker/state.js'
import { createHandStartCheckpoint } from '../../src/sessions/hand-audit/hand-start-checkpoint.js'
import { createTestCompletedPokerResult } from '../poker/create-test-completed-poker-result.js'

const handId = '10000000-0000-4000-8000-000000000001'
const sessionId = '20000000-0000-4000-8000-000000000001'
const commandId = '30000000-0000-4000-8000-000000000001'
const randomSource = Object.freeze({ nextInt: () => 0 })
const idlePlayerCoordination = Object.freeze({
  agentRunState: 'idle' as const,
  activePlayerRunId: null,
  activeDecisionRequestId: null,
})
const activeIdleSession = Object.freeze({
  lifecycleStatus: 'active' as const,
  currentHandId: handId as string | null,
  ...idlePlayerCoordination,
})
const activeBetweenHandsSession = Object.freeze({
  ...activeIdleSession,
  currentHandId: null,
})

function privateState(
  stateVersion: number,
  poker: ReturnType<typeof createTestPokerState>,
  cumulativeBuyIns: readonly {
    readonly seatNumber: number
    readonly cumulativeBuyIn: number
  }[] = poker.seats.map((seat) => ({
    seatNumber: seat.seatNumber,
    cumulativeBuyIn: seat.stack,
  })),
) {
  return createPrivateTableState({
    stateVersion,
    poker,
    completedHandCount: 0,
    seatAccounting: cumulativeBuyIns,
    lastCompletedHandSummary: null,
  })
}

describe('command event policy', () => {
  test('accepts a mirrored normal playerAction and rejects plan tampering', () => {
    const beforePoker = createTestBettingPokerState({
      hand: { currentActorSeatNumber: 0 },
    })
    const accounting = beforePoker.seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      cumulativeBuyIn: 2_000,
    }))
    const before = privateState(7, beforePoker, accounting)
    const action = { type: 'fold' as const }
    const applied = applyPokerAction(beforePoker, {
      actorSeatNumber: 0,
      action,
    })
    const after = privateState(8, applied.state, accounting)
    const input = {
      command: {
        sessionId,
        commandId,
        expectedStateVersion: 7,
        type: 'playerAction' as const,
        payload: { action },
      },
      sessionBefore: activeIdleSession,
      stateEffectKind: 'stateChanged' as const,
      stateBefore: before,
      stateAfter: after,
      lifecycleAfter: 'active' as const,
      currentHandIdAfter: handId,
      playerCoordinationAfter: idlePlayerCoordination,
      events: applied.eventDrafts,
      relationPlan: Object.freeze({ kind: 'continueHand', handId }),
    }

    expect(isCommandMutationConsistent(input)).toBe(true)
    expect(
      isCommandMutationConsistent({
        ...input,
        playerCoordinationAfter: {
          ...idlePlayerCoordination,
          agentRunState: 'paused',
        },
      }),
    ).toBe(false)
    expect(
      isCommandMutationConsistent({
        ...input,
        relationPlan: Object.freeze({
          kind: 'continueHand',
          handId: '10000000-0000-4000-8000-000000000002',
        }),
      }),
    ).toBe(false)
  })

  test('rejects a playerAction whose event disguises an AI seat action as seat zero', () => {
    const beforePoker = createTestBettingPokerState({
      hand: { currentActorSeatNumber: 3 },
    })
    const accounting = beforePoker.seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      cumulativeBuyIn: 2_000,
    }))
    const before = privateState(7, beforePoker, accounting)
    const action = { type: 'fold' as const }
    const applied = applyPokerAction(beforePoker, {
      actorSeatNumber: 3,
      action,
    })
    const actionEvent = applied.eventDrafts[0]
    if (actionEvent?.type !== 'actionCommitted') {
      throw new Error('Expected action-committed event.')
    }

    expect(
      isCommandMutationConsistent({
        command: {
          sessionId,
          commandId,
          expectedStateVersion: 7,
          type: 'playerAction',
          payload: { action },
        },
        sessionBefore: activeIdleSession,
        stateEffectKind: 'stateChanged',
        stateBefore: before,
        stateAfter: privateState(8, applied.state, accounting),
        lifecycleAfter: 'active',
        currentHandIdAfter: handId,
        playerCoordinationAfter: idlePlayerCoordination,
        events: [
          {
            ...actionEvent,
            actorSeatNumber: 0,
            command: { actorSeatNumber: 0, action },
          },
        ],
        relationPlan: Object.freeze({ kind: 'continueHand', handId }),
      }),
    ).toBe(false)
  })

  test('accepts a mirrored aiAction only while the matching Player run is thinking', () => {
    const beforePoker = createTestBettingPokerState({
      hand: { currentActorSeatNumber: 1 },
    })
    const accounting = beforePoker.seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      cumulativeBuyIn: 2_000,
    }))
    const before = privateState(7, beforePoker, accounting)
    const action = { type: 'fold' as const }
    const applied = applyPokerAction(beforePoker, {
      actorSeatNumber: 1,
      action,
    })
    const thinkingSession = {
      lifecycleStatus: 'active' as const,
      currentHandId: handId,
      agentRunState: 'thinking' as const,
      activePlayerRunId: '40000000-0000-4000-8000-000000000001',
      activeDecisionRequestId: '50000000-0000-4000-8000-000000000001',
    }
    const input = {
      command: {
        sessionId,
        commandId,
        expectedStateVersion: 7,
        type: 'aiAction' as const,
        payload: {
          decisionRequestId: thinkingSession.activeDecisionRequestId,
          handId,
          actorSeatNumber: 1,
          candidateActionId: 'candidate-fold',
          action,
        },
      },
      sessionBefore: thinkingSession,
      stateEffectKind: 'stateChanged' as const,
      stateBefore: before,
      stateAfter: privateState(8, applied.state, accounting),
      lifecycleAfter: 'active' as const,
      currentHandIdAfter: handId,
      playerCoordinationAfter: idlePlayerCoordination,
      events: applied.eventDrafts,
      relationPlan: Object.freeze({ kind: 'continueHand' as const, handId }),
    }

    expect(isCommandMutationConsistent(input)).toBe(true)
    expect(
      isCommandMutationConsistent({
        ...input,
        sessionBefore: activeIdleSession,
      }),
    ).toBe(false)
  })

  test('accepts a mirrored terminal playerAction and rejects summary tampering', () => {
    const started = startPokerHand(createTestPokerState(), {
      handId,
      completedHandCountBeforeStart: 0,
      randomSource,
    }).state
    const beforePoker = createPokerTableState({
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
    const accounting = beforePoker.seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      cumulativeBuyIn: 2_000,
    }))
    const before = privateState(7, beforePoker, accounting)
    const action = { type: 'fold' as const }
    const applied = applyPokerAction(beforePoker, {
      actorSeatNumber: 0,
      action,
    })
    const completedHand = applied.completedHand
    if (completedHand === null) throw new Error('Expected completed hand.')
    const completionEvent = applied.eventDrafts.at(-1)
    if (completionEvent?.type !== 'handCompleted') {
      throw new Error('Expected hand-completed event.')
    }
    const actionEvent = applied.eventDrafts[0]
    if (actionEvent?.type !== 'actionCommitted') {
      throw new Error('Expected action-committed event.')
    }
    const after = createPrivateTableState({
      stateVersion: 8,
      poker: applied.state,
      completedHandCount: 1,
      seatAccounting: accounting,
      lastCompletedHandSummary: completedHand.summary,
    })
    const input = {
      command: {
        sessionId,
        commandId,
        expectedStateVersion: 7,
        type: 'playerAction' as const,
        payload: { action },
      },
      sessionBefore: activeIdleSession,
      stateEffectKind: 'stateChanged' as const,
      stateBefore: before,
      stateAfter: after,
      lifecycleAfter: 'active' as const,
      currentHandIdAfter: null,
      playerCoordinationAfter: idlePlayerCoordination,
      events: applied.eventDrafts,
      relationPlan: Object.freeze({
        kind: 'completeHand' as const,
        sessionId,
        handId,
        result: completedHand,
      }),
    }

    expect(isCommandMutationConsistent(input)).toBe(true)
    expect(
      isCommandMutationConsistent({
        ...input,
        events: [
          ...applied.eventDrafts.slice(0, -1),
          {
            ...completionEvent,
            handId: '10000000-0000-4000-8000-000000000002',
          },
        ],
      }),
    ).toBe(false)
    expect(
      isCommandMutationConsistent({
        ...input,
        events: [
          {
            ...actionEvent,
            after: { ...actionEvent.after, pot: actionEvent.after.pot + 1 },
          },
          ...applied.eventDrafts.slice(1),
        ],
      }),
    ).toBe(false)
  })

  test('accepts a mirrored startNextHand and rejects plan or event tampering', () => {
    const beforePoker = createTestPokerState({
      seats: createTestPokerState().seats.map((seat) =>
        seat.seatNumber === 1
          ? { ...seat, stack: 0, status: 'out' as const }
          : seat.seatNumber === 2
            ? { ...seat, stack: 4_000 }
            : seat,
      ),
    })
    const accountingBefore = beforePoker.seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      cumulativeBuyIn: 2_000,
    }))
    const lastCompletedHandSummary =
      createTestCompletedPokerResult().completedHand.summary
    const before = createPrivateTableState({
      stateVersion: 7,
      poker: beforePoker,
      completedHandCount: 1,
      seatAccounting: accountingBefore,
      lastCompletedHandSummary,
    })
    const afterRebuyPoker = createTestPokerState({
      ...beforePoker,
      seats: beforePoker.seats.map((seat) =>
        seat.seatNumber === 1
          ? { ...seat, stack: 2_000, status: 'active' as const }
          : seat,
      ),
    })
    const started = startPokerHand(afterRebuyPoker, {
      handId,
      completedHandCountBeforeStart: 1,
      randomSource,
    })
    const after = createPrivateTableState({
      stateVersion: 8,
      poker: started.state,
      completedHandCount: 1,
      seatAccounting: before.seatAccounting.map((seat) =>
        seat.seatNumber === 1 ? { ...seat, cumulativeBuyIn: 4_000 } : seat,
      ),
      lastCompletedHandSummary,
    })
    const events = [
      {
        type: 'aiAutoRebuy' as const,
        seatNumber: 1,
        amount: 2_000 as const,
        stackBefore: 0 as const,
        stackAfter: 2_000 as const,
        cumulativeBuyInBefore: 2_000,
        cumulativeBuyInAfter: 4_000,
      },
      started.eventDrafts[0]!,
    ]
    const input = {
      command: {
        sessionId,
        commandId,
        expectedStateVersion: 7,
        type: 'startNextHand' as const,
        payload: {},
      },
      sessionBefore: activeBetweenHandsSession,
      stateEffectKind: 'stateChanged' as const,
      stateBefore: before,
      stateAfter: after,
      lifecycleAfter: 'active' as const,
      currentHandIdAfter: handId,
      playerCoordinationAfter: idlePlayerCoordination,
      events,
      relationPlan: Object.freeze({
        kind: 'startNextHand' as const,
        sessionId,
        handId,
        checkpoint: createHandStartCheckpoint({
          pokerRuleSetVersion: POKER_RULE_SET_VERSION,
          stateBeforeStartCommand: before,
          startedHand: started.startedHand,
        }),
      }),
    }

    expect(isCommandMutationConsistent(input)).toBe(true)
    expect(
      isCommandMutationConsistent({
        ...input,
        relationPlan: Object.freeze({
          ...input.relationPlan,
          sessionId: '20000000-0000-4000-8000-000000000002',
        }),
      }),
    ).toBe(false)
    for (const tamperedAutoRebuyEvent of [
      { ...events[0]!, amount: 1 },
      { ...events[0]!, stackBefore: 123 },
      { ...events[0]!, stackAfter: 456 },
    ]) {
      expect(
        isCommandMutationConsistent({
          ...input,
          events: [tamperedAutoRebuyEvent as never, events[1]!],
        }),
      ).toBe(false)
    }
  })

  test('requires rebuy event amounts to mirror the old and final state', () => {
    const beforePoker = createTestPokerState({
      seats: createTestPokerState().seats.map((seat) =>
        seat.seatNumber === 0
          ? { ...seat, stack: 1_000 }
          : seat.seatNumber === 1
            ? { ...seat, stack: 3_000 }
            : seat,
      ),
    })
    const before = privateState(
      7,
      beforePoker,
      beforePoker.seats.map((seat) => ({
        seatNumber: seat.seatNumber,
        cumulativeBuyIn: 2_000,
      })),
    )
    const afterPoker = createTestPokerState({
      ...beforePoker,
      seats: beforePoker.seats.map((seat) =>
        seat.seatNumber === 0 ? { ...seat, stack: 1_500 } : seat,
      ),
    })
    const after = privateState(
      8,
      afterPoker,
      before.seatAccounting.map((seat) =>
        seat.seatNumber === 0 ? { ...seat, cumulativeBuyIn: 2_500 } : seat,
      ),
    )
    const input = {
      command: {
        sessionId,
        commandId,
        expectedStateVersion: 7,
        type: 'rebuy' as const,
        payload: { amount: 500 },
      },
      sessionBefore: activeBetweenHandsSession,
      stateEffectKind: 'stateChanged' as const,
      stateBefore: before,
      stateAfter: after,
      lifecycleAfter: 'active' as const,
      currentHandIdAfter: null,
      playerCoordinationAfter: idlePlayerCoordination,
      events: [
        {
          type: 'userRebuy' as const,
          seatNumber: 0 as const,
          amount: 500,
          stackBefore: 1_000,
          stackAfter: 1_500,
          cumulativeBuyInBefore: 2_000,
          cumulativeBuyInAfter: 2_500,
        },
      ],
      relationPlan: Object.freeze({ kind: 'rebuy' as const }),
    }

    expect(isCommandMutationConsistent(input)).toBe(true)
    expect(
      isCommandMutationConsistent({
        ...input,
        command: { ...input.command, payload: { amount: 600 } },
      }),
    ).toBe(false)
    expect(
      isCommandMutationConsistent({
        ...input,
        stateAfter: privateState(
          8,
          createTestPokerState({
            ...afterPoker,
            seats: afterPoker.seats.map((seat) =>
              seat.seatNumber === 0 ? { ...seat, stack: 1_600 } : seat,
            ),
          }),
          before.seatAccounting.map((seat) =>
            seat.seatNumber === 0 ? { ...seat, cumulativeBuyIn: 2_600 } : seat,
          ),
        ),
      }),
    ).toBe(false)
    const addedSeat = {
      seatNumber: 6,
      playerId: '00000000-0000-4000-8000-000000000007',
      isUser: false,
      stack: 2_000,
      status: 'active' as const,
      streetContribution: 0,
      totalContribution: 0,
    }
    expect(
      isCommandMutationConsistent({
        ...input,
        stateAfter: privateState(
          8,
          createTestPokerState({
            ...afterPoker,
            seats: [...afterPoker.seats, addedSeat],
          }),
          [...after.seatAccounting, { seatNumber: 6, cumulativeBuyIn: 2_000 }],
        ),
      }),
    ).toBe(false)
  })

  test('requires normal endSession to preserve state while ending lifecycle', () => {
    const poker = createTestPokerState()
    const state = privateState(7, poker)
    const input = {
      command: {
        sessionId,
        commandId,
        expectedStateVersion: 7,
        type: 'endSession' as const,
        payload: {},
      },
      sessionBefore: activeBetweenHandsSession,
      stateEffectKind: 'stateUnchanged' as const,
      stateBefore: state,
      stateAfter: state,
      lifecycleAfter: 'ended' as const,
      currentHandIdAfter: null,
      playerCoordinationAfter: idlePlayerCoordination,
      events: [
        { type: 'sessionEnded' as const, reason: 'userRequested' as const },
      ],
      relationPlan: Object.freeze({ kind: 'normalEnd' as const }),
    }

    expect(isCommandMutationConsistent(input)).toBe(true)
    expect(
      isCommandMutationConsistent({
        ...input,
        stateEffectKind: 'stateChanged',
        stateAfter: privateState(8, poker),
      }),
    ).toBe(false)
  })

  test('accepts an aborted endSession only when checkpoint and events mirror', () => {
    const sortedRestoredPoker = createTestPokerState()
    const restoredPoker = createPokerTableState({
      ...sortedRestoredPoker,
      seats: [...sortedRestoredPoker.seats].reverse(),
    })
    const restored = privateState(8, restoredPoker)
    const started = startPokerHand(restoredPoker, {
      handId,
      completedHandCountBeforeStart: 0,
      randomSource,
    })
    const beforeAbort = privateState(
      7,
      started.state,
      started.state.seats.map((seat) => ({
        seatNumber: seat.seatNumber,
        cumulativeBuyIn: 2_000,
      })),
    )
    const event = {
      type: 'handAborted' as const,
      handId,
      beforeAbort: {
        buttonSeatNumber: started.state.buttonSeatNumber,
        completedHandCount: 0,
        pot: started.state.hand!.pot,
        seats: [...started.state.seats]
          .sort((left, right) => left.seatNumber - right.seatNumber)
          .map((seat) => ({
            seatNumber: seat.seatNumber,
            stack: seat.stack,
            cumulativeBuyIn: 2_000,
          })),
      },
      restored: {
        buttonSeatNumber: restoredPoker.buttonSeatNumber,
        completedHandCount: 0,
        seats: [...restoredPoker.seats]
          .sort((left, right) => left.seatNumber - right.seatNumber)
          .map((seat) => ({
            seatNumber: seat.seatNumber,
            stack: seat.stack,
            cumulativeBuyIn: 2_000,
          })),
      },
    }
    const input = {
      command: {
        sessionId,
        commandId,
        expectedStateVersion: 7,
        type: 'endSession' as const,
        payload: {},
      },
      sessionBefore: Object.freeze({
        ...activeIdleSession,
        agentRunState: 'paused' as const,
      }),
      stateEffectKind: 'stateChanged' as const,
      stateBefore: beforeAbort,
      stateAfter: restored,
      lifecycleAfter: 'ended' as const,
      currentHandIdAfter: null,
      playerCoordinationAfter: idlePlayerCoordination,
      events: [
        event,
        { type: 'sessionEnded' as const, reason: 'handAborted' as const },
      ],
      relationPlan: Object.freeze({
        kind: 'abortHand' as const,
        sessionId,
        handId,
        failedPlayerRunId: '70000000-0000-4000-8000-000000000001',
        failureReasonCode: 'provider_timeout',
        checkpoint: createHandStartCheckpoint({
          pokerRuleSetVersion: POKER_RULE_SET_VERSION,
          stateBeforeStartCommand: restored,
          startedHand: started.startedHand,
        }),
      }),
    }

    expect(isCommandMutationConsistent(input)).toBe(true)
    expect(
      isCommandMutationConsistent({
        ...input,
        events: [
          { ...event, restored: { ...event.restored, buttonSeatNumber: 1 } },
          { type: 'sessionEnded' as const, reason: 'handAborted' as const },
        ],
      }),
    ).toBe(false)
  })
})
