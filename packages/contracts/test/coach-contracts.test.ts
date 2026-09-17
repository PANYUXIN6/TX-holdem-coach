import { describe, expect, it } from 'vitest'
import {
  CoachStrategyActionSchema,
  CoachReviewSchema,
  CoachRangeChartSpecSchema,
  CoachDecisionIdSchema,
  CreateCoachReviewRequestSchema,
} from '../src/index.js'

const handId = '00000000-0000-4000-8000-000000000001'
export const emptyCoachReview = () => ({
  schemaVersion: 1,
  coachReviewId: '00000000-0000-4000-8000-000000000002',
  handId,
  overview: '本手没有可评价的用户决策',
  decisionPrioritySummary: {
    assessmentCountsByStreet: ['preflop', 'flop', 'turn', 'river'].map(
      (street) => ({
        street,
        sound: 0,
        questionable: 0,
        likelyMistake: 0,
        unrated: 0,
      }),
    ),
    largestEvLossDecision: {
      status: 'unavailable',
      reasonCode: 'noComparableEv',
    },
    highSeverityUnknownEvDecisionIds: [],
  },
  teachingProjection: {
    coreDecisionId: null,
    secondaryDecisionIds: [],
    compactDecisionIds: [],
    primaryLesson: null,
    primaryPracticeSuggestion: null,
    projectionPolicyVersion: 1,
  },
  decisionReviews: [],
  keyLessons: [],
  practiceSuggestions: [],
  rangeCharts: [],
})

describe('Coach public boundaries', () => {
  it('accepts an empty completed review and rejects extra nested fields', () => {
    expect(CoachReviewSchema.safeParse(emptyCoachReview()).success).toBe(true)
    const value = emptyCoachReview()
    expect(
      CoachReviewSchema.safeParse({
        ...value,
        teachingProjection: {
          ...value.teachingProjection,
          candidateId: 'private',
        },
      }).success,
    ).toBe(false)
    expect(
      CreateCoachReviewRequestSchema.safeParse({
        requestId: value.coachReviewId,
        auditTruth: {},
      }).success,
    ).toBe(false)
  })
  it('uses committed event identity without leading zeros or unsafe sequences', () => {
    expect(CoachDecisionIdSchema.safeParse(`${handId}:flop:12`).success).toBe(
      true,
    )
    for (const suffix of ['flop:012', 'showdown:12', 'flop:9007199254740992'])
      expect(
        CoachDecisionIdSchema.safeParse(`${handId}:${suffix}`).success,
      ).toBe(false)
  })
  it('separates action frequency from over-pot target commitment', () => {
    const action = {
      actionId: 'bet150',
      action: 'bet',
      actionFrequency: 1,
      betSize: {
        kind: 'potFraction',
        value: 1.5,
        ratioKind: 'targetStreetCommitmentToPotBefore',
      },
    }
    expect(CoachStrategyActionSchema.safeParse(action).success).toBe(true)
    for (const bad of [
      { ...action, actionFrequency: 1.5 },
      { ...action, action: 'fold' },
      { ...action, betSize: { ...action.betSize, value: 0 } },
    ])
      expect(CoachStrategyActionSchema.safeParse(bad).success).toBe(false)
  })
  it('requires a complete canonical 169-class chart and closed frequencies', () => {
    const ranks = [
      'A',
      'K',
      'Q',
      'J',
      'T',
      '9',
      '8',
      '7',
      '6',
      '5',
      '4',
      '3',
      '2',
    ]
    const chart = {
      schemaVersion: 1,
      chartId: 'chart',
      decisionId: `${handId}:preflop:12`,
      datasetId: 'fixture',
      datasetVersion: '1',
      recordId: 'node',
      tableSize: 6,
      logicalPosition: 'BTN',
      actionNode: 'open',
      matchStatus: 'exact',
      rankOrder: ranks,
      highlightedHandClass: 'AKs',
      actions: [{ actionId: 'fold', action: 'fold', betSize: null }],
      cells: ranks.flatMap((a, i) =>
        ranks.map((b, j) => ({
          handClass: i === j ? a + b : i < j ? a + b + 's' : b + a + 'o',
          actionFrequencies: [{ actionId: 'fold', actionFrequency: 1 }],
        })),
      ),
    }
    expect(CoachRangeChartSpecSchema.safeParse(chart).success).toBe(true)
    expect(
      CoachRangeChartSpecSchema.safeParse({
        ...chart,
        cells: chart.cells.slice(1),
      }).success,
    ).toBe(false)
    expect(
      CoachRangeChartSpecSchema.safeParse({
        ...chart,
        cells: chart.cells.map((c, i) => (i ? c : chart.cells[1])),
      }).success,
    ).toBe(false)
    expect(
      CoachRangeChartSpecSchema.safeParse({
        ...chart,
        cells: chart.cells.map((c) => ({
          ...c,
          actionFrequencies: [{ actionId: 'unknown', actionFrequency: 1 }],
        })),
      }).success,
    ).toBe(false)
  })
})

