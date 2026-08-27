import { describe, expect, test } from 'vitest'
import { createLegalCandidates } from '../../src/poker/decision-candidates.js'
import {
  projectCandidateOutcomes,
  type LegalCandidateCatalogEntry,
} from '../../src/poker/candidate-outcomes.js'
import type { DecisionAnalysisInput } from '../../src/poker/decision-analysis-input.js'
import {
  createInitialBettingProjection,
  getProjectedLegalActions,
  type BettingProjectionState,
} from '../../src/poker/betting-projection.js'
import { POKER_RULE_SET_VERSION } from '../../src/poker/poker-rule-set.js'
import { assignLogicalPositions } from '../../src/poker/positioning.js'

const PARTICIPANTS = [0, 1, 2, 3, 4, 5] as const

function initialState(): BettingProjectionState {
  return createInitialBettingProjection({
    buttonSeatNumber: 0,
    participantSeatNumbers: PARTICIPANTS,
    smallBlindSeatNumber: 1,
    bigBlindSeatNumber: 2,
    startingStacks: PARTICIPANTS.map((seatNumber) => ({
      seatNumber,
      stack: 2_000,
    })),
  })
}

function analysisInput(state: BettingProjectionState): DecisionAnalysisInput {
  return {
    pokerRuleSetVersion: POKER_RULE_SET_VERSION,
    buttonSeatNumber: state.buttonSeatNumber,
    participantSeatNumbers: [...state.participantSeatNumbers],
    heroSeatNumber: state.currentActorSeatNumber,
    street: state.street,
    positions: assignLogicalPositions(
      state.buttonSeatNumber,
      state.participantSeatNumbers,
    ),
    startingStacks: state.seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      stack: seat.stack + seat.totalContribution,
    })),
    smallBlindSeatNumber: 1,
    bigBlindSeatNumber: 2,
    heroHoleCards: [
      { rank: 'A', suit: 'spades' },
      { rank: 'K', suit: 'spades' },
    ],
    board:
      state.street === 'preflop'
        ? []
        : [
            { rank: '2', suit: 'clubs' },
            { rank: '7', suit: 'diamonds' },
            { rank: 'J', suit: 'hearts' },
            ...(state.street === 'turn' || state.street === 'river'
              ? ([{ rank: 'Q', suit: 'clubs' }] as const)
              : []),
            ...(state.street === 'river'
              ? ([{ rank: '3', suit: 'spades' }] as const)
              : []),
          ],
    pot: state.pot,
    seats: state.seats.map((seat) => ({ ...seat })),
    bettingRound: {
      ...state.bettingRound,
      seatStates: state.bettingRound.seatStates.map((seat) => ({ ...seat })),
    },
    legalActions: getProjectedLegalActions(state),
    publicActions: [],
  }
}

function catalog(state: BettingProjectionState): LegalCandidateCatalogEntry[] {
  return structuredClone(
    createLegalCandidates(state),
  ) as unknown as LegalCandidateCatalogEntry[]
}

function shortOpponentRiverState(): BettingProjectionState {
  return {
    buttonSeatNumber: 0,
    participantSeatNumbers: [...PARTICIPANTS],
    street: 'river',
    currentActorSeatNumber: 3,
    pot: 600,
    seats: PARTICIPANTS.map((seatNumber) => ({
      seatNumber,
      status:
        seatNumber === 3 || seatNumber === 4
          ? ('active' as const)
          : ('folded' as const),
      stack: seatNumber === 3 ? 900 : seatNumber === 4 ? 50 : 900,
      streetContribution: 0,
      totalContribution: 100,
    })),
    bettingRound: {
      currentBet: 0,
      minimumFullRaiseIncrement: 20,
      seatStates: PARTICIPANTS.map((seatNumber) => ({
        seatNumber,
        betLevelAfterLastAction: null,
      })),
    },
  }
}

function forcedRunoutState(): BettingProjectionState {
  return {
    buttonSeatNumber: 0,
    participantSeatNumbers: [...PARTICIPANTS],
    street: 'preflop',
    currentActorSeatNumber: 3,
    pot: 100,
    seats: PARTICIPANTS.map((seatNumber) => ({
      seatNumber,
      status: seatNumber === 3 ? ('active' as const) : ('allIn' as const),
      stack: seatNumber === 3 ? 20 : 0,
      streetContribution: seatNumber === 3 ? 0 : 20,
      totalContribution: seatNumber === 3 ? 0 : 20,
    })),
    bettingRound: {
      currentBet: 20,
      minimumFullRaiseIncrement: 20,
      seatStates: PARTICIPANTS.map((seatNumber) => ({
        seatNumber,
        betLevelAfterLastAction: null,
      })),
    },
  }
}

