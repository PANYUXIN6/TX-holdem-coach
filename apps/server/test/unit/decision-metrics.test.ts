import { describe, expect, test } from 'vitest'
import {
  createInitialBettingProjection,
  getProjectedLegalActions,
  type BettingProjectionState,
} from '../../src/poker/betting-projection.js'
import type { DecisionAnalysisInput } from '../../src/poker/decision-analysis-input.js'
import { computeDecisionMetrics } from '../../src/poker/decision-metrics.js'
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

function postflopState(): BettingProjectionState {
  return {
    buttonSeatNumber: 0,
    participantSeatNumbers: [...PARTICIPANTS],
    street: 'flop',
    currentActorSeatNumber: 3,
    pot: 300,
    seats: [
      {
        seatNumber: 0,
        status: 'folded',
        stack: 980,
        streetContribution: 0,
        totalContribution: 20,
      },
      {
        seatNumber: 1,
        status: 'folded',
        stack: 980,
        streetContribution: 0,
        totalContribution: 20,
      },
      {
        seatNumber: 2,
        status: 'active',
        stack: 900,
        streetContribution: 20,
        totalContribution: 100,
      },
      {
        seatNumber: 3,
        status: 'active',
        stack: 900,
        streetContribution: 0,
        totalContribution: 100,
      },
      {
        seatNumber: 4,
        status: 'folded',
        stack: 970,
        streetContribution: 0,
        totalContribution: 30,
      },
      {
        seatNumber: 5,
        status: 'folded',
        stack: 970,
        streetContribution: 0,
        totalContribution: 30,
      },
    ],
    bettingRound: {
      currentBet: 20,
      minimumFullRaiseIncrement: 20,
      seatStates: PARTICIPANTS.map((seatNumber) => ({
        seatNumber,
        betLevelAfterLastAction: seatNumber === 3 ? null : 20,
      })),
    },
  }
}

describe('computeDecisionMetrics', () => {
  test('separates current amounts and computes call odds from Hero contestable pot', () => {
    const metrics = computeDecisionMetrics(analysisInput(initialState()))

    expect(metrics.amounts).toEqual({
      amountToCall: 20,
      currentStreetContribution: 0,
      currentTotalContribution: 0,
      minimumBetOrRaiseTarget: 40,
      maximumOrdinaryTarget: 1_999,
      allInTarget: 2_000,
    })
    expect(metrics.potOdds).toMatchObject({
      status: 'available',
      value: { numerator: 2, denominator: 5, basisPoints: 4_000 },
      assumptionCodes: ['ignoresFutureAction'],
    })
    expect(metrics.currentSpr).toMatchObject({
      status: 'notApplicable',
      reasonCode: 'preflopCurrentSprUndefined',
    })
    expect(Object.isFrozen(metrics)).toBe(true)
  })

  test('computes postflop SPR against each still-competing opponent', () => {
    const metrics = computeDecisionMetrics(analysisInput(postflopState()))

    expect(metrics.potOdds).toMatchObject({
      status: 'available',
      value: { numerator: 1, denominator: 16, basisPoints: 625 },
    })
    expect(metrics.currentSpr).toMatchObject({
      status: 'available',
      value: {
        byOpponent: [
          {
            opponentSeatNumber: 2,
            effectiveStack: 900,
            spr: { numerator: 3, denominator: 1, basisPoints: 30_000 },
          },
        ],
        maximumOpponentEffectiveSpr: {
          effectiveStack: 900,
          spr: { numerator: 3, denominator: 1, basisPoints: 30_000 },
        },
      },
    })
  })

  test('marks pot odds not applicable when no call is required', () => {
    const state = postflopState()
    const checkedState: BettingProjectionState = {
      ...state,
      bettingRound: {
        ...state.bettingRound,
        currentBet: 0,
        seatStates: state.bettingRound.seatStates.map((seat) => ({
          ...seat,
          betLevelAfterLastAction: null,
        })),
      },
      seats: state.seats.map((seat) => ({ ...seat, streetContribution: 0 })),
    }

    expect(computeDecisionMetrics(analysisInput(checkedState)).potOdds).toEqual(
      expect.objectContaining({
        status: 'notApplicable',
        reasonCode: 'noCallRequired',
      }),
    )
  })

  test('keeps contribution and target pot ratios semantically distinct', () => {
    const base = analysisInput(initialState())
    const metrics = computeDecisionMetrics({
      ...base,
      publicActions: [
        {
          eventSeq: 1,
          streetBefore: 'preflop',
          actorSeatNumber: 0,
          action: { type: 'call' },
          amountToCallBefore: 20,
          contributionDelta: 20,
          targetStreetCommitmentAfter: 20,
          totalContributionAfter: 20,
          potBefore: 30,
          currentBetBefore: 20,
          currentBetAfter: 20,
          minimumFullRaiseIncrementBefore: 20,
          minimumFullRaiseIncrementAfter: 20,
          isVoluntaryPreflopContribution: true,
          isFullRaise: false,
        },
      ],
    })

    expect(metrics.publicActionScales).toEqual([
      expect.objectContaining({
        eventSeq: 1,
        contributionDeltaToPotBefore: {
          ratioKind: 'contributionDeltaToPotBefore',
          value: { numerator: 2, denominator: 3, basisPoints: 6_667 },
        },
        targetStreetCommitmentToPotBefore: {
          status: 'available',
          ratioKind: 'targetStreetCommitmentToPotBefore',
          value: { numerator: 2, denominator: 3, basisPoints: 6_667 },
        },
      }),
    ])
  })
})
