import { describe, expect, test } from 'vitest'
import {
  PLAYER_EMPTY_SESSION_MEMORY_V1,
  PlayerSessionMemoryError,
  decodePlayerSessionMemoryV1,
  foldPlayerSessionMemoryV1,
  hashPlayerSessionMemoryV1,
  type PlayerMemoryLifecycleFact,
} from '../../src/agents/player/player-session-memory.js'
import { isPlayerMemoryFacingAggressionV1 } from '../../src/persistence/player-memory-repository.js'

const ids = Object.freeze({
  actor: '00000000-0000-4000-8000-000000000001',
  humanOpponent: '00000000-0000-4000-8000-000000000000',
  opponent: '00000000-0000-4000-8000-000000000002',
  third: '00000000-0000-4000-8000-000000000003',
  fourth: '00000000-0000-4000-8000-000000000004',
  fifth: '00000000-0000-4000-8000-000000000005',
  sixth: '00000000-0000-4000-8000-000000000006',
})

function completedHand(
  handNumber: number,
  eventSeq: number,
): Extract<PlayerMemoryLifecycleFact, { readonly status: 'completed' }> {
  return {
    handNumber,
    terminalEventSeq: eventSeq,
    status: 'completed' as const,
    buttonSeatNumber: 1,
    participants: [
      { participantId: ids.actor, seatNumber: 1 },
      { participantId: ids.opponent, seatNumber: 2 },
      { participantId: ids.third, seatNumber: 3 },
      { participantId: ids.fourth, seatNumber: 4 },
      { participantId: ids.fifth, seatNumber: 5 },
      { participantId: ids.sixth, seatNumber: 6 },
    ],
    actions: [
      {
        eventSeq: eventSeq - 1,
        actorSeatNumber: 2,
        actionType: 'raise' as const,
        contributionDelta: 40,
        isVoluntaryPreflopContribution: true,
        isFullRaise: true,
        facedAggression: false,
      },
    ],
    showdown: {
      board: [
        { rank: 'A' as const, suit: 'clubs' as const },
        { rank: 'K' as const, suit: 'diamonds' as const },
        { rank: 'Q' as const, suit: 'hearts' as const },
        { rank: 'J' as const, suit: 'spades' as const },
        { rank: 'T' as const, suit: 'clubs' as const },
      ],
      revealedHands: [
        {
          seatNumber: 2,
          holeCards: [
            { rank: '2' as const, suit: 'clubs' as const },
            { rank: '3' as const, suit: 'clubs' as const },
          ],
        },
      ],
    },
  }
}

