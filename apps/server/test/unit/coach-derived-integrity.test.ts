import { projectCoachRangeFacts } from '../../src/agents/coach/range-fact-projector.js'
import { computeCoachActionOutcomes } from '../../src/agents/coach/action-outcomes.js'
import { expect, test, vi } from 'vitest'
import { createCoachReviewBoundary } from '../../src/agents/coach/frozen-analysis.js'
import { projectCoachDecisionFacts } from '../../src/agents/coach/decision-fact-projector.js'
import { fixturePorts, decisionInput } from '../fixtures/coach/boundaries.js'

test.each([
  'value',
  'source',
  'renamed',
  'notApplicable',
  'renamedNotApplicable',
] as const)(
  'rejects rewritten public metric %s before classification',
  (change) => {
    const ports = fixturePorts()
    const classify = vi.fn(ports.classify)
    const boundary = createCoachReviewBoundary({
      ...ports,
      classify,
      derive: (input) => {
        const derived = ports.derive(input)
        const projected = structuredClone([
          ...projectCoachDecisionFacts(input, derived.metrics),
        ])
        const pot = projected.find(
          (f) => f.factId === 'metrics.contestablePot',
        )!
        if (pot.status !== 'available' || pot.value.kind !== 'chips')
          throw new Error('missing pot')
        if (change === 'value') pot.value.value = 999999
        if (change === 'source')
          pot.sourceRefs = [
            { kind: 'algorithm', algorithmId: 'wrongAlgorithm', version: 1 },
          ]
        if (change === 'renamed') {
          pot.factId = 'renamedPot'
          pot.value.value = 999999
        }
        if (change === 'renamedNotApplicable') {
          const odds = projected.find((f) => f.factId === 'metrics.potOdds')!
          expect(odds.status).toBe('notApplicable')
          const original = structuredClone(odds)
          odds.factId = 'renamedOdds'
          expect(odds).toEqual({ ...original, factId: 'renamedOdds' })
        }
        if (change === 'notApplicable') {
          const index = projected.findIndex(
            (f) => f.factId === 'metrics.potOdds',
          )
          const odds = projected[index]!
          expect(odds.status).toBe('notApplicable')
          projected[index] = {
            ...pot,
            factId: 'renamedOdds',
            value: {
              kind: 'ratio',
              metric: 'potOdds',
              value: { numerator: 1, denominator: 2 },
            },
          }
        }
        return { ...derived, facts: [...derived.facts, ...projected] }
      },
    })
    expect(() =>
      boundary.analyze(boundary.certifyDecision(decisionInput())),
    ).toThrow('coach_metric_fact_mismatch')
    expect(classify).not.toHaveBeenCalled()
  },
)

test('projects each metric from its own provenance and accepts the unmodified projection', () => {
  const ports = fixturePorts()
  const boundary = createCoachReviewBoundary({
    ...ports,
    derive: (input) => {
      const derived = ports.derive(input)
      const facts = projectCoachDecisionFacts(input, derived.metrics)
      const pot = facts.find((f) => f.factId === 'metrics.contestablePot')!
      expect(pot.sourceRefs).toContainEqual({
        kind: 'algorithm',
        algorithmId: 'contestablePotProjector',
        version: 1,
      })
      expect(pot.sourceRefs).toContainEqual({
        kind: 'rule',
        pokerRuleSetVersion: input.binding.pokerRuleSetVersion,
      })
      expect(pot.sourceRefs).not.toContainEqual({
        kind: 'algorithm',
        algorithmId: 'decisionMetricsEngine',
        version: 1,
      })
      expect(
        facts.find((f) => f.factId === 'metrics.potOdds')!.sourceRefs,
      ).toContainEqual({
        kind: 'algorithm',
        algorithmId: 'decisionMetricsEngine',
        version: 1,
      })
      return { ...derived, facts: [...derived.facts, ...facts] }
    },
  })
  expect(
    boundary.analyze(boundary.certifyDecision(decisionInput())).derived.facts,
  ).toHaveLength(3)
})

test.each(['clone', 'otherInput', 'outcomes', 'numericFact'] as const)(
  'rejects unauthenticated or mismatched range projection: %s',
  (mode) => {
    const ports = fixturePorts()
    const classify = vi.fn(ports.classify)
    const boundary = createCoachReviewBoundary({
      ...ports,
      classify,
      derive: (input) => {
        const derived = ports.derive(input)
        if (mode === 'clone')
          return {
            ...derived,
            rangeAnalysis: structuredClone(derived.rangeAnalysis),
          }
        if (mode === 'otherInput') {
          const other = createCoachReviewBoundary(fixturePorts())
          const otherInput = other.certifyDecision(decisionInput())
          return {
            ...derived,
            rangeAnalysis: ports.derive(otherInput).rangeAnalysis,
          }
        }
        if (mode === 'outcomes')
          return {
            ...derived,
            actionOutcomes: computeCoachActionOutcomes(input),
          }
        return {
          ...derived,
          facts: [
            ...derived.facts,
            {
              ...derived.facts[0]!,
              factId: 'rangeFact',
              value: {
                kind: 'opponentRangeAnalysis' as const,
                opponentRangeAnalysis: {
                  ...derived.rangeAnalysis.opponentRangeAnalysis,
                  reasonCode: 'fabricatedReason',
                },
              },
              status: 'available' as const,
            },
          ],
        }
      },
    })
    expect(() =>
      boundary.analyze(boundary.certifyDecision(decisionInput())),
    ).toThrow()
    expect(classify).not.toHaveBeenCalled()
  },
)

test('rejects a favorable conclusion when range evidence is unavailable', () => {
  const ports = fixturePorts()
  const boundary = createCoachReviewBoundary({
    ...ports,
    classify: (input, derived) => ({
      ...ports.classify(input, derived),
      conditionalConclusion: 'favorableAcrossModeledRanges',
    }),
  })
  expect(() =>
    boundary.analyze(boundary.certifyDecision(decisionInput())),
  ).toThrow('coach_conclusion_evidence')
})

test('projects authenticated range facts and rejects unavailable renaming or source changes', () => {
  for (const mode of ['valid', 'renamed', 'source'] as const) {
    const ports = fixturePorts(),
      classify = vi.fn(ports.classify)
    const boundary = createCoachReviewBoundary({
      ...ports,
      classify,
      derive: (input) => {
        const derived = ports.derive(input)
        const facts = structuredClone([
          ...projectCoachRangeFacts(
            input,
            derived.metrics,
            derived.actionOutcomes,
            derived.rangeAnalysis,
          ),
        ])
        expect(facts).toHaveLength(4)
        expect(
          facts.every((f) => f.status === 'unavailable' && !('value' in f)),
        ).toBe(true)
        if (mode === 'renamed') facts[0]!.factId = 'renamedRange'
        if (mode === 'source')
          facts[0]!.sourceRefs = [
            { kind: 'algorithm', algorithmId: 'invented', version: 1 },
          ]
        return { ...derived, facts: [...derived.facts, ...facts] }
      },
    })
    const run = () =>
      boundary.analyze(boundary.certifyDecision(decisionInput()))
    if (mode === 'valid') {
      expect(run().derived.facts).toHaveLength(5)
      expect(classify).toHaveBeenCalledOnce()
    } else {
      expect(run).toThrow('coach_range_fact_mismatch')
      expect(classify).not.toHaveBeenCalled()
    }
  }
})
