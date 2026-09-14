import {
  PublicSessionSnapshotSchema,
  PublicActionTimelineEntrySchema,
  SseEventSchema,
} from '@tx-holdem-coach/contracts'
import { describe, expect, test } from 'vitest'
import { STANDARD_DECK } from '../../src/poker/cards.js'
import { applyPokerAction } from '../../src/poker/poker-engine.js'
import { createPrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'
import { projectPublicSessionSnapshot } from '../../src/sessions/public-projection/public-session-projector.js'
import { PublicProjectionInvariantError } from '../../src/sessions/public-projection/errors.js'
import {
  createTestPokerState,
  createTestBettingPokerState,
} from '../poker/create-test-poker-state.js'

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

  test('BB 补跟收街仍展示本次 40 和本街累计 60', () => {
    const base = createFacts()
    const initial = createTestBettingPokerState()
    const dealt = initial.hand!.holeCards.flatMap(({ cards }) => cards)
    let poker = createTestBettingPokerState({
      hand: {
        remainingDeck: STANDARD_DECK.filter(
          (card) =>
            !dealt.some((c) => c.rank === card.rank && c.suit === card.suit),
        ),
      },
    })
    for (const seat of [3, 4, 5, 0, 1]) {
      poker = applyPokerAction(poker, {
        actorSeatNumber: seat,
        action:
          seat === 3
            ? { type: 'raise', targetStreetCommitment: 60 }
            : { type: 'call' },
      }).state
    }
    const result = applyPokerAction(poker, {
      actorSeatNumber: 2,
      action: { type: 'call' },
    })
    const snapshot = projectPublicSessionSnapshot({
      ...base,
      state: createPrivateTableState({ ...base.state, poker: result.state }),
      newPrivateEvents: result.eventDrafts,
    })
    expect(snapshot.hand?.street).toBe('flop')
    expect(snapshot.hand?.actionTimeline[0]).toMatchObject({
      actionDisplay: { committedAmount: 40, streetContributionAfterAction: 60 },
      potAfter: 360,
    })
  })

  test('旧时间线可缺省整块，坏金额块拒绝，投影不输出失衡金额', () => {
    const facts = createFacts()
    const entry = projectPublicSessionSnapshot(facts).hand!.actionTimeline[0]!
    expect(entry.actionDisplay).toEqual({
      committedAmount: 0,
      streetContributionAfterAction: 0,
    })
    const { actionDisplay: _, ...legacy } = entry
    expect(PublicActionTimelineEntrySchema.parse(legacy)).toEqual(legacy)
    for (const actionDisplay of [
      {},
      { committedAmount: 0 },
      { committedAmount: -1, streetContributionAfterAction: 0 },
      { ...entry.actionDisplay, private: true },
    ])
      expect(
        PublicActionTimelineEntrySchema.safeParse({ ...entry, actionDisplay })
          .success,
      ).toBe(false)
    const corrupted = structuredClone(facts)
    const event = corrupted.newPrivateEvents[0]!
    if (event.type !== 'actionCommitted') throw new Error('expected action')
    const invalidEvent = {
      ...event,
      after: { ...event.after, pot: event.after.pot + 1 },
    }
    expect(() =>
      projectPublicSessionSnapshot({
        ...facts,
        newPrivateEvents: [invalidEvent],
      }),
    ).toThrow(PublicProjectionInvariantError)
  })

  test('无行动的首手公开庄盲、投入和未匹配额，旧格式仍可读取', () => {
    const base = createFacts()
    const poker = createTestBettingPokerState()
    const facts = {
      ...base,
      state: createPrivateTableState({
        stateVersion: 8,
        poker,
        completedHandCount: 0,
        seatAccounting: base.state.seatAccounting,
        lastCompletedHandSummary: null,
      }),
      newPrivateEvents: [],
    }
    const snapshot = projectPublicSessionSnapshot(facts)
    expect(snapshot.hand?.actionTimeline).toEqual([])
    expect(snapshot.tableDisplay).toEqual({
      completedHandCount: 0,
      blinds: { smallBlind: 10, bigBlind: 20 },
      hand: {
        handId: poker.hand!.handId,
        buttonSeatNumber: 0,
        seats: [
          { seatNumber: 0, position: 'BTN', streetContribution: 0 },
          { seatNumber: 1, position: 'SB', streetContribution: 10 },
          { seatNumber: 2, position: 'BB', streetContribution: 20 },
          { seatNumber: 3, position: 'UTG', streetContribution: 0 },
          { seatNumber: 4, position: 'HJ', streetContribution: 0 },
          { seatNumber: 5, position: 'CO', streetContribution: 0 },
        ],
        potBreakdown: {
          pots: [{ potIndex: 0, kind: 'main', amount: 20 }],
          unmatchedContribution: { seatNumber: 2, amount: 10 },
        },
      },
    })
  })

  test('整块缺省保留旧公开载荷；坏块、错手、错席与金额不守恒必须拒绝', () => {
    const snapshot = projectPublicSessionSnapshot(createFacts())
    const { tableDisplay: _, ...legacy } = snapshot
    expect(PublicSessionSnapshotSchema.parse(legacy)).toEqual(legacy)
    const event = {
      eventId: '30000000-0000-4000-8000-000000000001',
      sessionId,
      stateVersion: 8,
      eventSeq: 2,
      type: 'actionCommitted',
      payload: { snapshot: legacy },
    }
    expect(SseEventSchema.parse(event)).toEqual(event)
    const hand = snapshot.tableDisplay.hand!
    for (const invalid of [
      {},
      { ...snapshot.tableDisplay, hand: null },
      {
        ...snapshot.tableDisplay,
        hand: { ...hand, handId: '10000000-0000-4000-8000-000000000099' },
      },
      {
        ...snapshot.tableDisplay,
        hand: { ...hand, seats: hand.seats.slice(1) },
      },
      { ...snapshot.tableDisplay, hand: { ...hand, buttonSeatNumber: 1 } },
      {
        ...snapshot.tableDisplay,
        hand: {
          ...hand,
          potBreakdown: { pots: [], unmatchedContribution: null },
        },
      },
      {
        ...snapshot.tableDisplay,
        hand: {
          ...hand,
          seats: hand.seats.map((seat) => ({
            ...seat,
            holeCards: ['PRIVATE'],
          })),
        },
      },
    ])
      expect(
        PublicSessionSnapshotSchema.safeParse({
          ...snapshot,
          tableDisplay: invalid,
        }).success,
      ).toBe(false)
    expect(Object.keys(snapshot.tableDisplay).sort()).toEqual([
      'blinds',
      'completedHandCount',
      'hand',
    ])
    expect(Object.keys(hand).sort()).toEqual([
      'buttonSeatNumber',
      'handId',
      'potBreakdown',
      'seats',
    ])
    for (const seat of hand.seats)
      expect(Object.keys(seat).sort()).toEqual([
        'position',
        'seatNumber',
        'streetContribution',
      ])
  })

  test.each([
    {
      amounts: [100, 200, 200, 0, 0, 0],
      folded: [3, 4, 5],
      pots: [300, 200],
      unmatched: null,
    },
    {
      amounts: [120, 100, 50, 0, 0, 0],
      folded: [2, 3, 4, 5],
      pots: [150, 100],
      unmatched: { seatNumber: 0, amount: 20 },
    },
  ])(
    '公开投入分层保持领域金额 $amounts',
    ({ amounts, folded, pots, unmatched }) => {
      const base = createFacts()
      const initial = createTestBettingPokerState()
      const poker = createTestBettingPokerState({
        seats: initial.seats.map((seat, index) => ({
          ...seat,
          stack: 2000 - amounts[index]!,
          totalContribution: amounts[index]!,
          streetContribution: 0,
          status: folded.includes(seat.seatNumber) ? 'folded' : 'active',
        })),
        hand: {
          street: 'flop',
          board: [
            { rank: '2', suit: 'clubs' },
            { rank: '3', suit: 'clubs' },
            { rank: '4', suit: 'clubs' },
          ],
          pot: amounts.reduce((a, b) => a + b, 0),
          currentActorSeatNumber: 0,
          bettingRound: { currentBet: 0 },
        },
      })
      const snapshot = projectPublicSessionSnapshot({
        ...base,
        newPrivateEvents: [],
        state: createPrivateTableState({ ...base.state, poker }),
      })
      expect(
        snapshot.tableDisplay.hand!.potBreakdown.pots.map((pot) => pot.amount),
      ).toEqual(pots)
      expect(
        snapshot.tableDisplay.hand!.potBreakdown.unmatchedContribution,
      ).toEqual(unmatched)
      expect(
        snapshot.tableDisplay.hand!.seats.every(
          (seat) => seat.streetContribution === 0,
        ),
      ).toBe(true)
    },
  )

  test('稀疏参与席保留真实位置，中止首手后的完成数仍为零', () => {
    const base = createFacts()
    const original = createTestBettingPokerState()
    const numbers = [0, 1, 3, 4, 6, 8]
    const poker = createTestBettingPokerState({
      seats: original.seats.map((seat, i) => ({
        ...seat,
        seatNumber: numbers[i]!,
      })),
      hand: {
        currentActorSeatNumber: 4,
        holeCards: original.hand!.holeCards.map((cards) => ({
          ...cards,
          seatNumber: numbers[cards.seatNumber]!,
        })),
        bettingRound: {
          seatStates: original.hand!.bettingRound!.seatStates.map((seat) => ({
            ...seat,
            seatNumber: numbers[seat.seatNumber]!,
          })),
        },
      },
    })
    const facts = {
      ...base,
      roster: base.roster.map((seat, i) => ({
        ...seat,
        seatNumber: numbers[i]!,
      })) as typeof base.roster,
      newPrivateEvents: [],
      state: createPrivateTableState({
        ...base.state,
        poker,
        seatAccounting: base.state.seatAccounting.map((seat, i) => ({
          ...seat,
          seatNumber: numbers[i]!,
        })),
      }),
    }
    expect(
      projectPublicSessionSnapshot(facts).tableDisplay.hand!.seats.map(
        ({ seatNumber, position }) => [seatNumber, position],
      ),
    ).toEqual([
      [0, 'BTN'],
      [1, 'SB'],
      [3, 'BB'],
      [4, 'UTG'],
      [6, 'HJ'],
      [8, 'CO'],
    ])
    const ended = projectPublicSessionSnapshot({
      ...base,
      newPrivateEvents: [],
      session: {
        ...base.session,
        lifecycleStatus: 'ended',
        endedAt: '2026-09-13T00:00:00.000Z',
        currentHandId: null,
      },
      state: createPrivateTableState({
        ...base.state,
        poker: createTestPokerState(),
      }),
    })
    expect(ended.tableDisplay).toEqual({
      completedHandCount: 0,
      blinds: { smallBlind: 10, bigBlind: 20 },
      hand: null,
    })
    expect(ended.lastCompletedHandSummary).toBeNull()
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
