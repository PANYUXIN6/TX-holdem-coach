import { makeOpponentRangePack } from '../opponent-range-pack.js'
import { createStaticOpponentRangeRepository } from '../../../src/poker-range/opponent-range-repository.js'
import { analyzeUncoveredCoachRanges } from '../../../src/agents/coach/range-analysis.js'
import { assignLogicalPositions } from '../../../src/poker/positioning.js'
import {
  computeCoachDecisionMetrics,
  COACH_METRICS_VERSION,
} from '../../../src/agents/coach/decision-metrics.js'
import { computeCoachActionOutcomes } from '../../../src/agents/coach/action-outcomes.js'
import { getProjectedLegalActions } from '../../../src/poker/betting-projection.js'
import {
  toBettingProjectionState,
  type DecisionAnalysisInput,
} from '../../../src/poker/decision-analysis-input.js'
import { projectCoachLegalActions } from '../../../src/agents/coach/analysis-input.js'
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
  const analysisInput: DecisionAnalysisInput = {
    pokerRuleSetVersion: 'nlhe-cash-6to9-10-20-v1',
    buttonSeatNumber: 0,
    participantSeatNumbers: [0, 1, 2, 3, 4, 5],
    heroSeatNumber: 0,
    street: 'flop',
    positions: seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      position: seat.logicalPosition,
    })),
    startingStacks: seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      stack: 1020,
    })),
    smallBlindSeatNumber: 1,
    bigBlindSeatNumber: 2,
    heroHoleCards: [
      { rank: 'A', suit: 'spades' },
      { rank: 'K', suit: 'spades' },
    ],
    board: [
      { rank: '2', suit: 'clubs' },
      { rank: '7', suit: 'hearts' },
      { rank: 'Q', suit: 'diamonds' },
    ],
    pot: 120,
    seats: seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      stack: seat.stack,
      status: seat.status,
      streetContribution: 0,
      totalContribution: 20,
    })),
    bettingRound: {
      currentBet: 0,
      minimumFullRaiseIncrement: 20,
      seatStates: seats.map((seat) => ({
        seatNumber: seat.seatNumber,
        betLevelAfterLastAction: null,
      })),
    },
    legalActions: [],
    publicActions: [],
  }
  const safeInput = {
    ...analysisInput,
    legalActions: getProjectedLegalActions(
      toBettingProjectionState(analysisInput),
    ),
  }
  return {
    reviewContextVersion: 1,
    binding: {
      ownerId: 'local-user',
      sessionId,
      handId,
      runId,
      pokerRuleSetVersion: 'nlhe-cash-6to9-10-20-v1',
      versions: {
        metrics: COACH_METRICS_VERSION,
        rangeModel: { id: 'coach.review.range-model', version: 1 },
        equityComputation: {
          id: 'coach.review.equity-computation',
          version: 1,
        },
        settlement: { id: 'coach.review.settlement-projection', version: 1 },
        opponentEvidence: reference,
        classifier: reference,
        conclusion: {
          id: 'coach.review.conditional-conclusion-policy',
          version: 1,
        },
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
        analysisInput: structuredClone(
          safeInput,
        ) as HandReviewCase['heroDecisions'][number]['analysisInput'],
        streetStartState: {
          status: 'available',
          street: 'flop',
          eventSeq: 10,
          pot: 120,
          seats: safeInput.seats.map((seat) => ({ ...seat })),
        },
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
        legalActions: projectCoachLegalActions(safeInput),
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
  conditionalConclusion: 'insufficientEvidence' as const,
  conditionalConclusionPolicyVersion: 1,
  primaryDeviationCode: null,
  observedDeviationTags: [],
  mistakeTaxonomyVersion: 1 as const,
  teachingHypotheses: [],
  severity: 'unavailable' as const,
  severityBasis: 'unavailable' as const,
  severityPolicyVersion: 1,
  evidenceRefs: ['board'],
})
export const decisionExplanation = (decisionId = `${handId}:flop:12`) => ({
  decisionId,
  rangeExplanation: { text: '策略证据不足', factRefs: ['board'] },
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
    derive: (input) => {
      const metrics = computeCoachDecisionMetrics(input)
      const actionOutcomes = computeCoachActionOutcomes(input)
      return {
        metrics,
        actionOutcomes,
        rangeAnalysis: analyzeUncoveredCoachRanges({
          input,
          metrics,
          actionOutcomes,
          pack: createStaticOpponentRangeRepository([
            makeOpponentRangePack(),
          ]).read({
            reference: { datasetId: 'test-opponent-ranges', datasetVersion: 1 },
            usage: 'pinnedRun',
          }),
          dataDependencies: [
            { id: 'opponent-range-pack/test-opponent-ranges', version: 1 },
          ],
        }),
        versions: input.binding.versions,
        asOfEventSeq: input.decision.opponentEvidenceCutoff.asOfEventSeq,
        facts: [boardFact(input)],
        opponentEvidence: [],
      }
    },
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

/** Explicitly keep manually edited boundary fixtures consistent with the new private input. */
export function syncFixtureAnalysis(
  decision: HandReviewCase['heroDecisions'][number],
): void {
  const visible = decision.visibleState
  const input = decision.analysisInput
  input.heroHoleCards = structuredClone(visible.heroHoleCards)
  input.board = structuredClone(visible.board)
  input.street = decision.street
  input.seats = visible.seats.map((seat) => ({
    seatNumber: seat.seatNumber,
    status: seat.status,
    stack: seat.stack,
    streetContribution: seat.streetCommitment,
    totalContribution: seat.totalCommitment,
  }))
  input.participantSeatNumbers = input.seats.map((seat) => seat.seatNumber)
  input.positions = [
    ...assignLogicalPositions(
      input.buttonSeatNumber,
      input.participantSeatNumbers,
    ),
  ]
  for (const seat of visible.seats)
    seat.logicalPosition = input.positions.find(
      (position) => position.seatNumber === seat.seatNumber,
    )!.position
  input.startingStacks = visible.seats.map((seat) => ({
    seatNumber: seat.seatNumber,
    stack: seat.stack + seat.totalCommitment,
  }))
  input.pot = input.seats.reduce(
    (total, seat) => total + seat.totalContribution,
    0,
  )
  input.bettingRound.currentBet = Math.max(
    ...input.seats.map((seat) => seat.streetContribution),
  )
  input.bettingRound.seatStates = input.seats.map((seat) => ({
    seatNumber: seat.seatNumber,
    betLevelAfterLastAction: null,
  }))
  input.legalActions = getProjectedLegalActions(toBettingProjectionState(input))
  decision.legalActions = projectCoachLegalActions(input)
  decision.stacksAndContributions = visible.seats
  if (decision.streetStartState.status === 'available') {
    decision.streetStartState.seats = structuredClone(input.seats)
    decision.streetStartState.pot = input.pot
  }
  decision.opponentEvidenceCutoff.asOfEventSeq = decision.eventSeq - 1
}
