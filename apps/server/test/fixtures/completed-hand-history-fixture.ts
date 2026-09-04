import {
  applyPokerAction,
  initializePokerTable,
  startPokerHand,
} from '../../src/poker/poker-engine.js'
import { getLegalActions } from '../../src/poker/betting.js'
import { POKER_RULE_SET_VERSION } from '../../src/poker/poker-rule-set.js'
import type { PokerDomainEventDraft } from '../../src/poker/hand-result.js'
import { createPrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'
import { createHandStartCheckpoint } from '../../src/sessions/hand-audit/hand-start-checkpoint.js'
import type { CompletedHandHistoryFacts } from '../../src/sessions/hand-history/completed-hand-history.js'
import { createTestCompletedPokerResult } from '../poker/create-test-completed-poker-result.js'

export const COMPLETED_HAND_HISTORY_SESSION_ID =
  '22222222-2222-4222-8222-222222222222'

const randomSource = Object.freeze({ nextInt: () => 0 })

export function createDirectWinCompletedHandHistoryFacts(): CompletedHandHistoryFacts {
  const completed = createTestCompletedPokerResult()
  const result = completed.completedHand
  const initialPoker = initializePokerTable(
    result.seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      playerId: seat.playerId,
      isUser: seat.isUser,
      stack: seat.startingStack,
      status: 'active' as const,
      streetContribution: 0,
      totalContribution: 0,
    })),
    randomSource,
  )
  const started = startPokerHand(initialPoker, {
    handId: result.handId,
    completedHandCountBeforeStart: 0,
    randomSource,
  })
  const checkpoint = createHandStartCheckpoint({
    pokerRuleSetVersion: POKER_RULE_SET_VERSION,
    stateBeforeStartCommand: createPrivateTableState({
      stateVersion: 1,
      poker: initialPoker,
      completedHandCount: 0,
      seatAccounting: initialPoker.seats.map((seat) => ({
        seatNumber: seat.seatNumber,
        cumulativeBuyIn: seat.stack,
      })),
      lastCompletedHandSummary: null,
    }),
    startedHand: started.startedHand,
  })
  return {
    ownerId: 'local-user',
    sessionId: COMPLETED_HAND_HISTORY_SESSION_ID,
    handId: result.handId,
    handNumber: 1,
    startedAt: '2026-09-03T12:00:00.000Z',
    completedAt: '2026-09-03T12:01:00.000Z',
    checkpoint,
    result,
    roster: result.seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      playerId: seat.playerId,
      isUser: seat.isUser,
      displayName: seat.isUser ? '玩家' : `AI ${seat.seatNumber}`,
      avatarColor: seat.isUser ? '#0F766E' : '#000000',
    })),
    events: completed.eventDrafts
      .map((event, index) => ({ eventSeq: index + 10, event }))
      .reverse(),
  }
}

export function createShowdownCompletedHandHistoryFacts(): CompletedHandHistoryFacts {
  const handId = '40000000-0000-4000-8000-000000000001'
  const initialPoker = initializePokerTable(
    Array.from({ length: 6 }, (_, seatNumber) => ({
      seatNumber,
      playerId: `00000000-0000-4000-8000-${(seatNumber + 1)
        .toString()
        .padStart(12, '0')}`,
      isUser: seatNumber === 0,
      stack: 1_000,
      status: 'active' as const,
      streetContribution: 0,
      totalContribution: 0,
    })),
    randomSource,
  )
  const started = startPokerHand(initialPoker, {
    handId,
    completedHandCountBeforeStart: 0,
    randomSource,
  })
  const checkpoint = createHandStartCheckpoint({
    pokerRuleSetVersion: POKER_RULE_SET_VERSION,
    stateBeforeStartCommand: createPrivateTableState({
      stateVersion: 1,
      poker: initialPoker,
      completedHandCount: 0,
      seatAccounting: initialPoker.seats.map((seat) => ({
        seatNumber: seat.seatNumber,
        cumulativeBuyIn: seat.stack,
      })),
      lastCompletedHandSummary: null,
    }),
    startedHand: started.startedHand,
  })
  let state = started.state
  let actionCount = 0
  let completedHand = null
  const eventDrafts: PokerDomainEventDraft[] = []
  while (completedHand === null && actionCount < 36) {
    const actorSeatNumber = state.hand?.currentActorSeatNumber
    if (actorSeatNumber === undefined || actorSeatNumber === null) {
      throw new Error('Expected an action actor.')
    }
    const legalActions = getLegalActions(state)
    const actionIndex = actionCount++
    const action =
      actionIndex === 1 || actionIndex === 3
        ? { type: 'fold' as const }
        : legalActions.some((candidate) => candidate.type === 'call')
          ? { type: 'call' as const }
          : { type: 'check' as const }
    const next = applyPokerAction(state, { actorSeatNumber, action })
    state = next.state
    eventDrafts.push(...next.eventDrafts)
    completedHand = next.completedHand
  }
  if (completedHand === null) throw new Error('Expected a showdown completion.')

  return {
    ownerId: 'local-user',
    sessionId: COMPLETED_HAND_HISTORY_SESSION_ID,
    handId: completedHand.handId,
    handNumber: 1,
    startedAt: '2026-09-03T12:00:00.000Z',
    completedAt: '2026-09-03T12:01:00.000Z',
    checkpoint,
    result: completedHand,
    roster: completedHand.seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      playerId: seat.playerId,
      isUser: seat.isUser,
      displayName: seat.isUser ? '玩家' : `AI ${seat.seatNumber}`,
      avatarColor: seat.isUser ? '#0F766E' : '#000000',
    })),
    events: eventDrafts.map((event, index) => ({
      eventSeq: index + 20,
      event,
    })),
  }
}
