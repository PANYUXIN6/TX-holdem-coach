import { expect, test } from 'vitest'
import { decodeCompletedHandReviewRow } from '../../src/persistence/completed-hand-review-repository.js'
import { projectReviewDecisionPrefix } from '../../src/sessions/hand-history/completed-hand-review-source.js'
import { buildCoachReviewDecision } from '../../src/agents/coach/review-case-builder.js'
import {
  completedReviewRow,
  reviewOwner,
  reviewExecution,
  fixtureCoachVersions,
} from '../fixtures/coach/completed-source.js'

test.each(
  [6, 7, 8, 9].flatMap((tableSize) =>
    [false, true].map((allIn) => ({ tableSize, allIn })),
  ),
)(
  'rebuilds every real Hero action from its safe prefix (table=$tableSize, runout=$allIn)',
  async ({ tableSize, allIn }) => {
    const result = decodeCompletedHandReviewRow(
      completedReviewRow(allIn, tableSize),
      await reviewOwner(),
    )
    if (result.kind !== 'completed') throw new Error('missing source')
    const execution = await reviewExecution(
      result.facts.sessionId,
      result.facts.handId,
    )
    const actions = result.facts.events.filter(
      (event) =>
        event.type === 'actionCommitted' && event.action.actorSeatNumber === 0,
    )
    expect(actions.length).toBeGreaterThan(0)
    for (const event of actions) {
      if (event.type !== 'actionCommitted') throw new Error('missing action')
      const prefix = projectReviewDecisionPrefix(result.facts, event.eventSeq)
      const built = buildCoachReviewDecision(
        prefix,
        execution,
        fixtureCoachVersions,
      )
      expect(built.decision.analysisInput.seats).toEqual(
        event.action.before.seats,
      )
      expect(built.decision.analysisInput.legalActions).toEqual(
        event.action.legalActionsBefore,
      )
      expect(built.decision.analysisInput.board).toEqual(
        event.action.before.board,
      )
      expect(built.decision.stateVersion).toBe(event.stateVersionBefore)
      expect(built.decision.opponentEvidenceCutoff.asOfEventSeq).toBe(
        event.eventSeq - 1,
      )
      expect(
        built.decision.visibleState.publicActions.every(
          (action) => action.eventSeq < event.eventSeq,
        ),
      ).toBe(true)
      expect(() =>
        buildCoachReviewDecision(
          prefix,
          { ...execution },
          fixtureCoachVersions,
        ),
      ).toThrow('unauthenticated_run_read')
    }
  },
)

test('cumulative short all-ins reopen Hero action and preserve real street-start state through river', async () => {
  const result = decodeCompletedHandReviewRow(
    completedReviewRow(false, 6, false, 'reopen'),
    await reviewOwner(),
  )
  if (result.kind !== 'completed') throw new Error('missing source')
  const execution = await reviewExecution(
    result.facts.sessionId,
    result.facts.handId,
  )
  const decisions = result.facts.events
    .filter(
      (e) => e.type === 'actionCommitted' && e.action.actorSeatNumber === 0,
    )
    .map((e) => {
      if (e.type !== 'actionCommitted') throw new Error('missing action')
      const built = buildCoachReviewDecision(
        projectReviewDecisionPrefix(result.facts, e.eventSeq),
        execution,
        fixtureCoachVersions,
      ).decision
      expect(built.analysisInput.legalActions).toEqual(
        e.action.legalActionsBefore,
      )
      expect(built.analysisInput.seats).toEqual(e.action.before.seats)
      return built
    })
  expect(new Set(decisions.map((d) => d.decisionId)).size).toBe(
    decisions.length,
  )
  const preflop = decisions.filter((d) => d.analysisInput.street === 'preflop')
  expect(preflop).toHaveLength(2)
  expect(
    preflop[1]!.analysisInput.legalActions.some((a) => a.type === 'raise'),
  ).toBe(true)
  expect(decisions.map((d) => d.analysisInput.street)).toEqual([
    'preflop',
    'preflop',
    'flop',
    'turn',
    'river',
  ])
  for (const decision of decisions.slice(2)) {
    expect(decision.streetStartState.status).toBe('available')
    if (decision.streetStartState.status !== 'available')
      throw new Error('missing street start')
    const first = result.facts.events.find(
      (e) =>
        e.type === 'actionCommitted' &&
        e.action.before.street === decision.analysisInput.street,
    )
    if (first?.type !== 'actionCommitted')
      throw new Error('missing street action')
    expect(decision.streetStartState.seats).toEqual(first.action.before.seats)
    expect(decision.streetStartState.pot).toBe(first.action.before.pot)
  }
})
