import { syncFixtureAnalysis } from '../fixtures/coach/boundaries.js'
import { describe, it, expect } from 'vitest'
import { CoachReviewSchema, type CoachReview } from '@tx-holdem-coach/contracts'
import { createCoachReviewContractValidator } from '../../src/agents/coach/review-contract-validator.js'
import {
  fixtureBoundary,
  reviewCase,
  decisionInput,
  decisionExplanation,
  runId,
} from '../fixtures/coach/boundaries.js'
import type { FrozenProcessAnalysis } from '../../src/agents/coach/frozen-analysis.js'

function teaching(processes: readonly FrozenProcessAnalysis[]) {
  return {
    overview: processes.length
      ? '证据不足，逐决策说明当前事实。'
      : '本手没有可评价的用户决策',
    decisionPrioritySummary: {
      severityCounts: {
        low: 0,
        medium: 0,
        high: 0,
        unavailable: processes.length,
      },
      conditionalConclusionCounts: {
        favorableAcrossModeledRanges: 0,
        unfavorableAcrossModeledRanges: 0,
        rangeSensitive: 0,
        insufficientEvidence: processes.length,
      },
      assessmentCountsByStreet: (
        ['preflop', 'flop', 'turn', 'river'] as const
      ).map((street) => ({
        street,
        sound: 0,
        questionable: 0,
        likelyMistake: 0,
        unrated: processes.filter(
          (p) => p.analysis.input.decision.street === street,
        ).length,
      })),
    },
    teachingProjection: {
      coreDecisionId: null,
      secondaryDecisionIds: [],
      compactDecisionIds: processes.map(
        (p) => p.analysis.input.decision.decisionId,
      ),
      primaryLesson: null,
      primaryPracticeSuggestion: null,
      projectionPolicyVersion: 1,
    },
    keyLessons: [],
    practiceSuggestions: [],
  }
}
function completeReview() {
  const source = reviewCase(),
    second = structuredClone(source.heroDecisions[0]!)
  second.eventSeq = 18
  second.decisionId = second.decisionId.replace(':12', ':18')
  syncFixtureAnalysis(second)
  second.opponentEvidenceCutoff.asOfEventSeq = 17
  source.heroDecisions.push(second)
  const boundary = fixtureBoundary(source)
  const processes = source.heroDecisions.map((d, i) =>
    boundary.freezeProcess(
      boundary.analyze(boundary.certifyDecision(decisionInput(source, i))),
      decisionExplanation(d.decisionId),
    ),
  )
  const decisions = processes.map((process) => {
    const hindsightContext = boundary.hindsightContext(process)
    return {
      process,
      hindsightContext,
      hindsightOutput: {
        decisionId: hindsightContext.decisionId,
        hindsightExplanation: { text: '实际获得主池', factRefs: ['award'] },
      },
    }
  })
  return {
    boundary,
    decisions,
    validator: createCoachReviewContractValidator({
      boundary,
      coachReviewId: runId,
      decisions,
      projectTeaching: teaching,
    }),
  }
}
describe('Coach complete frozen review contract', () => {
  it('composes two same-street decisions with public references and no private result structures', () => {
    const { validator } = completeReview()
    expect(validator.review.decisionReviews).toHaveLength(2)
    expect(
      validator.validate(JSON.parse(JSON.stringify(validator.review))),
    ).toEqual(validator.review)
    const forbidden = new Set([
      'candidateId',
      'comparisonTuple',
      'revealedHandRanks',
      'showdownComparisonsByPot',
      'auditTruth',
      'result',
    ])
    function inspect(v: unknown): void {
      if (v && typeof v === 'object')
        for (const [key, value] of Object.entries(v)) {
          expect(forbidden.has(key)).toBe(false)
          inspect(value)
        }
    }
    inspect(validator.review)
    expect(
      validator.review.decisionReviews[0]!.hindsightExplanation.factRefs,
    ).toEqual(['hindsight.0'])
  })
  it('rejects omitted, extra, duplicate, reordered and foreign-hand manifest inputs', () => {
    const { boundary, decisions } = completeReview()
    for (const bad of [
      decisions.slice(1),
      [...decisions, decisions[0]!],
      [decisions[0]!, decisions[0]!],
      [...decisions].reverse(),
    ])
      expect(() =>
        createCoachReviewContractValidator({
          boundary,
          coachReviewId: runId,
          decisions: bad,
          projectTeaching: teaching,
        }),
      ).toThrow()
    const foreign = reviewCase()
    foreign.binding.handId = '00000000-0000-4000-8000-000000000099'
    foreign.heroDecisions[0]!.decisionId =
      foreign.heroDecisions[0]!.decisionId.replace(
        reviewCase().binding.handId,
        foreign.binding.handId,
      )
    expect(() => boundary.certifyDecision(decisionInput(foreign))).toThrow()
  })
  it('rejects internally self-consistent but incomplete or changed reports against the frozen manifest', () => {
    const { validator } = completeReview(),
      report = structuredClone(validator.review)
    report.decisionReviews.pop()
    report.teachingProjection.compactDecisionIds.pop()
    report.decisionPrioritySummary.assessmentCountsByStreet[1]!.unrated = 1
    report.decisionPrioritySummary.severityCounts.unavailable = 1
    report.decisionPrioritySummary.conditionalConclusionCounts.insufficientEvidence = 1
    expect(CoachReviewSchema.safeParse(report).success).toBe(true)
    expect(() => validator.validate(report)).toThrow(
      'coach_frozen_report_mismatch',
    )
    const changed = structuredClone(validator.review)
    changed.decisionReviews[0]!.factManifest[0]!.assumptions = [
      '伪造的合法格式假设',
    ]
    expect(CoachReviewSchema.safeParse(changed).success).toBe(true)
    expect(() => validator.validate(changed)).toThrow(
      'coach_frozen_report_mismatch',
    )
  })
  it('rejects unknown fields at nested public teaching and numeric boundaries', () => {
    const { validator } = completeReview()
    const report = structuredClone(validator.review) as CoachReview
    const d = report.decisionReviews[0]!
    expect(
      CoachReviewSchema.safeParse({
        ...report,
        decisionReviews: [
          {
            ...d,
            alternatives: [
              { text: '说明', factRefs: ['board'], candidateId: 'hidden' },
            ],
          },
          report.decisionReviews[1],
        ],
      }).success,
    ).toBe(false)
    expect(
      CoachReviewSchema.safeParse({
        ...report,
        decisionReviews: [
          { ...d, decisionGrade: 'majorEvMistake' },
          report.decisionReviews[1],
        ],
      }).success,
    ).toBe(false)
  })
  it('accepts a real zero-decision manifest without model work', () => {
    const source = reviewCase()
    source.heroDecisions = []
    const boundary = fixtureBoundary(source)
    const compose = () =>
      createCoachReviewContractValidator({
        boundary,
        coachReviewId: runId,
        decisions: [],
        projectTeaching: teaching,
      })
    expect(compose).toThrow('coach_hindsight_not_ready')
    boundary.beginHindsight()
    const validator = compose()
    expect(validator.review.decisionReviews).toEqual([])
  })
})

