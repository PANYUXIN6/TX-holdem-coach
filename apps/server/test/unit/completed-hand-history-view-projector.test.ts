import { describe, expect, test } from 'vitest'
import type { HandHistoryResponse } from '@tx-holdem-coach/contracts'
import { projectAuthoritativeCompletedHandHistory } from '../../src/sessions/hand-history/completed-hand-history-projector.js'
import { projectCompletedHandHistoryView } from '../../src/sessions/hand-history/completed-hand-history-view-projector.js'
import {
  createDirectWinCompletedHandHistoryFacts,
  createShowdownCompletedHandHistoryFacts,
} from '../fixtures/completed-hand-history-fixture.js'

function terminalOf(history: HandHistoryResponse['history']) {
  const terminal = history.phases.at(-1)
  if (terminal?.phase !== 'showdown')
    throw new Error('Expected showdown phase.')
  return terminal
}

describe('completed hand history visibility projector', () => {
  test('keeps the user and real showdown participants visible while masking a folded AI', () => {
    const privateHistory = projectAuthoritativeCompletedHandHistory(
      createShowdownCompletedHandHistoryFacts(),
    )

    const response = projectCompletedHandHistoryView(privateHistory, 'public')
    const terminal = terminalOf(response.history)

    expect(response.view).toBe('public')
    expect(
      terminal.revealedHands
        .filter((hand) => hand.holeCards !== null)
        .map((hand) => hand.seatNumber),
    ).toEqual([0, 1, 2, 3, 5])
    expect(terminal.revealedHands[4]).toEqual({
      seatNumber: 4,
      holeCards: null,
      handEvaluation: null,
    })
    expect(terminal.revealedHands[0]?.handEvaluation).toBeNull()
  })

  test('reveals all cards only for audit requests without mutating the private source', () => {
    const privateHistory = projectAuthoritativeCompletedHandHistory(
      createDirectWinCompletedHandHistoryFacts(),
    )
    const source = JSON.stringify(privateHistory)

    const publicBefore = projectCompletedHandHistoryView(
      privateHistory,
      'public',
    )
    const audit = projectCompletedHandHistoryView(privateHistory, 'auditReveal')
    const publicAfter = projectCompletedHandHistoryView(
      privateHistory,
      'public',
    )

    expect(terminalOf(publicBefore.history).revealedHands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          seatNumber: 0,
          holeCards: expect.any(Array),
          handEvaluation: null,
        }),
        expect.objectContaining({
          seatNumber: 1,
          holeCards: null,
          handEvaluation: null,
        }),
      ]),
    )
    expect(terminalOf(audit.history).revealedHands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          seatNumber: 0,
          holeCards: expect.any(Array),
        }),
        expect.objectContaining({
          seatNumber: 1,
          holeCards: expect.any(Array),
        }),
      ]),
    )
    expect(terminalOf(audit.history).revealedHands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ handEvaluation: null }),
      ]),
    )
    expect(publicAfter).toEqual(publicBefore)
    expect(JSON.stringify(privateHistory)).toBe(source)
    expect(JSON.stringify(publicBefore)).not.toContain('privateHands')
    expect(JSON.stringify(publicBefore)).not.toContain('startingHandCategory')
    expect(JSON.stringify(publicBefore)).not.toContain('comparisonGrade')
  })
})
