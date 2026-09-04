import { describe, expect, test } from 'vitest'
import { getLegalActions } from '../../src/poker/betting.js'
import {
  applyPokerAction,
  initializePokerTable,
  startPokerHand,
} from '../../src/poker/poker-engine.js'
import { POKER_RULE_SET_VERSION } from '../../src/poker/poker-rule-set.js'
import type { PokerDomainEventDraft } from '../../src/poker/hand-result.js'
import { createPrivateEvent } from '../../src/sessions/authoritative-state/private-event.js'
import { createPrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'
import { createHandStartCheckpoint } from '../../src/sessions/hand-audit/hand-start-checkpoint.js'
import { projectAuthoritativeCompletedHandHistory } from '../../src/sessions/hand-history/completed-hand-history-projector.js'
import { CompletedHandHistoryInvariantError } from '../../src/sessions/hand-history/errors.js'
import {
  COMPLETED_HAND_HISTORY_SESSION_ID,
  createDirectWinCompletedHandHistoryFacts,
} from '../fixtures/completed-hand-history-fixture.js'

function createAllInRunoutFacts() {
  return createCompletedHandHistoryFacts({
    handId: '20000000-0000-4000-8000-000000000001',
    stack: 20,
    selectAction: (legalActions) =>
      legalActions.some((candidate) => candidate.type === 'allIn')
        ? { type: 'allIn' as const }
        : legalActions.some((candidate) => candidate.type === 'call')
          ? { type: 'call' as const }
          : { type: 'check' as const },
  })
}

function createShowdownFacts() {
  return createCompletedHandHistoryFacts({
    handId: '30000000-0000-4000-8000-000000000001',
    stack: 1_000,
    selectAction: (legalActions) =>
      legalActions.some((candidate) => candidate.type === 'call')
        ? { type: 'call' as const }
        : { type: 'check' as const },
  })
}

function createCompletedHandHistoryFacts(input: {
  readonly handId: string
  readonly stack: number
  readonly selectAction: (
    legalActions: ReturnType<typeof getLegalActions>,
  ) =>
    | { readonly type: 'allIn' }
    | { readonly type: 'call' }
    | { readonly type: 'check' }
}) {
  const initialPoker = initializePokerTable(
    Array.from({ length: 6 }, (_, seatNumber) => ({
      seatNumber,
      playerId: `00000000-0000-4000-8000-${(seatNumber + 1)
        .toString()
        .padStart(12, '0')}`,
      isUser: seatNumber === 0,
      stack: input.stack,
      status: 'active' as const,
      streetContribution: 0,
      totalContribution: 0,
    })),
    { nextInt: () => 0 },
  )
  const started = startPokerHand(initialPoker, {
    handId: input.handId,
    completedHandCountBeforeStart: 0,
    randomSource: { nextInt: () => 0 },
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
  const eventDrafts: PokerDomainEventDraft[] = []
  let completedHand = null
  for (let turn = 0; turn < 36 && completedHand === null; turn += 1) {
    const actorSeatNumber = state.hand?.currentActorSeatNumber
    if (actorSeatNumber === null || actorSeatNumber === undefined) {
      throw new Error('Expected an action actor.')
    }
    const legalActions = getLegalActions(state)
    const action = input.selectAction(legalActions)
    const next = applyPokerAction(state, { actorSeatNumber, action })
    state = next.state
    eventDrafts.push(...next.eventDrafts)
    completedHand = next.completedHand
  }
  if (completedHand === null) throw new Error('Expected an all-in completion.')
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
      displayName: seat.isUser ? '用户提供的错误名称' : `AI ${seat.seatNumber}`,
      avatarColor: seat.isUser ? '#BADBAD' : '#000000',
    })),
    events: eventDrafts.map((event, index) => ({
      eventSeq: index + 20,
      event,
    })),
  }
}

function addUnmirroredFunds<
  Snapshot extends {
    readonly pot: number
    readonly seats: readonly {
      readonly seatNumber: number
      readonly stack: number
      readonly streetContribution: number
      readonly totalContribution: number
    }[]
  },
>(snapshot: Snapshot): Snapshot {
  return {
    ...snapshot,
    pot: snapshot.pot + 100,
    seats: snapshot.seats.map((seat) =>
      seat.seatNumber === 2
        ? {
            ...seat,
            stack: seat.stack - 100,
            streetContribution: seat.streetContribution + 100,
            totalContribution: seat.totalContribution + 100,
          }
        : seat,
    ),
  }
}

function transferStacksBetweenSeats<
  Snapshot extends {
    readonly seats: readonly {
      readonly seatNumber: number
      readonly stack: number
    }[]
  },
>(snapshot: Snapshot): Snapshot {
  return {
    ...snapshot,
    seats: snapshot.seats.map((seat) =>
      seat.seatNumber === 2
        ? { ...seat, stack: seat.stack - 100 }
        : seat.seatNumber === 3
          ? { ...seat, stack: seat.stack + 100 }
          : seat,
    ),
  }
}

