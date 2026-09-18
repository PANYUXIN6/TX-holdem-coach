import { syncFixtureAnalysis } from '../fixtures/coach/boundaries.js'
import { describe, it, expect } from 'vitest'
import { fixtureBoundary } from '../fixtures/coach/boundaries.js'
import {
  reviewCase,
  decisionInput,
  decisionExplanation,
} from '../fixtures/coach/boundaries.js'
import {
  CoachDecisionExplanationSchema,
  CoachHindsightExplanationSchema,
} from '../../src/agents/coach/decision-context.js'

describe('Coach source and phase boundaries', () => {
  it('rejects complete cases, future board substitution, untrusted input and getters before computation', () => {
    const b = fixtureBoundary(),
      raw = decisionInput()
    expect(() => b.analyze(raw as never)).toThrow()
    expect(() => b.certifyDecision(reviewCase())).toThrow()
    const future = structuredClone(raw)
    future.decision.visibleState.board[0] = { rank: 'J', suit: 'clubs' }
    expect(() => b.certifyDecision(future)).toThrow()
    for (const binding of [
      { ...raw.binding, ownerId: 'other-owner' },
      { ...raw.binding, runId: '00000000-0000-4000-8000-000000000099' },
      {
        ...raw.binding,
        versions: {
          ...raw.binding.versions,
          classifier: { id: 'other', version: 2 },
        },
      },
    ])
      expect(() => b.certifyDecision({ ...raw, binding })).toThrow()
    const futureEvent = structuredClone(raw)
    futureEvent.decision.visibleState.publicActions.push({
      eventSeq: 14,
      street: 'flop',
      seatNumber: 1,
      action: { type: 'fold' },
    })
    expect(() => b.certifyDecision(futureEvent)).toThrow()
    expect(() =>
      b.certifyDecision({
        ...raw,
        get decision() {
          throw Error('getter executed')
        },
      }),
    ).toThrow('coach_invalid_accessor')
    const certified = b.certifyDecision(raw)
    raw.decision.visibleState.board[0] = { rank: 'J', suit: 'clubs' }
    expect(certified.decision.visibleState.board[0]?.rank).toBe('2')
    expect(Object.isFrozen(certified.decision.visibleState.board)).toBe(true)
    expect(() => b.analyze(structuredClone(certified))).toThrow()
  })
  it('holds process assessment invariant under changed legal future settlement', () => {
    const left = reviewCase(),
      right = reviewCase()
    right.auditTruth.actualBoard.push({ rank: 'J', suit: 'clubs' })
    right.auditTruth.runoutTransitions = [
      {
        factId: 'turn',
        eventSeq: 20,
        street: 'turn',
        board: right.auditTruth.actualBoard,
      },
    ]
    right.auditTruth.heroNetChips = 50
    right.auditTruth.potAwards[0]!.awards[0]!.chips = 70
    const a = fixtureBoundary(left),
      b = fixtureBoundary(right),
      ai = a.certifyDecision(decisionInput(left)),
      bi = b.certifyDecision(decisionInput(right))
    expect(ai).toEqual(bi)
    const ap = a.analyze(ai),
      bp = b.analyze(bi)
    expect(ap.assessment).toEqual(bp.assessment)
    expect(() =>
      a.freezeProcess(
        {
          ...ap,
          assessment: { ...ap.assessment, assessment: 'sound' },
        } as never,
        decisionExplanation(),
      ),
    ).toThrow()
    expect(() => a.analyze(bi)).toThrow()
  })
  it('freezes process before hindsight, rejects clones and cross-run instances', () => {
    const b = fixtureBoundary(),
      a = b.analyze(b.certifyDecision(decisionInput()))
    expect(() => b.hindsightContext(a as never)).toThrow()
    const p = b.freezeProcess(a, decisionExplanation()),
      h = b.hindsightContext(p)
    expect(h.contextKind).toBe('hindsight')
    expect(() => b.hindsightContext(Object.freeze({ ...p }))).toThrow()
    expect(() => fixtureBoundary().hindsightContext(p)).toThrow()
    expect(() =>
      b.freezeProcess(a, { ...decisionExplanation(), assessment: 'sound' }),
    ).toThrow()
  })
  it('keeps deterministic output out of both model schemas', () => {
    expect(
      CoachDecisionExplanationSchema.safeParse(decisionExplanation()).success,
    ).toBe(true)
    expect(
      CoachDecisionExplanationSchema.safeParse({
        ...decisionExplanation(),
        evLoss: 0,
      }).success,
    ).toBe(false)
    expect(
      CoachHindsightExplanationSchema.safeParse({
        decisionId: decisionInput().decision.decisionId,
        hindsightExplanation: { text: '结算说明', factRefs: ['award'] },
        alternatives: [],
      }).success,
    ).toBe(false)
  })
})

import { createCoachReviewBoundary } from '../../src/agents/coach/frozen-analysis.js'
import { fixturePorts } from '../fixtures/coach/boundaries.js'

