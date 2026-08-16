import type { SseEvent } from '@tx-holdem-coach/contracts'
import { describe, expect, test, vi } from 'vitest'
import { createCommittedSessionEventHub } from '../../src/sessions/public-projection/committed-session-event-hub.js'

const sessionId = '20000000-0000-4000-8000-000000000001'
const otherSessionId = '20000000-0000-4000-8000-000000000002'

function event(eventSeq: number, overrides: Partial<SseEvent> = {}): SseEvent {
  const snapshot = {
    sessionId,
    stateVersion: 4,
    eventSeq,
    pokerPhase: 'inHand' as const,
    lifecycleStatus: 'active' as const,
    agentRunState: 'idle' as const,
    activeDecision: null,
    seats: Array.from({ length: 6 }, (_, seatNumber) => ({
      seatNumber,
      playerId: `00000000-0000-4000-8000-00000000000${seatNumber + 1}`,
      displayName: seatNumber === 0 ? '玩家' : `AI ${seatNumber}`,
      avatarColor: '#0F766E',
      isUser: seatNumber === 0,
      stack: 2_000,
      status: 'active' as const,
    })),
    hand: {
      handId: '10000000-0000-4000-8000-000000000001',
      street: 'preflop' as const,
      board: [],
      pot: 30,
      currentActorSeatNumber: 0,
      heroHoleCards: [
        { rank: 'A' as const, suit: 'spades' as const },
        { rank: 'K' as const, suit: 'spades' as const },
      ],
      legalActions: [{ type: 'fold' as const }],
      actionTimeline: [],
    },
    lastCompletedHandSummary: null,
  }
  return {
    eventId: `30000000-0000-4000-8000-${String(eventSeq).padStart(12, '0')}`,
    sessionId,
    eventSeq,
    stateVersion: 4,
    type: 'actionCommitted',
    payload: { snapshot },
    ...overrides,
  }
}

describe('committed session event hub', () => {
  test('按场次分发连续批次且取消订阅后不保留历史', () => {
    const hub = createCommittedSessionEventHub()
    const received: number[] = []
    const unsubscribe = hub.subscribe(sessionId, (item) => {
      received.push(item.eventSeq)
    })
    const other = vi.fn()
    hub.subscribe(otherSessionId, other)

    hub.publish([event(7), event(8)])
    unsubscribe()
    hub.publish([event(9)])

    expect(received).toEqual([7, 8])
    expect(other).not.toHaveBeenCalled()
  })

  test('移除抛错监听器但继续交付其他监听器', () => {
    const onListenerError = vi.fn()
    const hub = createCommittedSessionEventHub({ onListenerError })
    const healthy = vi.fn()
    const broken = vi.fn(() => {
      throw new Error('private listener failure')
    })
    hub.subscribe(sessionId, broken)
    hub.subscribe(sessionId, healthy)

    hub.publish([event(7), event(8)])

    expect(broken).toHaveBeenCalledTimes(1)
    expect(healthy).toHaveBeenCalledTimes(2)
    expect(onListenerError).toHaveBeenCalledTimes(1)
  })

  test('递归冻结事件，前一个监听器不能污染后续交付', () => {
    const hub = createCommittedSessionEventHub()
    let mutationRejected = false
    let receivedStack: number | undefined
    hub.subscribe(sessionId, (item) => {
      try {
        ;(item.payload.snapshot.seats[0] as { stack: number }).stack = 99
      } catch {
        mutationRejected = true
      }
    })
    hub.subscribe(sessionId, (item) => {
      receivedStack = item.payload.snapshot.seats[0]?.stack
    })

    hub.publish([event(7)])

    expect(mutationRejected).toBe(true)
    expect(receivedStack).toBe(2_000)
  })

  test('拒绝不连续或镜像矛盾的批次', () => {
    const hub = createCommittedSessionEventHub()
    expect(() => hub.publish([event(7), event(9)])).toThrow()
    expect(() =>
      hub.publish([
        event(7, {
          sessionId: otherSessionId,
        }),
      ]),
    ).toThrow()
  })
})
