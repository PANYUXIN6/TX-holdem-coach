import { describe, expect, it } from 'vitest'
import {
  CoachReviewSchema,
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
    severityCounts: { low: 0, medium: 0, high: 0, unavailable: 0 },
    conditionalConclusionCounts: {
      favorableAcrossModeledRanges: 0,
      unfavorableAcrossModeledRanges: 0,
      rangeSensitive: 0,
      insufficientEvidence: 0,
    },
    assessmentCountsByStreet: ['preflop', 'flop', 'turn', 'river'].map(
      (street) => ({
        street,
        sound: 0,
        questionable: 0,
        likelyMistake: 0,
        unrated: 0,
      }),
    ),
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
})

import {
  CoachReviewRequestStateSchema,
  CoachOpponentEvidenceSchema,
} from '../src/index.js'
describe('Coach evidence and lifecycle invariants', () => {
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