describe('completed hand history projector', () => {
  test('projects an owner-scoped direct win into preflop and terminal phases', () => {
    const facts = createDirectWinCompletedHandHistoryFacts()

    const history = projectAuthoritativeCompletedHandHistory(facts)

    expect(history).toMatchObject({
      sessionId: COMPLETED_HAND_HISTORY_SESSION_ID,
      handId: facts.handId,
      handNumber: 1,
      pokerRuleSetVersion: POKER_RULE_SET_VERSION,
      participantSeatNumbers: [0, 1, 2, 3, 4, 5],
    })
    expect(history.participants).toHaveLength(6)
    expect(history.participants[0]).toMatchObject({
      seatNumber: 0,
      displayName: '玩家',
      avatarColor: '#0F766E',
    })
    expect(history.phases.map((phase) => phase.phase)).toEqual([
      'preflop',
      'showdown',
    ])
    const preflop = history.phases[0]
    expect(preflop.actions).toHaveLength(1)
    expect(preflop.actions[0]).toMatchObject({
      actionNumber: 1,
      eventSeq: 10,
      action: { type: 'fold' },
      committedAmount: 0,
      streetContributionAfterAction: 0,
    })
    const terminal = history.phases.at(-1)
    if (terminal?.phase !== 'showdown')
      throw new Error('Expected showdown phase.')
    expect(terminal).toMatchObject({
      phase: 'showdown',
      terminationReason: 'complete',
      handCompletedEventSeq: 12,
      communityCards: [],
      uncalledBetReturns: [{ eventSeq: 11, seatNumber: 2, amount: 10 }],
    })
    expect(terminal.privateHands).toEqual(facts.result.participantHands)
    expect(JSON.stringify(history)).not.toContain('remainingDeck')
    expect(Object.isFrozen(history)).toBe(true)
    expect(Object.isFrozen(history.phases)).toBe(true)
    expect(Object.isFrozen(history.phases[0].actions)).toBe(true)
  })

  test('retains empty reached streets when a preflop all-in runs out the board', () => {
    const history = projectAuthoritativeCompletedHandHistory(
      createAllInRunoutFacts(),
    )

    expect(history.phases.map((phase) => phase.phase)).toEqual([
      'preflop',
      'flop',
      'turn',
      'river',
      'showdown',
    ])
    expect(history.phases.slice(1, 4)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: 'flop', actions: [] }),
        expect.objectContaining({ phase: 'turn', actions: [] }),
        expect.objectContaining({ phase: 'river', actions: [] }),
      ]),
    )
    expect(history.phases.map((phase) => phase.communityCards.length)).toEqual([
      0, 3, 4, 5, 5,
    ])
    expect(history.participants[0]).toMatchObject({
      displayName: '玩家',
      avatarColor: '#0F766E',
    })
  })

  test('fails closed when event sequence or terminal result mirrors are damaged', () => {
    const facts = createDirectWinCompletedHandHistoryFacts()
    const duplicatedSequence = {
      ...facts,
      events: facts.events.map((fact, index) =>
        index === 1 ? { ...fact, eventSeq: facts.events[0]!.eventSeq } : fact,
      ),
    }
    const mismatchedCompletion = {
      ...facts,
      events: facts.events.map((fact) =>
        fact.event.type === 'handCompleted'
          ? {
              ...fact,
              event: {
                ...fact.event,
                summary: { ...fact.event.summary, handId: facts.sessionId },
              },
            }
          : fact,
      ),
    }

    expect(() =>
      projectAuthoritativeCompletedHandHistory(duplicatedSequence),
    ).toThrow(CompletedHandHistoryInvariantError)
    expect(() =>
      projectAuthoritativeCompletedHandHistory(mismatchedCompletion),
    ).toThrow(CompletedHandHistoryInvariantError)
  })

  test('fails closed when the final action funding snapshot does not mirror the completed result', () => {
    const facts = createDirectWinCompletedHandHistoryFacts()
    const terminalAction = facts.events.find(
      (fact) => fact.event.type === 'actionCommitted',
    )
    if (terminalAction?.event.type !== 'actionCommitted') {
      throw new Error('Expected terminal action event.')
    }
    const damagedTerminalAction = {
      ...terminalAction.event,
      before: addUnmirroredFunds(terminalAction.event.before),
      after: addUnmirroredFunds(terminalAction.event.after),
    }
    const damagedFacts = {
      ...facts,
      events: facts.events.map((fact) =>
        fact === terminalAction
          ? { ...fact, event: damagedTerminalAction }
          : fact,
      ),
    }

    expect(() => createPrivateEvent(damagedTerminalAction)).not.toThrow()
    expect(() =>
      projectAuthoritativeCompletedHandHistory(damagedFacts),
    ).toThrow(CompletedHandHistoryInvariantError)
  })

  test('fails closed when every action shifts stacks between seats without changing contributions', () => {
    const facts = createShowdownFacts()
    const damagedFacts = {
      ...facts,
      events: facts.events.map((fact) =>
        fact.event.type === 'actionCommitted'
          ? {
              ...fact,
              event: {
                ...fact.event,
                before: transferStacksBetweenSeats(fact.event.before),
                after: transferStacksBetweenSeats(fact.event.after),
              },
            }
          : fact,
      ),
    }

    for (const fact of damagedFacts.events) {
      if (fact.event.type === 'actionCommitted') {
        expect(() => createPrivateEvent(fact.event)).not.toThrow()
      }
    }
    expect(() =>
      projectAuthoritativeCompletedHandHistory(damagedFacts),
    ).toThrow(CompletedHandHistoryInvariantError)
  })

  test('fails closed when deleting a same-street check disconnects the current actor chain', () => {
    const facts = createShowdownFacts()
    const removedCheck = facts.events.find(
      (fact) =>
        fact.event.type === 'actionCommitted' &&
        fact.event.command.action.type === 'check' &&
        fact.event.before.street === 'flop' &&
        fact.event.before.currentActorSeatNumber === 2 &&
        fact.event.after.currentActorSeatNumber === 3,
    )
    if (removedCheck === undefined) {
      throw new Error('Expected an intermediate flop check.')
    }
    const damagedFacts = {
      ...facts,
      events: facts.events.filter((fact) => fact !== removedCheck),
    }

    expect(() =>
      projectAuthoritativeCompletedHandHistory(damagedFacts),
    ).toThrow(CompletedHandHistoryInvariantError)
  })
})
