import { expect, test } from 'vitest'
import type { CoachRangeAnalysis } from '@tx-holdem-coach/contracts'
import { createCoachReviewBoundary } from '../../src/agents/coach/frozen-analysis.js'
import { createCoachReviewContractValidator } from '../../src/agents/coach/review-contract-validator.js'
import {
  analyzeCoachOpponentRanges,
  analyzeUncoveredCoachRanges,
  assertCertifiedCoachRangeAnalysis,
} from '../../src/agents/coach/range-analysis.js'
import { computeCoachDecisionMetrics } from '../../src/agents/coach/decision-metrics.js'
import { computeCoachActionOutcomes } from '../../src/agents/coach/action-outcomes.js'
import { projectCoachRangeFacts } from '../../src/agents/coach/range-fact-projector.js'
import { createStaticOpponentRangeRepository } from '../../src/poker-range/opponent-range-repository.js'
import { RANGE_HAND_CLASSES } from '../../src/poker-range/opponent-range-pack.js'
import { createRangeMatchContext } from '../../src/poker-range/range-scenario.js'
import { normalizeDecisionSpot } from '../../src/poker/decision-spot.js'
import {
  reviewCase,
  decisionInput,
  fixtureBoundary,
  fixturePorts,
  boardFact,
  decisionExplanation,
  syncFixtureAnalysis,
} from '../fixtures/coach/boundaries.js'
import { makeOpponentRangePack } from '../fixtures/opponent-range-pack.js'

function scenario(futureResponder = false, forcedRunout = false) {
  const source = reviewCase()
  const decision = source.heroDecisions[0]!
  decision.street = 'river'
  decision.decisionId = `${source.binding.handId}:river:${decision.eventSeq}`
  decision.visibleState.heroHoleCards = [
    { rank: 'A', suit: 'spades' },
    { rank: 'K', suit: 'spades' },
  ]
  decision.visibleState.board = [
    { rank: 'Q', suit: 'spades' },
    { rank: 'J', suit: 'spades' },
    { rank: 'T', suit: 'spades' },
    { rank: '2', suit: 'clubs' },
    { rank: '7', suit: 'hearts' },
  ]
  for (const seat of decision.visibleState.seats) {
    if (seat.seatNumber === 1) {
      Object.assign(seat, {
        status: 'allIn',
        stack: 0,
        streetCommitment: 100,
        totalCommitment: 120,
      })
    } else if (seat.seatNumber === 2) {
      Object.assign(
        seat,
        futureResponder
          ? {
              status: 'active',
              stack: 1000,
              streetCommitment: 0,
              totalCommitment: 20,
            }
          : {
              status: 'allIn',
              stack: 0,
              streetCommitment: 50,
              totalCommitment: 70,
            },
      )
    } else if (seat.seatNumber > 2) {
      seat.status = 'folded'
    }
  }
  if (forcedRunout) {
    decision.street = 'flop'
    decision.decisionId = `${source.binding.handId}:flop:${decision.eventSeq}`
    decision.visibleState.board = decision.visibleState.board.slice(0, 3)
    decision.visibleState.seats[0]!.stack = 100
  }
  decision.actualAction = { type: forcedRunout ? 'allIn' : 'call' }
  if (decision.streetStartState.status === 'available')
    decision.streetStartState.street = decision.street
  syncFixtureAnalysis(decision)
  const input = fixtureBoundary(source).certifyDecision(decisionInput(source))
  const metrics = computeCoachDecisionMetrics(input)
  const actionOutcomes = computeCoachActionOutcomes(input)
  const spot = normalizeDecisionSpot(input.decision.analysisInput)
  const ranges = [1, 2].map((seatNumber) => {
    const { effectiveStackBb, ...context } = createRangeMatchContext(
      input.decision.analysisInput,
      spot,
      seatNumber,
    )
    return {
      rangeId: `opponent-${seatNumber}`,
      sourceRefs: ['fixture-source'],
      applicability: {
        ...context,
        effectiveStackIntervalBb: {
          min: effectiveStackBb,
          max: effectiveStackBb,
        },
      },
      matchStatus: 'matched' as const,
      differences: [],
      limitations: ['synthetic fixture'],
      weights: RANGE_HAND_CLASSES.map((handClass) => ({
        handClass,
        relativeComboWeightBasisPoints:
          forcedRunout || handClass === (seatNumber === 1 ? 'AA' : 'KK')
            ? 10000
            : 0,
      })),
    }
  })
  const raw = makeOpponentRangePack({
    initialRanges: ranges,
    coverageManifest: ranges.map((range) => ({
      rangeId: range.rangeId,
      status: 'matched',
      limitations: ['synthetic fixture'],
    })),
    jointScenarios: [
      {
        scenarioId: 'base',
        name: 'synthetic base',
        sourceRefs: ['fixture-source'],
        initialRangeIds: ranges.map((range) => range.rangeId),
        updateRuleIds: [],
        allowUnmodeledActions: true,
        limitations: ['synthetic fixture'],
      },
    ],
  })
  const pack = createStaticOpponentRangeRepository([raw]).read({
    reference: { datasetId: raw.datasetId, datasetVersion: raw.datasetVersion },
    usage: 'pinnedRun',
  })
  return {
    source,
    input,
    metrics,
    actionOutcomes,
    pack,
    dataDependencies: [
      {
        id: `opponent-range-pack/${pack.datasetId}`,
        version: pack.datasetVersion,
      },
    ],
  }
}

