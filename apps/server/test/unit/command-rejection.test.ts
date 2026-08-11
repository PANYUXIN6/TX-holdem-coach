import { describe, expect, test } from 'vitest'
import { createPrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'
import {
  mapCommandRejectionToErrorResponse,
  parseStableCommandRejection,
  type StableCommandRejection,
} from '../../src/sessions/command-execution/command-rejection.js'
import {
  createTestBettingPokerState,
  createTestPokerState,
} from '../poker/create-test-poker-state.js'

const sessionId = '20000000-0000-4000-8000-000000000001'
const commandId = '30000000-0000-4000-8000-000000000001'

function state(poker: ReturnType<typeof createTestPokerState>) {
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

const playerCommand = {
  sessionId,
  commandId,
  expectedStateVersion: 7,
  type: 'playerAction' as const,
  payload: { action: { type: 'fold' as const } },
}

const latestSnapshot = {
  protocolVersion: 1 as const,
  sessionId,
  stateVersion: 7,
  eventSeq: 1,
  pokerPhase: 'betweenHands' as const,
  lifecycleStatus: 'active' as const,
  agentRunState: 'idle' as const,
  activeDecision: null,
  seats: createTestPokerState().seats.map((seat) => ({
    seatNumber: seat.seatNumber,
    playerId: seat.playerId,
    displayName: seat.isUser ? '玩家' : `AI ${seat.seatNumber}`,
    avatarColor: '#0f766e',
    isUser: seat.isUser,
    stack: seat.stack,
    status: seat.status,
  })),
  hand: null,
  lastCompletedHandSummary: null,
}

describe('command rejection contract', () => {
  test('accepts stable rejections only in their matching command context', () => {
    const userTurn = state(
      createTestBettingPokerState({ hand: { currentActorSeatNumber: 0 } }),
    )
    const aiTurn = state(createTestBettingPokerState())
    expect(
      parseStableCommandRejection(
        { kind: 'pokerActionNotLegal' },
        { command: playerCommand, state: userTurn },
      ),
    ).toEqual({ kind: 'pokerActionNotLegal' })
    expect(
      parseStableCommandRejection(
        { kind: 'playerNotCurrentActor' },
        { command: playerCommand, state: aiTurn },
      ),
    ).toEqual({ kind: 'playerNotCurrentActor' })
    expect(
      parseStableCommandRejection(
        { kind: 'pokerActionNotLegal' },
        { command: playerCommand, state: aiTurn },
      ),
    ).toBeNull()
    expect(
      parseStableCommandRejection(
        { kind: 'playerNotCurrentActor', extra: true },
        { command: playerCommand, state: aiTurn },
      ),
    ).toBeNull()
  })

  test('maps every stable rejection to its fixed response', () => {
    const cases: readonly [StableCommandRejection, string, string][] = [
      [
        { kind: 'commandNotAllowedInPhase', phase: 'betweenHands' },
        'COMMAND_NOT_ALLOWED_IN_PHASE',
        '当前牌局阶段不允许执行该命令。',
      ],
      [
        { kind: 'playerNotCurrentActor' },
        'PLAYER_NOT_CURRENT_ACTOR',
        '当前尚未轮到你行动。',
      ],
      [
        { kind: 'pokerActionNotLegal' },
        'POKER_ACTION_NOT_LEGAL',
        '该行动在当前局面不可用。',
      ],
      [
        { kind: 'pokerActionTargetOutOfRange' },
        'POKER_ACTION_TARGET_OUT_OF_RANGE',
        '下注或加注金额超出当前合法范围。',
      ],
    ]
    for (const [rejection, code, message] of cases) {
      expect(
        mapCommandRejectionToErrorResponse(rejection, latestSnapshot),
      ).toEqual({
        protocolVersion: 1,
        code,
        message,
        latestSnapshot,
      })
    }
  })
})