describe('projectCandidateOutcomes', () => {
  test('accepts a JSON catalog but projects only fresh signed candidates', () => {
    const state = initialState()
    const jsonCatalog = catalog(state)
    const outcomes = projectCandidateOutcomes({
      analysisInput: analysisInput(state),
      candidateCatalog: jsonCatalog,
    })

    expect(outcomes.map((outcome) => outcome.candidate.candidateId)).toEqual(
      jsonCatalog.map((candidate) => candidate.candidateId),
    )
    expect(
      outcomes.find((outcome) => outcome.candidate.candidateId === 'fold'),
    ).toMatchObject({
      contributionDelta: 0,
      targetStreetCommitment: {
        status: 'notApplicable',
        reasonCode: 'noTarget',
      },
      heroContestablePotAfterAction: 0,
      contestableAmountAdded: 0,
      marginalContestablePot: {
        contestableAmountAdded: 0,
      },
      heroActionCompletes: true,
    })
    expect(
      outcomes.find((outcome) => outcome.candidate.candidateId === 'call:20'),
    ).toMatchObject({
      amountToCall: 20,
      contributionDelta: 20,
      amountActuallyAtRisk: 20,
      minimumRequiredEquityForCall: {
        status: 'available',
        value: { numerator: 2, denominator: 5, basisPoints: 4_000 },
      },
    })
    expect(Object.isFrozen(outcomes)).toBe(true)
    expect(Object.isFrozen(outcomes[0]?.candidate)).toBe(true)
  })

  test('rejects missing, reordered, duplicated, changed and extended catalog entries', () => {
    const state = initialState()
    const valid = catalog(state)
    const cases: unknown[] = [
      valid.slice(1),
      [valid[1], valid[0], ...valid.slice(2)],
      [valid[0], valid[0], ...valid.slice(2)],
      valid.map((candidate, index) =>
        index === 0 ? { ...candidate, targetKind: 'call' } : candidate,
      ),
      valid.map((candidate, index) =>
        index === 0 ? { ...candidate, unexpected: true } : candidate,
      ),
    ]

    for (const candidateCatalog of cases) {
      expect(() =>
        projectCandidateOutcomes({
          analysisInput: analysisInput(state),
          candidateCatalog:
            candidateCatalog as readonly LegalCandidateCatalogEntry[],
        }),
      ).toThrow(/候选目录/)
    }
  })

  test('separates guaranteed uncalled chips from actual risk and response topology', () => {
    const state = shortOpponentRiverState()
    const outcomes = projectCandidateOutcomes({
      analysisInput: analysisInput(state),
      candidateCatalog: catalog(state),
    })
    const allIn = outcomes.find(
      (outcome) => outcome.candidate.candidateId === 'allIn:900',
    )

    expect(allIn).toMatchObject({
      contributionDelta: 900,
      guaranteedUncalledReturn: 850,
      amountActuallyAtRisk: 50,
      contestableAmountAdded: 50,
      potAfterAction: 1_500,
      heroContestablePotAfterAction: 650,
      heroStackAfterAction: 0,
      actionScale: {
        contributionDeltaToPotBefore: {
          ratioKind: 'contributionDeltaToPotBefore',
          value: { numerator: 3, denominator: 2 },
        },
        targetStreetCommitmentToPotBefore: {
          status: 'available',
          ratioKind: 'targetStreetCommitmentToPotBefore',
          value: { numerator: 3, denominator: 2 },
        },
      },
      responders: [4],
      canRaiseSeats: [],
      canFaceFurtherAction: false,
      pureBluffBreakEvenFoldRate: {
        status: 'available',
        value: { numerator: 1, denominator: 13 },
      },
    })
  })

  test('reports forced runout topology without inventing a future SPR', () => {
    const state = forcedRunoutState()
    const outcomes = projectCandidateOutcomes({
      analysisInput: analysisInput(state),
      candidateCatalog: catalog(state),
    })
    const allIn = outcomes.find(
      (outcome) => outcome.candidate.candidateId === 'allIn:20',
    )

    expect(allIn).toMatchObject({
      isAllIn: true,
      forcesRunout: true,
      showdownForced: true,
      remainingStreetsToDeal: 3,
      furtherBettingPossible: false,
      responders: [],
      projectedFlopSpr: {
        status: 'notApplicable',
        reasonCode: 'forcedRunout',
      },
      rangeConditionalEquity: {
        status: 'unavailable',
        reasonCode: 'noVersionedOpponentRange',
      },
      foldEquity: {
        status: 'unavailable',
        reasonCode: 'noJointResponseModel',
      },
      opponentResponseProbability: {
        status: 'unavailable',
        reasonCode: 'noJointResponseModel',
      },
    })
  })
})
