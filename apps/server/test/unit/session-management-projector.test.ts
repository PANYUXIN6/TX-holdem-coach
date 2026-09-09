import { describe, expect, it } from 'vitest'
import { initializePokerTable } from '../../src/poker/poker-engine.js'
import { createPrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'
import { projectSessionManagementItem } from '../../src/sessions/data-management/session-management-projector.js'

const sessionId = '10000000-0000-4000-8000-000000000001'
const players = Array.from({ length: 6 }, (_, seatNumber) => ({
  seatNumber,
  playerId: `20000000-0000-4000-8000-00000000000${seatNumber + 1}`,
  isUser: seatNumber === 0,
  stack: seatNumber === 0 ? 3_700 : 2_120,
  status: 'active' as const,
  streetContribution: 0,
  totalContribution: 0,
}))
const state = createPrivateTableState({
  stateVersion: 4,
  poker: initializePokerTable(players, { nextInt: () => 0 }),
  completedHandCount: 0,
  seatAccounting: players.map(({ seatNumber }) => ({
    seatNumber,
    cumulativeBuyIn: seatNumber === 0 ? 4_000 : 2_060,
  })),
  lastCompletedHandSummary: null,
})
const roster = players.map((player) =>
  player.isUser
    ? {
        kind: 'user' as const,
        participantId: player.playerId,
        seatNumber: 0 as const,
      }
    : {
        kind: 'ai' as const,
        participantId: player.playerId,
        seatNumber: player.seatNumber,
        personaId: `historical-${player.seatNumber}`,
        personaVersion: 1,
        displayName: `AI ${player.seatNumber}`,
        avatarColor: '#123456',
        configSnapshotKey: 'a'.repeat(64),
      },
)

describe('M5.5 场次管理投影', () => {
  it('从首手开场状态和当前快照核算结束资金', () => {
    const result = projectSessionManagementItem({
      sessionId,
      lifecycle: 'ended',
      createdAt: '2026-09-07T00:00:00.000000Z',
      endedAt: '2026-09-07T01:00:00.000000Z',
      stateVersion: 4,
      currentHandId: null,
      completedHandCount: 0,
      roster,
      initialStacks: players.map(({ playerId, seatNumber }) => ({
        participantId: playerId,
        seatNumber,
        stack: 2_000,
      })),
      state,
    })
    expect(result.accounting).toMatchObject({
      status: 'available',
      seats: expect.arrayContaining([
        expect.objectContaining({
          seatNumber: 0,
          initialChips: 2_000,
          currentChips: 3_700,
          cumulativeBuyIn: 4_000,
          finalChips: 3_700,
          sessionNetChange: -300,
        }),
      ]),
    })
  })

  it('拒绝快照 currentHandId 与关系指针偏差', () => {
    expect(() =>
      projectSessionManagementItem({
        sessionId,
        lifecycle: 'active',
        createdAt: '2026-09-07T00:00:00.000000Z',
        endedAt: null,
        stateVersion: 4,
        currentHandId: '30000000-0000-4000-8000-000000000001',
        completedHandCount: 0,
        roster,
        initialStacks: players.map(({ playerId, seatNumber }) => ({
          participantId: playerId,
          seatNumber,
          stack: 2_000,
        })),
        state,
      }),
    ).toThrow()
  })

  it('拒绝首手 checkpoint 座位与 roster participant 不一致', () => {
    expect(() =>
      projectSessionManagementItem({
        sessionId,
        lifecycle: 'ended',
        createdAt: '2026-09-07T00:00:00.000000Z',
        endedAt: '2026-09-07T01:00:00.000000Z',
        stateVersion: 4,
        currentHandId: null,
        completedHandCount: 0,
        roster,
        initialStacks: players.map(({ seatNumber }, index) => ({
          participantId:
            index === 0
              ? '90000000-0000-4000-8000-000000000001'
              : players[index]!.playerId,
          seatNumber,
          stack: 2_000,
        })),
        state,
      } as unknown as Parameters<typeof projectSessionManagementItem>[0]),
    ).toThrow()
  })

  it('诊断场次不读取不可信资金或 currentHandId', () => {
    expect(
      projectSessionManagementItem({
        sessionId,
        lifecycle: 'readonlyDiagnostic',
        createdAt: '2026-09-07T00:00:00.000000Z',
        endedAt: null,
        stateVersion: 4,
        currentHandId: '30000000-0000-4000-8000-000000000001',
        completedHandCount: 3,
        roster,
        initialStacks: null,
        state: null,
      }),
    ).toMatchObject({
      currentHandId: null,
      accounting: { status: 'unavailable', reason: 'readonlyDiagnostic' },
    })
  })
})