describe('player session memory', () => {
  test('只将 amountToCallBefore 为正的等价合法行动集折叠为 facing aggression', () => {
    expect(
      isPlayerMemoryFacingAggressionV1([
        { type: 'fold' },
        { type: 'check' },
        { type: 'raise' },
        { type: 'allIn' },
      ]),
    ).toBe(false)
    expect(
      isPlayerMemoryFacingAggressionV1([
        { type: 'fold' },
        { type: 'call' },
        { type: 'raise' },
      ]),
    ).toBe(true)
    expect(
      isPlayerMemoryFacingAggressionV1([{ type: 'fold' }, { type: 'allIn' }]),
    ).toBe(true)
  })

  test('规范空 Memory 是严格 current-v1 载荷，拒绝旧的空对象', () => {
    expect(decodePlayerSessionMemoryV1(PLAYER_EMPTY_SESSION_MEMORY_V1)).toEqual(
      PLAYER_EMPTY_SESSION_MEMORY_V1,
    )
    expect(() => decodePlayerSessionMemoryV1({})).toThrow(
      PlayerSessionMemoryError,
    )
    expect(hashPlayerSessionMemoryV1(PLAYER_EMPTY_SESSION_MEMORY_V1)).toMatch(
      /^[0-9a-f]{64}$/,
    )
  })

  test('连续扫描会折叠 completed、跳过 aborted 并推进游标', () => {
    const input = {
      memory: PLAYER_EMPTY_SESSION_MEMORY_V1,
      actorParticipantId: ids.actor,
      cutoff: { handNumber: 4, eventSeq: 40 },
      hands: [
        completedHand(1, 10),
        { handNumber: 2, terminalEventSeq: 20, status: 'aborted' as const },
        completedHand(3, 30),
      ],
    }

    const memory = foldPlayerSessionMemoryV1(input)

    expect(memory.scannedThrough).toEqual({ handNumber: 3, eventSeq: 40 })
    expect(memory.lastCompletedHandNumber).toBe(3)
    expect(memory.sessionSummary).toEqual({
      completedHandsObserved: 2,
      showdownHandsObserved: 2,
    })
    expect(memory.recentHands.map(({ handNumber }) => handNumber)).toEqual([
      1, 3,
    ])
    expect(memory.opponents).toContainEqual(
      expect.objectContaining({
        participantId: ids.opponent,
        seatNumber: 2,
        completedHandsObserved: 2,
        showdownHandsObserved: 2,
      }),
    )
  })

  test('手牌编号缺口和截止点之后的事实会被拒绝', () => {
    expect(() =>
      foldPlayerSessionMemoryV1({
        memory: PLAYER_EMPTY_SESSION_MEMORY_V1,
        actorParticipantId: ids.actor,
        cutoff: { handNumber: 3, eventSeq: 20 },
        hands: [completedHand(1, 10)],
      }),
    ).toThrow(PlayerSessionMemoryError)

    expect(() =>
      foldPlayerSessionMemoryV1({
        memory: PLAYER_EMPTY_SESSION_MEMORY_V1,
        actorParticipantId: ids.actor,
        cutoff: { handNumber: 2, eventSeq: 9 },
        hands: [completedHand(1, 10)],
      }),
    ).toThrow(PlayerSessionMemoryError)
  })

  test('将 0 号座位的公开对手纳入跨手统计', () => {
    const hand = completedHand(1, 10)
    hand.participants[1] = {
      participantId: ids.humanOpponent,
      seatNumber: 0,
    }
    hand.actions[0] = {
      ...hand.actions[0]!,
      actorSeatNumber: 0,
    }
    hand.showdown = {
      ...hand.showdown!,
      revealedHands: [
        {
          seatNumber: 0,
          holeCards: hand.showdown!.revealedHands[0]!.holeCards,
        },
      ],
    }

    const memory = foldPlayerSessionMemoryV1({
      memory: PLAYER_EMPTY_SESSION_MEMORY_V1,
      actorParticipantId: ids.actor,
      cutoff: { handNumber: 2, eventSeq: 20 },
      hands: [hand],
    })

    expect(memory.opponents).toContainEqual(
      expect.objectContaining({
        participantId: ids.humanOpponent,
        seatNumber: 0,
      }),
    )
  })

  test('compact Memory 在下一次增量 fold 时保留 compact 语义', () => {
    const full = foldPlayerSessionMemoryV1({
      memory: PLAYER_EMPTY_SESSION_MEMORY_V1,
      actorParticipantId: ids.actor,
      cutoff: { handNumber: 2, eventSeq: 20 },
      hands: [completedHand(1, 10)],
    })
    const compact = decodePlayerSessionMemoryV1({
      ...full,
      detailLevel: 'compact',
      recentHands: full.recentHands.map((hand) => ({
        ...hand,
        actions: hand.actions.map(({ actorSeatNumber, actionType }) => ({
          actorSeatNumber,
          actionType,
        })),
      })),
    })

    expect(() =>
      foldPlayerSessionMemoryV1({
        memory: compact,
        actorParticipantId: ids.actor,
        cutoff: { handNumber: 3, eventSeq: 30 },
        hands: [completedHand(2, 20)],
      }),
    ).not.toThrow()
  })
})