import { createCoachReviewBoundary } from '../../src/agents/coach/frozen-analysis.js'
import { fixturePorts } from '../fixtures/coach/boundaries.js'

it.each(['opponent-rank-private', 'actualNet', 'actualContinuation'])(
  'preserves private fact %s when projecting a nine-seat rated review',
  (rankId) => {
    const source = reviewCase(),
      d = source.heroDecisions[0]!
    source.tableSize = 9
    d.legalActions.push({
      action: 'bet',
      minimumTarget: 20,
      maximumTarget: 1000,
    })
    for (const [index, logicalPosition] of (
      ['UTG+1', 'MP', 'LJ'] as const
    ).entries())
      d.visibleState.seats.push({
        seatNumber: index + 6,
        logicalPosition,
        stack: 1000,
        streetCommitment: 0,
        totalCommitment: 20,
        status: 'active',
      })
    syncFixtureAnalysis(d)
    source.auditTruth.actualHoleCards.push({
      seatNumber: 1,
      cards: [
        { rank: 'A', suit: 'hearts' },
        { rank: 'A', suit: 'diamonds' },
      ],
    })
    source.auditTruth.revealedHandRanks = [
      {
        factId: 'hero-rank-private',
        seatNumber: 0,
        holeCards: d.visibleState.heroHoleCards,
        category: 'highCard',
        comparisonTuple: [0, 14, 13, 12, 7, 2],
        asOfEventSeq: 30,
      },
      {
        factId: rankId,
        seatNumber: 1,
        holeCards: source.auditTruth.actualHoleCards[1]!.cards,
        category: 'onePair',
        comparisonTuple: [1, 14, 12, 7, 2],
        asOfEventSeq: 30,
      },
    ]
    source.auditTruth.potAwards[0]!.winnerSeats = [1]
    source.auditTruth.potAwards[0]!.awards = [{ seatNumber: 1, chips: 180 }]
    source.auditTruth.heroNetChips = -20
    source.auditTruth.actualContinuation = [
      { eventSeq: 20, street: 'flop', seatNumber: 2, action: { type: 'fold' } },
    ]
    source.auditTruth.showdownComparisonsByPot = [
      {
        factId: 'comparison-private',
        potId: 'main',
        eligibleSeats: [0, 1],
        winnerSeats: [1],
        handRankRefs: ['hero-rank-private', rankId],
      },
    ]
    const ports = fixturePorts(source)
    const b = createCoachReviewBoundary({
      ...ports,
      classify: (input, derived) => ({
        ...ports.classify(input, derived),
        assessment: 'sound',
        assessmentBasis: 'ruleInvariant',
        epistemicStatus: 'objective',
      }),
      projectHindsight: (source, input) => ({
        ...ports.projectHindsight(source, input),
        revealedHandRanks: source.auditTruth.revealedHandRanks,
        showdownComparisonsByPot: source.auditTruth.showdownComparisonsByPot,
      }),
    })
    const explanation = {
      ...decisionExplanation(),
      alternatives: [
        {
          explanation: '也可以选择下注',
          factRefs: ['board'],
        },
      ],
      keyLessons: ['关注当前信息'],
      practiceSuggestions: ['复习当前节点'],
    }
    const process = b.freezeProcess(
        b.analyze(b.certifyDecision(decisionInput(source))),
        explanation,
      ),
      hindsightContext = b.hindsightContext(process)
    const validator = createCoachReviewContractValidator({
      boundary: b,
      coachReviewId: runId,
      decisions: [
        {
          process,
          hindsightContext,
          hindsightOutput: {
            decisionId: d.decisionId,
            hindsightExplanation: {
              text: '对手一对赢得主池，过程评价保持不变',
              factRefs: [rankId, 'comparison-private'],
            },
          },
        },
      ],
      projectTeaching: (processes) => {
        const result = teaching(processes)
        return {
          ...result,
          decisionPrioritySummary: {
            ...result.decisionPrioritySummary,
            assessmentCountsByStreet:
              result.decisionPrioritySummary.assessmentCountsByStreet.map(
                (c) => ({
                  ...c,
                  sound: c.street === 'flop' ? 1 : 0,
                  unrated: 0,
                }),
              ),
          },
          teachingProjection: {
            ...result.teachingProjection,
            coreDecisionId: d.decisionId,
            compactDecisionIds: [],
            primaryLesson: '关注当前信息',
            primaryPracticeSuggestion: '复习当前节点',
          },
          keyLessons: ['关注当前信息'],
          practiceSuggestions: ['复习当前节点'],
        }
      },
    })
    expect(validator.review.decisionReviews[0]!.assessment).toBe('sound')
    expect(validator.review.decisionReviews[0]!.alternatives).toEqual([
      { text: '也可以选择下注', factRefs: ['board'] },
    ])
    const serialized = JSON.stringify(validator.review)
    for (const privateName of [
      'private-bet',
      'opponent-rank-private',
      'comparison-private',
      'comparisonTuple',
      'potAfter',
      'remainingStack',
      'candidateId',
    ])
      expect(serialized).not.toContain(privateName)
    expect(serialized).toContain('onePair')
    const review = validator.review.decisionReviews[0]!
    const referenced = review.factManifest.find(
      (fact) => fact.factId === review.hindsightExplanation.factRefs[0],
    )!
    expect(referenced.status === 'available' && referenced.value.kind).toBe(
      'handCategory',
    )
    const changed = structuredClone(validator.review)
    changed.decisionReviews[0]!.actualAction = { type: 'allIn' }
    expect(() => validator.validate(changed)).toThrow()
  },
)
