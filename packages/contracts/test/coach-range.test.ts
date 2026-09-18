import { describe, it, expect } from 'vitest'
import {
  CoachRangeAnalysisSchema,
  OpponentRangeChartSpecSchema,
} from '../src/coach-range.js'
const common = {
  decisionId: '00000000-0000-4000-8000-000000000001:river:12',
  rangePackRef: { datasetId: 'fixture', datasetVersion: 1 },
  provenance: {
    rangeProjectionVersion: 1,
    equityComputationPolicyVersion: 1,
    settlementProjectionVersion: 1,
  },
}
const unavailable = {
  ...common,
  status: 'unavailable' as const,
  reasonCode: 'scenarioNotCovered',
}
const source = {
  sourceId: 'fixture',
  kind: 'projectCurated',
  publisher: 'fixture',
  title: 'fixture',
  version: '1',
  authorizationRef: 'test-only',
  reviewedAt: '2026-09-18T00:00:00Z',
  methodology: 'test-only',
}
const applicability = {
  tableSize: 6,
  opponentLogicalPosition: 'BB',
  effectiveStackIntervalBb: { min: 0, max: 100 },
  preflopEntryMode: 'call',
  normalizedPreflopLine: [],
  participantTopology: { remainingSeatCount: 2, hasSidePot: false },
  potType: 'limped',
  street: 'river',
}
function chart(scenarioId: string, seatNumber = 0) {
  const ranks = 'AKQJT98765432'.split('')
  return {
    ...common,
    schemaVersion: 1,
    chartId: `chart:${scenarioId}:${seatNumber}`,
    scenarioId,
    seatNumber,
    logicalPosition: 'BB',
    matchStatus: 'matched',
    rankOrder: ranks,
    cells: ranks.flatMap((a, i) =>
      ranks.map((b, j) => ({
        handClass: i === j ? a + b : i < j ? a + b + 's' : b + a + 'o',
        relativeComboWeightBasisPoints: 10000,
        availableComboCount: i === j ? 6 : i < j ? 4 : 12,
        normalizedMass: (i === j ? 6 : i < j ? 4 : 12) / 1326,
      })),
    ),
  }
}
function analysis() {
  const scenarios = ['base', 'wide']
  return {
    opponentRangeAnalysis: {
      ...common,
      status: 'available',
      matchStatus: 'matched',
      sources: [source],
      limitations: [],
      scenarios: scenarios.map((scenarioId) => ({
        scenarioId,
        name: scenarioId,
        sourceRefs: ['fixture'],
        opponents: [
          {
            seatNumber: 0,
            logicalPosition: 'BB',
            initialRangeId: 'range',
            matchStatus: 'matched',
            applicability,
            appliedRuleIds: [],
            sourceRefs: ['fixture'],
            limitations: [],
            differenceCodes: [],
            availableComboCount: 1326,
            updateTrace: [],
          },
        ],
      })),
    },
    jointEquityAnalysis: {
      ...common,
      status: 'available',
      evaluationContext: 'afterCall',
      assumptions: [],
      scenarios: scenarios.map((scenarioId) => ({
        scenarioId,
        method: 'exactEnumeration',
        seed: null,
        exactStates: 6,
        proposedSamples: null,
        acceptedSamples: null,
        pots: [
          {
            potIndex: 0,
            amount: 100,
            eligibleSeatNumbers: [0, 1],
            winProbability: 0.6,
            tieProbability: 0,
            lossProbability: 0.4,
            expectedAllocationShare: 0.6,
            expectedReturn: 60,
            standardError: null,
            confidenceInterval: null,
          },
        ],
        expectedHeroReturn: 60,
        totalStandardError: null,
        totalConfidenceInterval: null,
      })),
    },
    conditionalCallEv: {
      ...common,
      status: 'available',
      callAction: { type: 'call' },
      scenarios: scenarios.map((scenarioId) => ({
        scenarioId,
        expectedHeroReturn: 60,
        amountActuallyAtRisk: 20,
        callEvVersusFold: 40,
        confidenceInterval: null,
      })),
    },
    rangeSensitivity: {
      ...common,
      status: 'available',
      scenarioIds: scenarios,
      equityMin: 0.6,
      equityMax: 0.6,
      callEvMin: 40,
      callEvMax: 40,
      signStable: true,
    },
    rangeCharts: scenarios.map((id) => chart(id)),
  }
}
describe('range contracts', () => {
  it('preserves unavailable without invented numeric values or extra fields', () => {
    const v = {
      opponentRangeAnalysis: unavailable,
      jointEquityAnalysis: unavailable,
      conditionalCallEv: unavailable,
      rangeSensitivity: unavailable,
      rangeCharts: [],
    }
    expect(CoachRangeAnalysisSchema.safeParse(v).success).toBe(true)
    expect(
      CoachRangeAnalysisSchema.safeParse({
        ...v,
        conditionalCallEv: { ...unavailable, callEvVersusFold: 0 },
      }).success,
    ).toBe(false)
  })
  it('binds exact multi-scenario pot values, EV, uncertainty and provenance', () => {
    expect(CoachRangeAnalysisSchema.safeParse(analysis()).success).toBe(true)
    for (const change of [
      'identity',
      'ev',
      'sensitivity',
      'sample',
      'finite',
    ] as const) {
      const v = analysis()
      if (change === 'identity')
        v.jointEquityAnalysis.provenance = {
          ...v.jointEquityAnalysis.provenance,
          rangeProjectionVersion: 2,
        }
      if (change === 'ev')
        v.conditionalCallEv.scenarios[0]!.callEvVersusFold = 45
      if (change === 'sensitivity') v.rangeSensitivity.signStable = false
      if (change === 'sample')
        v.jointEquityAnalysis.scenarios[0]!.exactStates = 0
      if (change === 'finite')
        v.jointEquityAnalysis.scenarios[0]!.pots[0]!.expectedReturn = Infinity
      expect(CoachRangeAnalysisSchema.safeParse(v).success, change).toBe(false)
    }
  })
  it('requires a resolvable source binding for each joint scenario', () => {
    const v = analysis()
    v.opponentRangeAnalysis.sources.push({ ...source, sourceId: 'wide-source' })
    v.opponentRangeAnalysis.scenarios[1]!.sourceRefs = ['wide-source']
    expect(CoachRangeAnalysisSchema.safeParse(v).success).toBe(true)
    for (const refs of [undefined, [], ['missing']]) {
      const invalid = structuredClone(v)
      Object.assign(invalid.opponentRangeAnalysis.scenarios[1]!, {
        sourceRefs: refs,
      })
      expect(CoachRangeAnalysisSchema.safeParse(invalid).success).toBe(false)
    }
  })
  it('requires exactly one chart for every scenario and opponent pair', () => {
    const v = analysis()
    for (const scenario of v.opponentRangeAnalysis.scenarios) {
      scenario.opponents.push({ ...scenario.opponents[0]!, seatNumber: 2 })
      v.rangeCharts.push(chart(scenario.scenarioId, 2))
    }
    expect(CoachRangeAnalysisSchema.safeParse(v).success).toBe(true)
    for (const charts of [
      [],
      v.rangeCharts.slice(1),
      v.rangeCharts.filter((c) => c.scenarioId !== 'wide'),
      v.rangeCharts.filter((c) => c.seatNumber !== 2),
      [...v.rangeCharts, { ...v.rangeCharts[0]!, chartId: 'another-id' }],
      [
        { ...v.rangeCharts[0]!, chartId: 'another-id' },
        ...v.rangeCharts.slice(0, -1),
      ],
    ]) {
      expect(
        CoachRangeAnalysisSchema.safeParse({ ...v, rangeCharts: charts })
          .success,
      ).toBe(false)
    }
  })
  it('requires canonical complete chart data and rejects action frequencies', () => {
    const fullChart = chart('base')
    expect(OpponentRangeChartSpecSchema.safeParse(fullChart).success).toBe(true)
    expect(
      OpponentRangeChartSpecSchema.safeParse({
        ...fullChart,
        cells: fullChart.cells.slice(1),
      }).success,
    ).toBe(false)
    expect(
      OpponentRangeChartSpecSchema.safeParse({
        ...fullChart,
        cells: fullChart.cells.map((c) => ({ ...c, actionFrequency: 1 })),
      }).success,
    ).toBe(false)
    const v = analysis()
    expect(
      CoachRangeAnalysisSchema.safeParse({
        ...v,
        rangeCharts: [fullChart, chart('wide')],
      }).success,
    ).toBe(true)
    expect(
      CoachRangeAnalysisSchema.safeParse({
        ...v,
        rangeCharts: [
          {
            ...fullChart,
            cells: fullChart.cells.map(() => fullChart.cells[0]),
          },
        ],
      }).success,
    ).toBe(false)
  })
})