test('certified multiway terminal call projects exact eligible pots, range sources and blocker chart', async () => {
  const request = scenario()
  const projection = await analyzeCoachOpponentRanges(request)
  const facts = projectCoachRangeFacts(
    request.input,
    request.metrics,
    request.actionOutcomes,
    projection,
  )
  expect(facts.map((fact) => fact.status)).toEqual([
    'available',
    'available',
    'available',
    'unavailable',
  ])
  expect(
    facts.every((fact) =>
      fact.sourceRefs.some((ref) => ref.kind === 'rangeModel'),
    ),
  ).toBe(true)
  expect(projection.opponentRangeAnalysis.status).toBe('available')
  expect(projection.jointEquityAnalysis.status).toBe('available')
  expect(projection.conditionalCallEv.status).toBe('available')
  if (
    projection.opponentRangeAnalysis.status !== 'available' ||
    projection.jointEquityAnalysis.status !== 'available' ||
    projection.conditionalCallEv.status !== 'available'
  )
    throw new Error('expected complete analysis')
  expect(projection.opponentRangeAnalysis.sources).toEqual(request.pack.sources)
  expect(
    projection.opponentRangeAnalysis.scenarios[0]!.opponents.map(
      (opponent) => opponent.seatNumber,
    ),
  ).toEqual([1, 2])
  expect(projection.rangeCharts.map((chart) => chart.seatNumber)).toEqual([
    1, 2,
  ])
  for (const [index, handClass] of ['AA', 'KK'].entries()) {
    expect(projection.rangeCharts[index]!.cells).toHaveLength(169)
    expect(
      projection.rangeCharts[index]!.cells.find(
        (cell) => cell.handClass === handClass,
      ),
    ).toMatchObject({
      relativeComboWeightBasisPoints: 10000,
      availableComboCount: 3,
      normalizedMass: 1,
    })
  }
  const equity = projection.jointEquityAnalysis.scenarios[0]!
  expect(equity.method).toBe('exactEnumeration')
  expect(equity.totalStandardError).toBeNull()
  expect(equity.totalConfidenceInterval).toBeNull()
  expect(
    equity.pots.map((pot) => ({
      amount: pot.amount,
      eligibleSeatNumbers: pot.eligibleSeatNumbers,
    })),
  ).toEqual([
    { amount: 120, eligibleSeatNumbers: [0, 1, 2] },
    { amount: 150, eligibleSeatNumbers: [0, 1, 2] },
    { amount: 100, eligibleSeatNumbers: [0, 1] },
  ])
  expect(equity.expectedHeroReturn).toBe(370)
  expect(projection.conditionalCallEv.scenarios[0]).toMatchObject({
    amountActuallyAtRisk: 100,
    callEvVersusFold: 270,
    confidenceInterval: null,
  })
  expect(() =>
    assertCertifiedCoachRangeAnalysis(
      projection,
      request.input,
      request.metrics,
      request.actionOutcomes,
    ),
  ).not.toThrow()
  expect(() =>
    assertCertifiedCoachRangeAnalysis(
      structuredClone(projection),
      request.input,
      request.metrics,
      request.actionOutcomes,
    ),
  ).toThrow('coach_untrusted_range_analysis')
})