// A teaching fixture expresses contracts only; it is not installed strategy coverage.
import {
  CoachStrategyBaselineSchema,
  CoachReviewRequestStateSchema,
  CoachOpponentEvidenceSchema,
  COACH_ACTION_FREQUENCY_TOLERANCE,
} from '../src/index.js'
const baseline = () => ({
  matchStatus: 'exact',
  datasetId: 'fixture',
  datasetVersion: '1',
  recordId: 'open',
  source: {
    kind: 'teachingReference',
    name: '测试教学模板',
    version: '1',
    authorizationRef: 'fixture-only',
  },
  scenarioAssumptions: {
    pokerRuleSetVersion: 'nlhe-cash-6to9-10-20-v1',
    tableSize: 9,
    logicalPosition: 'BTN',
    effectiveStackBb: 100,
    street: 'preflop',
    actionNode: 'open',
    potType: 'multiway',
  },
  abstraction: { profileId: 'fixture', profileVersion: 1, lossCodes: [] },
  differenceCodes: [],
  actions: [
    { actionId: 'fold', action: 'fold', actionFrequency: 0, betSize: null },
    {
      actionId: 'raise',
      action: 'raise',
      actionFrequency: 1,
      betSize: {
        kind: 'potFraction',
        value: 2,
        ratioKind: 'targetStreetCommitmentToPotBefore',
      },
    },
  ],
})
describe('Coach baseline, evidence and lifecycle invariants', () => {
  it('keeps exact/reference/unsupported branches separate with finite closed frequencies', () => {
    const b = baseline()
    expect(CoachStrategyBaselineSchema.safeParse(b).success).toBe(true)
    expect(
      CoachStrategyBaselineSchema.safeParse({
        ...b,
        matchStatus: 'referenceOnly',
        differenceCodes: ['stackDepth'],
      }).success,
    ).toBe(true)
    expect(
      CoachStrategyBaselineSchema.safeParse({
        ...b,
        matchStatus: 'referenceOnly',
      }).success,
    ).toBe(false)
    expect(
      CoachStrategyBaselineSchema.safeParse({
        ...b,
        differenceCodes: ['stackDepth'],
      }).success,
    ).toBe(false)
    for (const frequency of [-1, 1.1, NaN, Infinity, '1'])
      expect(
        CoachStrategyBaselineSchema.safeParse({
          ...b,
          actions: [{ ...b.actions[1], actionFrequency: frequency }],
        }).success,
      ).toBe(false)
    expect(
      CoachStrategyBaselineSchema.safeParse({
        ...b,
        actions: [
          {
            ...b.actions[1],
            actionFrequency: 1 - COACH_ACTION_FREQUENCY_TOLERANCE / 2,
          },
        ],
      }).success,
    ).toBe(true)
    expect(
      CoachStrategyBaselineSchema.safeParse({
        ...b,
        actions: [
          {
            ...b.actions[1],
            actionFrequency: 1 - 2 * COACH_ACTION_FREQUENCY_TOLERANCE,
          },
        ],
      }).success,
    ).toBe(false)
    expect(
      CoachStrategyBaselineSchema.safeParse({
        matchStatus: 'unsupported',
        reasonCode: 'noDataset',
        datasetReference: null,
        actions: [],
      }).success,
    ).toBe(true)
    expect(
      CoachStrategyBaselineSchema.safeParse({
        matchStatus: 'unsupported',
        reasonCode: 'noDataset',
        datasetReference: null,
        actions: b.actions,
      }).success,
    ).toBe(false)
  })
  it('represents insufficient samples without inventing a numeric rate or exploit', () => {
    const evidence = {
      evidenceId: 'vpip',
      metric: 'vpip',
      numerator: 0,
      denominator: 0,
      value: null,
      filters: {
        tableSize: 6,
        logicalPosition: 'BTN',
        opportunityType: 'vpip',
        potType: 'headsUp',
        personaSnapshotId: 'snapshot',
      },
      confidence: 'insufficient',
      usableForExploit: false,
      policyVersion: 1,
      asOfEventSeq: 10,
    }
    expect(CoachOpponentEvidenceSchema.safeParse(evidence).success).toBe(true)
    for (const bad of [
      { ...evidence, value: 0 },
      { ...evidence, filters: { ...evidence.filters, opportunityType: 'pfr' } },
      { ...evidence, usableForExploit: true },
      { ...evidence, numerator: 1, denominator: 2, value: 0.8 },
    ])
      expect(CoachOpponentEvidenceSchema.safeParse(bad).success).toBe(false)
  })
  it('checks report identity, terminal fields and UTC time ordering', () => {
    const review = emptyCoachReview(),
      base = {
        coachReviewId: review.coachReviewId,
        handId,
        requestId: review.coachReviewId,
        createdAt: '2026-09-15T00:00:00Z',
      }
    expect(
      CoachReviewRequestStateSchema.safeParse({ ...base, status: 'pending' })
        .success,
    ).toBe(true)
    expect(
      CoachReviewRequestStateSchema.safeParse({
        ...base,
        status: 'failed',
        startedAt: null,
        failedAt: base.createdAt,
        failureCode: 'invalidOutput',
      }).success,
    ).toBe(true)
    const completed = {
      ...base,
      status: 'completed',
      startedAt: base.createdAt,
      completedAt: '2026-09-15T00:01:00Z',
      review,
    }
    expect(CoachReviewRequestStateSchema.safeParse(completed).success).toBe(
      true,
    )
    for (const bad of [
      { ...completed, completedAt: '2026-09-14T23:59:59Z' },
      { ...completed, handId: '00000000-0000-4000-8000-000000000099' },
      { ...base, status: 'running', startedAt: base.createdAt, review },
    ])
      expect(CoachReviewRequestStateSchema.safeParse(bad).success).toBe(false)
  })
})
