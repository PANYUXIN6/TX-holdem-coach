import { describe, expect, test } from 'vitest'
import { applyPokerAction } from '../../src/poker/poker-engine.js'
import { createPrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'
import { projectPublicSessionSnapshot } from '../../src/sessions/public-projection/public-session-projector.js'
import { PublicProjectionInvariantError } from '../../src/sessions/public-projection/errors.js'
import { createTestBettingPokerState } from '../poker/create-test-poker-state.js'

const sessionId = '20000000-0000-4000-8000-000000000001'

function createFacts() {
  const before = createTestBettingPokerState({
    hand: { currentActorSeatNumber: 0 },
  })
  const action = applyPokerAction(before, {
    actorSeatNumber: 0,
    action: { type: 'fold' },
  })
  const state = createPrivateTableState({
    stateVersion: 8,
    poker: action.state,
    completedHandCount: 0,
    seatAccounting: action.state.seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      cumulativeBuyIn: 2_000,
    })),
    lastCompletedHandSummary: null,
  })
  return {
    state,
    session: {
      sessionId,
      lifecycleStatus: 'active' as const,
      endedAt: null,
      stateVersion: 8,
      nextEventSeq: 3,
      currentHandId: state.poker.hand?.handId ?? null,
      diagnosticCode: null,
      diagnosedAt: null,
      agentRunState: 'idle' as const,
      activePlayerRunId: null,
      activeDecisionRequestId: null,
    },
    eventSeq: 2,
    newPrivateEvents: action.eventDrafts,
    roster: state.poker.seats.map((seat) =>
      seat.isUser
        ? ({
            seatNumber: 0 as const,
            playerId: seat.playerId,
            isUser: true as const,
          } as const)
        : ({
            seatNumber: seat.seatNumber,
            playerId: seat.playerId,
            isUser: false as const,
            displayName: `AI ${seat.seatNumber} PRIVATE_PROMPT_SENTINEL`,
            avatarColor: `#00000${seat.seatNumber}`,
          } as const),
    ),
    committedCurrentHandEvents: [],
  }
}

describe('public session projector', () => {
  test('同步投影当前手并严格隐藏私密牌局事实', () => {
    const facts = createFacts()
    const snapshot = projectPublicSessionSnapshot(facts)

    expect(snapshot).toMatchObject({
      sessionId,
      stateVersion: 8,
      eventSeq: 2,
      pokerPhase: 'inHand',
      hand: {
        heroHoleCards: [
          { rank: 'A', suit: 'spades' },
          { rank: 'K', suit: 'spades' },
        ],
        legalActions: [],
        actionTimeline: [
          { eventSeq: 2, actorSeatNumber: 0, action: { type: 'fold' } },
        ],
      },
    })
    expect(snapshot.seats.map((seat) => seat.seatNumber)).toEqual([
      0, 1, 2, 3, 4, 5,
    ])
    expect(snapshot.seats[0]).toMatchObject({
      displayName: '玩家',
      avatarColor: '#0F766E',
    })
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain('remainingDeck')
    expect(serialized).not.toContain('burnedCards')
    expect(serialized).not.toContain('legalActionsBefore')
    expect(serialized).not.toContain('progression')
    expect(serialized).not.toContain('Q\",\"suit\":\"hearts')
    expect(Object.isFrozen(snapshot)).toBe(true)
  })

  test('拒绝 roster、版本和事件游标镜像矛盾', () => {
    const facts = createFacts()
    for (const invalid of [
      { ...facts, eventSeq: 1 },
      {
        ...facts,
        session: { ...facts.session, stateVersion: 7 },
      },
      { ...facts, roster: facts.roster.slice(1) },
    ]) {
      expect(() => projectPublicSessionSnapshot(invalid)).toThrow(
        PublicProjectionInvariantError,
      )
    }
  })
})
