import { describe, expect, test } from 'vitest'
import { decodeCompletedHandReviewRow } from '../../src/persistence/completed-hand-review-repository.js'
import { projectReviewDecisionPrefix } from '../../src/sessions/hand-history/completed-hand-review-source.js'
import {
  completedReviewRow,
  reviewOwner,
} from '../fixtures/coach/completed-source.js'

describe('completed Coach source admission', () => {
  test.each([false, true])(
    'loads a complete legal hand and exposes detached safe prefixes (runout=%s)',
    async (allIn) => {
      const result = decodeCompletedHandReviewRow(
        completedReviewRow(allIn),
        await reviewOwner(),
      )
      expect(result.kind).toBe('completed')
      if (result.kind !== 'completed') throw new Error('missing source')
      expect(Object.isFrozen(result.facts)).toBe(true)
      const serialized = JSON.stringify(result.facts)
      for (const field of [
        'remainingDeck',
        'burnedCards',
        'configPayload',
        'stateBeforeStartCommand',
      ])
        expect(serialized).not.toContain(field)
      const action = result.facts.events.find(
        (event) =>
          event.type === 'actionCommitted' &&
          event.action.actorSeatNumber === 0,
      )!
      const prefix = projectReviewDecisionPrefix(result.facts, action.eventSeq)
      expect(
        prefix.events.every((event) => event.eventSeq < action.eventSeq),
      ).toBe(true)
      expect(prefix.target).not.toHaveProperty('after')
      expect(prefix.target).not.toHaveProperty('progression')
      expect(prefix).not.toHaveProperty('result')
      expect(prefix.heroHoleCards).not.toBe(
        result.facts.result.participantHands[0]!.holeCards,
      )
    },
  )
  test('rejects missing persona snapshots, inconsistent versions and missing events', async () => {
    const owner = await reviewOwner()
    const missingPersona = completedReviewRow()
    missingPersona.personas.pop()
    const wrongVersion = completedReviewRow()
    wrongVersion.facts.events[1]!.stateVersionBefore++
    const missingEvent = completedReviewRow()
    missingEvent.facts.events.splice(2, 1)
    for (const row of [missingPersona, wrongVersion, missingEvent])
      expect(() => decodeCompletedHandReviewRow(row, owner)).toThrow()
  })
})

test('rejects a valid but different terminal result before returning a source', async () => {
  const owner = await reviewOwner()
  const row = completedReviewRow(false, 6, false, 'reopen')
  const changed = completedReviewRow(false, 6, true, 'reopen')
  expect(row.facts.completedResultPayload.result.board).not.toEqual(
    changed.facts.completedResultPayload.result.board,
  )
  row.facts.completedResultPayload = changed.facts.completedResultPayload
  expect(() => decodeCompletedHandReviewRow(row, owner)).toThrow()
})
