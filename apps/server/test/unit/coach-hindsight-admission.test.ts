import { describe, expect, it, vi } from 'vitest'
import {
  assertCoachContextSendAllowed,
  createCoachReviewBoundary,
} from '../../src/agents/coach/frozen-analysis.js'
import {
  decisionExplanation,
  decisionInput,
  fixturePorts,
  reviewCase,
} from '../fixtures/coach/boundaries.js'

function safeSource(c = reviewCase()) {
  return {
    reviewContextVersion: c.reviewContextVersion,
    binding: c.binding,
    tableSize: c.tableSize,
    completedEventSeq: c.completedEventSeq,
    heroDecisions: c.heroDecisions,
  }
}

describe('Coach deferred complete-source admission', () => {
  it('reads the complete source only after every process freezes and closes sends before reading', () => {
    const c = reviewCase()
    const second = structuredClone(c.heroDecisions[0]!)
    second.eventSeq = 18
    second.decisionId = second.decisionId.replace(':12', ':18')
    second.opponentEvidenceCutoff.asOfEventSeq = 17
    c.heroDecisions.push(second)
    let prepared: ReturnType<typeof boundary.decisionContext>
    const read = vi.fn(() => {
      expect(() => assertCoachContextSendAllowed(prepared)).toThrow(
        'coach_process_phase_closed',
      )
      return c
    })
    const boundary = createCoachReviewBoundary({
      ...fixturePorts(c),
      source: safeSource(c),
      readHindsightSource: read,
    })
    const first = boundary.analyze(boundary.certifyDecision(decisionInput(c)))
    prepared = boundary.decisionContext(first)
    const process = boundary.freezeProcess(first, decisionExplanation())
    expect(() => boundary.beginHindsight()).toThrow('coach_process_incomplete')
    expect(() => boundary.hindsightContext(process)).toThrow(
      'coach_process_incomplete',
    )
    expect(read).not.toHaveBeenCalled()
    const other = createCoachReviewBoundary(fixturePorts(c))
    expect(() => other.hindsightContext(process)).toThrow(
      'coach_process_incomplete',
    )
    boundary.freezeProcess(
      boundary.analyze(boundary.certifyDecision(decisionInput(c, 1))),
      decisionExplanation(second.decisionId),
    )
    expect(read).not.toHaveBeenCalled()
    expect(() => assertCoachContextSendAllowed(prepared)).not.toThrow()
    const hindsight = boundary.hindsightContext(process)
    expect(hindsight.facts.heroNetChips).toBe(c.auditTruth.heroNetChips)
    expect(boundary.hindsightContext(process)).toBe(hindsight)
    boundary.beginHindsight()
    expect(read).toHaveBeenCalledTimes(1)
    expect(() => boundary.assertHindsightReady()).not.toThrow()
    expect(() => assertCoachContextSendAllowed(prepared)).toThrow(
      'coach_process_phase_closed',
    )
  })

  it.each(['binding', 'manifest', 'cards', 'decision'] as const)(
    'rejects %s corruption after freezing without reopening the process or retrying the source',
    (mode) => {
      const c = reviewCase(),
        bad = structuredClone(c)
      if (mode === 'binding')
        bad.binding.runId = '00000000-0000-4000-8000-000000000099'
      if (mode === 'manifest') bad.completedEventSeq++
      if (mode === 'cards')
        bad.auditTruth.actualBoard[0] =
          bad.auditTruth.actualHoleCards[0]!.cards[0]
      if (mode === 'decision') bad.heroDecisions[0]!.stateVersion++
      const read = vi.fn(() => bad)
      const boundary = createCoachReviewBoundary({
        ...fixturePorts(c),
        source: safeSource(c),
        readHindsightSource: read,
      })
      const analysis = boundary.analyze(
        boundary.certifyDecision(decisionInput(c)),
      )
      const context = boundary.decisionContext(analysis)
      const process = boundary.freezeProcess(analysis, decisionExplanation())
      expect(read).not.toHaveBeenCalled()
      expect(() => boundary.hindsightContext(process)).toThrow()
      expect(() => boundary.assertHindsightReady()).toThrow()
      expect(() => boundary.beginHindsight()).toThrow(
        'coach_hindsight_admission_failed',
      )
      expect(read).toHaveBeenCalledTimes(1)
      expect(() => assertCoachContextSendAllowed(context)).toThrow(
        'coach_process_phase_closed',
      )
    },
  )

  it('requires actual complete-source validation even for an empty decision list', () => {
    const c = reviewCase()
    c.heroDecisions = []
    const read = vi.fn(() => c)
    const boundary = createCoachReviewBoundary({
      ...fixturePorts(c),
      source: safeSource(c),
      readHindsightSource: read,
    })
    expect(read).not.toHaveBeenCalled()
    expect(() => boundary.assertHindsightReady()).toThrow(
      'coach_hindsight_not_ready',
    )
    boundary.beginHindsight()
    expect(read).toHaveBeenCalledTimes(1)
    expect(() => boundary.assertHindsightReady()).not.toThrow()
    const bad = structuredClone(c)
    bad.auditTruth.actualHoleCards.push(bad.auditTruth.actualHoleCards[0]!)
    const rejected = createCoachReviewBoundary({
      ...fixturePorts(c),
      source: safeSource(c),
      readHindsightSource: () => bad,
    })
    expect(() => rejected.beginHindsight()).toThrow()
    expect(() => rejected.assertHindsightReady()).toThrow()
  })

  it('rejects audit data and invalid decision order at the process-source entry without reading hindsight', () => {
    const c = reviewCase(),
      read = vi.fn(() => c)
    expect(() =>
      createCoachReviewBoundary({
        ...fixturePorts(c),
        source: c,
        readHindsightSource: read,
      }),
    ).toThrow()
    const invalid = safeSource(c)
    invalid.heroDecisions.push(structuredClone(invalid.heroDecisions[0]!))
    expect(() =>
      createCoachReviewBoundary({
        ...fixturePorts(c),
        source: invalid,
        readHindsightSource: read,
      }),
    ).toThrow()
    expect(read).not.toHaveBeenCalled()
  })
})