test('preserves coverage-only limitations and joint scenario sources through facts, model context and report', async () => {
  const request = scenario()
  const raw = structuredClone(request.pack)
  raw.coverageManifest[0]!.limitations = [
    'coverage-only restriction',
    'synthetic fixture',
  ]
  raw.sources.push({ ...raw.sources[0]!, sourceId: 'wide-source' })
  raw.jointScenarios.push({
    ...raw.jointScenarios[0]!,
    scenarioId: 'wide',
    name: 'wide',
    sourceRefs: ['wide-source'],
  })
  const pack = createStaticOpponentRangeRepository([raw]).read({
    reference: { datasetId: raw.datasetId, datasetVersion: raw.datasetVersion },
    usage: 'pinnedRun',
  })
  request.source.auditTruth.actualBoard = structuredClone(
    request.input.decision.visibleState.board,
  )
  let projection: CoachRangeAnalysis
  const boundary = createCoachReviewBoundary({
    ...fixturePorts(request.source),
    derive: (input) => ({
      metrics,
      actionOutcomes,
      rangeAnalysis: projection,
      versions: input.binding.versions,
      asOfEventSeq: input.decision.opponentEvidenceCutoff.asOfEventSeq,
      facts: [
        boardFact(input),
        ...projectCoachRangeFacts(input, metrics, actionOutcomes, projection),
      ],
      opponentEvidence: [],
    }),
  })
  const input = boundary.certifyDecision(decisionInput(request.source))
  const metrics = computeCoachDecisionMetrics(input)
  const actionOutcomes = computeCoachActionOutcomes(input)
  projection = await analyzeCoachOpponentRanges({
    ...request,
    pack,
    input,
    metrics,
    actionOutcomes,
  })
  const analysis = boundary.analyze(input)
  const context = boundary.decisionContext(analysis)
  const facts = context.derived.facts

  const rangeFact = facts.find(
    (fact) =>
      fact.status === 'available' &&
      fact.value.kind === 'opponentRangeAnalysis',
  )!
  expect(rangeFact).toMatchObject({
    value: {
      opponentRangeAnalysis: {
        scenarios: [
          {
            scenarioId: 'base',
            sourceRefs: ['fixture-source'],
            opponents: [
              expect.objectContaining({
                limitations: ['synthetic fixture', 'coverage-only restriction'],
              }),
              expect.anything(),
            ],
          },
          {
            scenarioId: 'wide',
            sourceRefs: ['wide-source'],
            opponents: [
              expect.objectContaining({
                limitations: ['synthetic fixture', 'coverage-only restriction'],
              }),
              expect.anything(),
            ],
          },
        ],
      },
    },
  })
  expect(context.derived.rangeAnalysis.opponentRangeAnalysis).toEqual(
    projection.opponentRangeAnalysis,
  )
  const process = boundary.freezeProcess(
    analysis,
    decisionExplanation(input.decision.decisionId),
  )
  const hindsightContext = boundary.hindsightContext(process)
  const { review } = createCoachReviewContractValidator({
    boundary,
    coachReviewId: request.source.binding.runId,
    decisions: [
      {
        process,
        hindsightContext,
        hindsightOutput: {
          decisionId: input.decision.decisionId,
          hindsightExplanation: { text: '实际获得主池', factRefs: ['award'] },
        },
      },
    ],
    projectTeaching: () => ({
      overview: '合成测试：范围条件与来源',
      decisionPrioritySummary: {
        severityCounts: { low: 0, medium: 0, high: 0, unavailable: 1 },
        conditionalConclusionCounts: {
          favorableAcrossModeledRanges: 0,
          unfavorableAcrossModeledRanges: 0,
          rangeSensitive: 0,
          insufficientEvidence: 1,
        },
        assessmentCountsByStreet: (
          ['preflop', 'flop', 'turn', 'river'] as const
        ).map((street) => ({
          street,
          sound: 0,
          questionable: 0,
          likelyMistake: 0,
          unrated: street === 'river' ? 1 : 0,
        })),
      },
      teachingProjection: {
        coreDecisionId: null,
        secondaryDecisionIds: [],
        compactDecisionIds: [input.decision.decisionId],
        primaryLesson: null,
        primaryPracticeSuggestion: null,
        projectionPolicyVersion: 1,
      },
      keyLessons: [],
      practiceSuggestions: [],
    }),
  })
  expect(review.decisionReviews[0]!.rangeLayer.opponentRangeAnalysis).toEqual(
    projection.opponentRangeAnalysis,
  )
})

