import { expect, test } from 'vitest'
import { decodeCompletedHandReviewRow } from '../../src/persistence/completed-hand-review-repository.js'
import { createCoachReviewSourceAdapter } from '../../src/agents/coach/review-source-adapter.js'
import { createCoachReviewBoundary } from '../../src/agents/coach/frozen-analysis.js'
import { computeCoachDecisionMetrics } from '../../src/agents/coach/decision-metrics.js'
import { computeCoachActionOutcomes } from '../../src/agents/coach/action-outcomes.js'
import { projectCoachDecisionFacts } from '../../src/agents/coach/decision-fact-projector.js'
import { buildDecisionAnalysisCore } from '../../src/poker/decision-analysis-core.js'
import {
  completedReviewRow,
  reviewOwner,
  reviewExecution,
  fixtureCoachVersions,
} from '../fixtures/coach/completed-source.js'

test('real loaded source → safe Builder → certified core and exact outcomes; cancellation revokes memory', async () => {
  const loaded = decodeCompletedHandReviewRow(
    completedReviewRow(false, 6, false, 'reopen'),
    await reviewOwner(),
  )
  if (loaded.kind !== 'completed') throw new Error('missing source')
  const abort = new AbortController()
  const adapter = createCoachReviewSourceAdapter({
    facts: loaded.facts,
    execution: await reviewExecution(
      loaded.facts.sessionId,
      loaded.facts.handId,
    ),
    supported: fixtureCoachVersions,
    signal: abort.signal,
  })
  const boundary = createCoachReviewBoundary({
    source: adapter.source,
    readHindsightSource: adapter.readHindsightSource,
    derive: () => {
      throw new Error('not used')
    },
    classify: () => {
      throw new Error('not used')
    },
    projectHindsight: () => {
      throw new Error('not used')
    },
  })
  for (const decision of adapter.source.heroDecisions) {
    const certified = boundary.certifyDecision({
      reviewContextVersion: 1,
      binding: adapter.source.binding,
      tableSize: adapter.source.tableSize,
      decision,
    })
    const metrics = computeCoachDecisionMetrics(certified)
    const core = buildDecisionAnalysisCore(decision.analysisInput)
    expect(metrics.normalizedSpot).toEqual(core.normalizedSpot)
    expect(metrics.handFeatures).toEqual(core.handFeatures)
    expect(metrics.currentMetrics).toEqual(core.currentMetrics)
    const streetFact = metrics.factManifest.find(
      (f) => f.factId === 'metrics.streetStartMetrics',
    )!
    expect(streetFact.status).toBe(decision.streetStartState.status)
    if (decision.streetStartState.status === 'available') {
      expect(streetFact.sourceRefs[0]!.source).toMatchObject({
        kind: 'streetStartState',
        eventSeq: decision.streetStartState.eventSeq,
      })
      expect(metrics.streetStartMetrics.status).toBe('available')
    }
    expect(
      projectCoachDecisionFacts(certified, metrics).length,
    ).toBeGreaterThan(0)
    expect(() => computeCoachDecisionMetrics({ ...certified })).toThrow(
      'coach_uncertified_input',
    )
    const outcomes = computeCoachActionOutcomes(certified, [
      { actionId: 'fixture', action: decision.actualAction },
    ])
    expect(outcomes.outcomes).toHaveLength(1)
    expect(outcomes.outcomes[0]!.references).toHaveLength(2)
  }
  expect(adapter.readHindsightSource().auditTruth.actualBoard).toEqual(
    loaded.facts.result.board,
  )
  abort.abort()
  expect(adapter.readHindsightSource).toThrow()
})

test('changing a legally completed future board cannot change the first Hero decision or metrics', async () => {
  const results = []
  const boards = []
  for (const reverseFutureDeck of [false, true]) {
    const loaded = decodeCompletedHandReviewRow(
      completedReviewRow(false, 6, reverseFutureDeck),
      await reviewOwner(),
    )
    if (loaded.kind !== 'completed') throw new Error('missing source')
    const adapter = createCoachReviewSourceAdapter({
      facts: loaded.facts,
      execution: await reviewExecution(
        loaded.facts.sessionId,
        loaded.facts.handId,
      ),
      supported: fixtureCoachVersions,
      signal: new AbortController().signal,
    })
    const boundary = createCoachReviewBoundary({
      source: adapter.source,
      readHindsightSource: adapter.readHindsightSource,
      derive: () => {
        throw new Error('unused')
      },
      classify: () => {
        throw new Error('unused')
      },
      projectHindsight: () => {
        throw new Error('unused')
      },
    })
    const decision = adapter.source.heroDecisions[0]!
    expect(decision.analysisInput.board).toEqual([])
    const certified = boundary.certifyDecision({
      reviewContextVersion: 1,
      binding: adapter.source.binding,
      tableSize: adapter.source.tableSize,
      decision,
    })
    results.push({
      decision,
      metrics: computeCoachDecisionMetrics(certified),
      outcomes: computeCoachActionOutcomes(certified),
    })
    boards.push(loaded.facts.result.board)
    adapter.release()
  }
  expect(boards[0]).not.toEqual(boards[1])
  expect(results[0]).toEqual(results[1])
})

test('an all-in blind produces zero Hero decisions but still requires complete hindsight admission', async () => {
  const loaded = decodeCompletedHandReviewRow(
    completedReviewRow(false, 6, false, 'zeroHero'),
    await reviewOwner(),
  )
  if (loaded.kind !== 'completed') throw new Error('missing source')
  const adapter = createCoachReviewSourceAdapter({
    facts: loaded.facts,
    execution: await reviewExecution(
      loaded.facts.sessionId,
      loaded.facts.handId,
    ),
    supported: fixtureCoachVersions,
    signal: new AbortController().signal,
  })
  expect(adapter.source.heroDecisions).toEqual([])
  let reads = 0
  const boundary = createCoachReviewBoundary({
    source: adapter.source,
    readHindsightSource: () => {
      reads++
      return adapter.readHindsightSource()
    },
    derive: () => {
      throw new Error('unused')
    },
    classify: () => {
      throw new Error('unused')
    },
    projectHindsight: () => {
      throw new Error('unused')
    },
  })
  expect(reads).toBe(0)
  expect(() => boundary.assertHindsightReady()).toThrow()
  boundary.beginHindsight()
  boundary.assertHindsightReady()
  expect(reads).toBe(1)
  adapter.release()
})
