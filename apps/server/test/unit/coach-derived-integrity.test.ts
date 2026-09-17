import { expect, test, vi } from 'vitest'
import { createCoachReviewBoundary } from '../../src/agents/coach/frozen-analysis.js'
import { projectCoachDecisionFacts } from '../../src/agents/coach/decision-fact-projector.js'
import { computeCoachActionOutcomes } from '../../src/agents/coach/action-outcomes.js'
import {
  fixturePorts,
  decisionInput,
  fixtureSupportedBaseline,
} from '../fixtures/coach/boundaries.js'

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

test('rejects baseline references under unsupported before classification', () => {
  const ports = fixturePorts(),
    classify = vi.fn(ports.classify)
  const boundary = createCoachReviewBoundary({
    ...ports,
    classify,
    derive: (input) => ({
      ...ports.derive(input),
      actionOutcomes: computeCoachActionOutcomes(input, [
        { actionId: 'ghost-baseline', action: input.decision.actualAction },
      ]),
    }),
  })
  expect(() =>
    boundary.analyze(boundary.certifyDecision(decisionInput())),
  ).toThrow('coach_baseline_outcome_mismatch')
  expect(classify).not.toHaveBeenCalled()
})

test.each(['valid', 'unknownId', 'wrongAction', 'wrongSize'] as const)(
  'binds supported baseline outcome identity and semantics: %s',
  (mode) => {
    const ports = fixturePorts(),
      classify = vi.fn(ports.classify)
    const boundary = createCoachReviewBoundary({
      ...ports,
      classify,
      derive: (input) => {
        const action = { type: 'bet' as const, targetStreetCommitment: 60 }
        return {
          ...ports.derive(input),
          baseline: fixtureSupportedBaseline(
            input,
            mode === 'wrongAction'
              ? { type: 'check' }
              : mode === 'wrongSize'
                ? { type: 'bet', targetStreetCommitment: 80 }
                : action,
          ),
          actionOutcomes: computeCoachActionOutcomes(input, [
            { actionId: mode === 'unknownId' ? 'ghost' : 'fixture', action },
          ]),
        }
      },
    })
    const analyze = () =>
      boundary.analyze(boundary.certifyDecision(decisionInput()))
    if (mode === 'valid') {
      expect(analyze().derived.actionOutcomes.outcomes).toHaveLength(2)
      expect(classify).toHaveBeenCalledOnce()
    } else {
      expect(analyze).toThrow('coach_baseline_outcome_mismatch')
      expect(classify).not.toHaveBeenCalled()
    }
  },
)
