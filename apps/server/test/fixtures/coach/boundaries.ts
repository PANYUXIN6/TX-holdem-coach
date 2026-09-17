import { createCoachReviewBoundary } from '../../../src/agents/coach/frozen-analysis.js'
import {
  type CoachDecisionInput,
  type HandReviewCase,
} from '../../../src/agents/coach/review-case.js'
import { type CoachPublicFact } from '@tx-holdem-coach/contracts'
export const handId = '00000000-0000-4000-8000-000000000001'
export const sessionId = '00000000-0000-4000-8000-000000000002'
export const runId = '00000000-0000-4000-8000-000000000003'
export const reference = { id: 'fixture', version: 1 }
export function reviewCase(): HandReviewCase {
  const seats = (['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO'] as const).map(
    (logicalPosition, seatNumber) => ({
      seatNumber,
      logicalPosition,
      stack: 1000,
      streetCommitment: 0,
      totalCommitment: 20,
      status: 'active' as const,
    }),
  )
  return {
    reviewContextVersion: 1,
    binding: {
      ownerId: 'local-user',
      sessionId,
      handId,
      runId,
      pokerRuleSetVersion: 'nlhe-cash-6to9-10-20-v1',
      versions: {
        metrics: reference,
        strategy: reference,
        opponentEvidence: reference,
        classifier: reference,
        grade: reference,
        severity: reference,
        teaching: reference,
      },
    },
    tableSize: 6,
    completedEventSeq: 30,
    auditTruth: {
      actualHoleCards: [
        {
          seatNumber: 0,
          cards: [
            { rank: 'A', suit: 'spades' },
            { rank: 'K', suit: 'spades' },
          ],
        },
      ],
      actualBoard: [
        { rank: '2', suit: 'clubs' },
        { rank: '7', suit: 'hearts' },
        { rank: 'Q', suit: 'diamonds' },
      ],
      revealedHandRanks: [],
      runoutTransitions: [],
      actualContinuation: [],
      potAwards: [
        {
          factId: 'award',
          potId: 'main',
          eligibleSeats: [0, 1],
          winnerSeats: [0],
          awards: [{ seatNumber: 0, chips: 120 }],
        },
      ],
      uncalledReturns: [],
      heroNetChips: 100,
      showdownComparisonsByPot: [],
    },
    heroDecisions: [
      {
        decisionId: `${handId}:flop:12`,
        eventSeq: 12,
        stateVersion: 10,
        street: 'flop',
        logicalPosition: 'BTN',
        visibleState: {
          heroSeat: 0,
          heroHoleCards: [
            { rank: 'A', suit: 'spades' },
            { rank: 'K', suit: 'spades' },
          ],
          board: [
            { rank: '2', suit: 'clubs' },
            { rank: '7', suit: 'hearts' },
            { rank: 'Q', suit: 'diamonds' },
          ],
          seats,
          buttonSeat: 0,
          smallBlindSeat: 1,
          bigBlindSeat: 2,
          nominalSmallBlind: 10,
          nominalBigBlind: 20,
          actualSmallBlind: 10,
          actualBigBlind: 20,
          publicActions: [],
        },
        legalActions: [
          { action: 'check', minimumTarget: null, maximumTarget: null },
        ],
        actualAction: { type: 'check' },
        stacksAndContributions: seats,
        opponentEvidenceSubjects: [],
        opponentEvidenceCutoff: { sessionId, asOfEventSeq: 11 },
      },
    ],
  }
}
export function decisionInput(c = reviewCase(), index = 0): CoachDecisionInput {
  return {
    reviewContextVersion: 1,
    binding: c.binding,
    tableSize: c.tableSize,
    decision: c.heroDecisions[index]!,
  }
}
export function boardFact(input: CoachDecisionInput): CoachPublicFact {
  return {
    factId: 'board',
    scope: 'decision',
    status: 'available',
    epistemicKind: 'ruleFact',
    sourceRefs: [{ kind: 'event', sessionId, handId, eventSeq: 11 }],
    schemaVersion: 1,
    algorithmVersion: null,
    dataVersion: null,
    asOfEventSeq: 11,
    assumptions: [],
    value: {
      kind: 'cards',
      metric: 'board',
      cards: input.decision.visibleState.board,
    },
  }
}
export const assessment = () => ({
  assessment: 'unrated' as const,
  assessmentBasis: 'insufficientEvidence' as const,
  epistemicStatus: 'unrated' as const,
  decisionGrade: 'unrated' as const,
  decisionGradePolicyVersion: 1,
  primaryDeviationCode: null,
  observedDeviationTags: [],
  mistakeTaxonomyVersion: 1 as const,
  teachingHypotheses: [],
  severity: 'unavailable' as const,
  severityBasis: 'unavailable' as const,
  severityPolicyVersion: 1,
  baselineComparison: {
    matchStatus: 'unsupported' as const,
    actionSupported: null,
    sizeSupported: null,
    actualActionFrequency: null,
  },
  evLoss: {
    status: 'unavailable' as const,
    valueBb: null,
    method: null,
    sourceVersion: null,
    reasonCode: 'evUnavailable' as const,
  },
  evidenceRefs: ['board'],
})
export const decisionExplanation = (decisionId = `${handId}:flop:12`) => ({
  decisionId,
  baselineExplanation: { text: '策略证据不足', factRefs: ['board'] },
  situationExplanation: { text: '只分析当前公共牌', factRefs: ['board'] },
  exploitExplanation: { text: '对手样本不足', factRefs: ['board'] },
  alternatives: [],
  keyLessons: [],
  practiceSuggestions: [],
})

export function fixturePorts(
  c = reviewCase(),
): Parameters<typeof createCoachReviewBoundary>[0] {
  return {
    source: {
      reviewContextVersion: c.reviewContextVersion,
      binding: c.binding,
      tableSize: c.tableSize,
      completedEventSeq: c.completedEventSeq,
      heroDecisions: c.heroDecisions,
    },
    readHindsightSource: () => c,
    derive: (input) => ({
      versions: input.binding.versions,
      asOfEventSeq: input.decision.opponentEvidenceCutoff.asOfEventSeq,
      facts: [boardFact(input)],
      baseline: {
        matchStatus: 'unsupported',
        reasonCode: 'noDataset',
        actions: [],
        datasetReference: null,
      },
      opponentEvidence: [],
      candidates: [],
      rangeChart: null,
    }),
    classify: () => assessment(),
    projectHindsight: (source) => ({
      revealedHandRanks: [],
      runoutTransitions: source.auditTruth.runoutTransitions,
      actualContinuation: source.auditTruth.actualContinuation,
      potAwards: source.auditTruth.potAwards,
      uncalledReturns: source.auditTruth.uncalledReturns,
      heroNetChips: source.auditTruth.heroNetChips,
      showdownComparisonsByPot: [],
    }),
  }
}

export function fixtureBoundary(c = reviewCase()) {
  return createCoachReviewBoundary(fixturePorts(c))
}