describe('Coach producer and hindsight source admission', () => {
  it('rejects future derivations and source versions before classification', () => {
    const ports = fixturePorts()
    for (const mode of ['future', 'version', 'board'] as const) {
      let classifications = 0
      const b = createCoachReviewBoundary({
        ...ports,
        derive: (input) => {
          const d = ports.derive(input)
          if (mode === 'future') d.facts[0]!.asOfEventSeq = 20
          if (mode === 'version')
            d.versions = { ...d.versions, metrics: { id: 'wrong', version: 2 } }
          if (
            mode === 'board' &&
            d.facts[0]!.status === 'available' &&
            d.facts[0]!.value.kind === 'cards'
          )
            d.facts[0]!.value.cards = [
              { rank: 'J', suit: 'clubs' },
              { rank: '7', suit: 'hearts' },
              { rank: 'Q', suit: 'diamonds' },
            ]
          return d
        },
        classify: (input, derived) => {
          classifications++
          return ports.classify(input, derived)
        },
      })
      expect(() => b.analyze(b.certifyDecision(decisionInput()))).toThrow()
      expect(classifications).toBe(0)
    }
  })
  it('requires every decision process to freeze before any hindsight and rejects non-actual runouts', () => {
    const source = reviewCase(),
      second = structuredClone(source.heroDecisions[0]!)
    second.eventSeq = 18
    second.decisionId = second.decisionId.replace(':12', ':18')
    syncFixtureAnalysis(second)
    source.heroDecisions.push(second)
    const b = fixtureBoundary(source),
      first = b.freezeProcess(
        b.analyze(b.certifyDecision(decisionInput(source))),
        decisionExplanation(),
      )
    expect(() => b.hindsightContext(first)).toThrow('coach_process_incomplete')
    b.freezeProcess(
      b.analyze(b.certifyDecision(decisionInput(source, 1))),
      decisionExplanation(second.decisionId),
    )
    expect(b.hindsightContext(first).contextKind).toBe('hindsight')
    const ports = fixturePorts(),
      bad = createCoachReviewBoundary({
        ...ports,
        projectHindsight: (source, input) => ({
          ...ports.projectHindsight(source, input),
          runoutTransitions: [
            {
              factId: 'not-dealt',
              eventSeq: 20,
              street: 'turn',
              board: [
                ...source.auditTruth.actualBoard,
                { rank: 'J', suit: 'clubs' },
              ],
            },
          ],
        }),
      })
    const p = bad.freezeProcess(
      bad.analyze(bad.certifyDecision(decisionInput())),
      decisionExplanation(),
    )
    expect(() => bad.hindsightContext(p)).toThrow(
      'coach_hindsight_source_mismatch',
    )
  })
})

it('binds evidence to its metric, current table, pot and certified opponent snapshot/position', () => {
  const source = reviewCase()
  source.heroDecisions[0]!.opponentEvidenceSubjects = [
    { seatNumber: 1, personaSnapshotId: 'opponent-v1' },
  ]
  const ports = fixturePorts(source)
  const evidence = {
    evidenceId: 'vpip',
    metric: 'vpip' as const,
    numerator: 8,
    denominator: 10,
    value: 0.8,
    filters: {
      tableSize: 6,
      logicalPosition: 'SB' as const,
      opportunityType: 'vpip' as const,
      potType: 'multiway' as const,
      personaSnapshotId: 'opponent-v1',
    },
    confidence: 'sufficient' as const,
    usableForExploit: true,
    policyVersion: 1,
    asOfEventSeq: 11,
  }
  for (const mismatch of [
    null,
    { opportunityType: 'pfr' },
    { tableSize: 9 },
    { logicalPosition: 'BTN' },
    { potType: 'headsUp' },
    { personaSnapshotId: 'stale-persona' },
  ]) {
    let called = false
    const b = createCoachReviewBoundary({
      ...ports,
      derive: (input) =>
        ({
          ...ports.derive(input),
          opponentEvidence: [
            { ...evidence, filters: { ...evidence.filters, ...mismatch } },
          ],
        }) as ReturnType<typeof ports.derive>,
      classify: (input, derived) => {
        called = true
        return ports.classify(input, derived)
      },
    })
    const run = () => b.analyze(b.certifyDecision(decisionInput(source)))
    if (mismatch) {
      expect(run).toThrow()
      expect(called).toBe(false)
    } else
      expect(run().derived.opponentEvidence[0]!.usableForExploit).toBe(true)
  }
})

it('rejects mismatched statistical opportunity even before an evidence subject can be resolved', () => {
  const ports = fixturePorts(),
    b = createCoachReviewBoundary({
      ...ports,
      derive: (input) => ({
        ...ports.derive(input),
        opponentEvidence: [
          {
            evidenceId: 'wrong',
            metric: 'vpip',
            numerator: 8,
            denominator: 10,
            value: 0.8,
            filters: {
              tableSize: 9,
              logicalPosition: 'CO',
              opportunityType: 'pfr',
              potType: 'multiway',
              personaSnapshotId: 'unknown',
            },
            confidence: 'sufficient',
            usableForExploit: true,
            policyVersion: 1,
            asOfEventSeq: 11,
          },
        ],
      }),
    })
  expect(() => b.analyze(b.certifyDecision(decisionInput()))).toThrow()
})