test('future responder permits conditional showdown equity but not action EV', async () => {
  const request = scenario(true)
  const projection = await analyzeCoachOpponentRanges(request)
  expect(projection.opponentRangeAnalysis.status).toBe('available')
  expect(projection.jointEquityAnalysis.status).toBe('available')
  expect(projection.conditionalCallEv).toMatchObject({
    status: 'unavailable',
    reasonCode: 'futureActionsUnmodeled',
  })
})

test('pinned data identity and synchronous uncovered certification cannot sign invented results', async () => {
  const request = scenario()
  await expect(
    analyzeCoachOpponentRanges({
      ...request,
      dataDependencies: [
        { id: `opponent-range-pack/${request.pack.datasetId}`, version: 2 },
      ],
    }),
  ).rejects.toThrow('coach_range_pack_binding')
  expect(() => analyzeUncoveredCoachRanges(request)).toThrow(
    'coach_requires_runtime_computation',
  )
  const empty = createStaticOpponentRangeRepository([
    makeOpponentRangePack(),
  ]).read({
    reference: { datasetId: 'test-opponent-ranges', datasetVersion: 1 },
    usage: 'pinnedRun',
  })
  const uncovered = analyzeUncoveredCoachRanges({ ...request, pack: empty })
  expect(uncovered.opponentRangeAnalysis).toMatchObject({
    status: 'unavailable',
    reasonCode: 'uncoveredScenario',
  })
  expect(uncovered.rangeCharts).toEqual([])
  expect(() =>
    assertCertifiedCoachRangeAnalysis(
      uncovered,
      request.input,
      request.metrics,
      request.actionOutcomes,
    ),
  ).not.toThrow()
})

test('reference-only opponent does not relabel a matched opponent chart', async () => {
  const request = scenario()
  const raw = structuredClone(request.pack)
  raw.initialRanges[0]!.matchStatus = 'referenceOnly'
  raw.initialRanges[0]!.differences = ['curatedReferenceOnly']
  raw.coverageManifest[0]!.status = 'referenceOnly'
  const pack = createStaticOpponentRangeRepository([raw]).read({
    reference: { datasetId: raw.datasetId, datasetVersion: raw.datasetVersion },
    usage: 'pinnedRun',
  })
  const result = await analyzeCoachOpponentRanges({ ...request, pack })
  expect(result.opponentRangeAnalysis).toMatchObject({
    status: 'available',
    matchStatus: 'referenceOnly',
  })
  expect(result.rangeCharts.map((chart) => chart.matchStatus)).toEqual([
    'referenceOnly',
    'matched',
  ])
})

test('certified multiway calling all-in forces runout and carries Monte Carlo error metadata', async () => {
  const request = scenario(false, true)
  const call = request.actionOutcomes.outcomes.find((outcome) =>
    outcome.references.some((reference) => reference.kind === 'callComparison'),
  )!
  expect(call.action.type).toBe('allIn')
  expect(call.result).toMatchObject({
    showdownForced: true,
    furtherBettingPossible: false,
    responders: [],
    canRaiseSeats: [],
    amountActuallyAtRisk: 100,
  })
  const projection = await analyzeCoachOpponentRanges(request)
  expect(projection.jointEquityAnalysis.status).toBe('available')
  expect(projection.conditionalCallEv.status).toBe('available')
  if (
    projection.jointEquityAnalysis.status !== 'available' ||
    projection.conditionalCallEv.status !== 'available'
  )
    throw new Error('expected terminal runout result')
  const equity = projection.jointEquityAnalysis.scenarios[0]!
  expect(equity.method).toBe('monteCarlo')
  expect(equity.seed).toBeTruthy()
  expect(equity.acceptedSamples).toBeGreaterThanOrEqual(5000)
  expect(equity.totalStandardError).toBe(0)
  expect(equity.totalConfidenceInterval).toEqual({ lower: 370, upper: 370 })
  expect(projection.conditionalCallEv.callAction.type).toBe('allIn')
  expect(projection.conditionalCallEv.scenarios[0]).toMatchObject({
    callEvVersusFold: 270,
    confidenceInterval: { lower: 270, upper: 270 },
  })
})
