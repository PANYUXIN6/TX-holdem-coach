import { describe, expect, test } from 'vitest'
import { AuthoritativeStateValidationError } from '../../src/sessions/authoritative-state/errors.js'
import {
  createPrivateTableState,
  createPrivateTableStateContent,
} from '../../src/sessions/authoritative-state/private-table-state.js'
import {
  createTestBettingPokerState,
  createTestPokerState,
} from '../poker/create-test-poker-state.js'
import { createTestCompletedPokerResult } from '../poker/create-test-completed-poker-result.js'

describe('private table state', () => {
  test('constructs strict versionless content for executor-owned version assignment', () => {
    const poker = createTestPokerState()
    const content = createPrivateTableStateContent({
      poker,
      completedHandCount: 0,
      seatAccounting: poker.seats.map((seat) => ({
        seatNumber: seat.seatNumber,
        cumulativeBuyIn: 2_000,
      })),
      lastCompletedHandSummary: null,
    })

    expect(content).not.toHaveProperty('stateVersion')
    expect(Object.isFrozen(content)).toBe(true)
    expect(() =>
      createPrivateTableStateContent({ ...content, stateVersion: 1 }),
    ).toThrow(AuthoritativeStateValidationError)
  })

  test('creates the minimal valid authoritative state as a sorted deep-frozen value', () => {
    const poker = createTestPokerState()
    const state = createPrivateTableState({
      stateVersion: 0,
      poker,
      completedHandCount: 0,
      seatAccounting: poker.seats
        .map((seat) => ({
          seatNumber: seat.seatNumber,
          cumulativeBuyIn: 2_000,
        }))
        .reverse(),
      lastCompletedHandSummary: null,
    })

    expect(state).toEqual({
      stateVersion: 0,
      poker,
      completedHandCount: 0,
      seatAccounting: [0, 1, 2, 3, 4, 5].map((seatNumber) => ({
        seatNumber,
        cumulativeBuyIn: 2_000,
      })),
      lastCompletedHandSummary: null,
    })
    expect(Object.isFrozen(state)).toBe(true)
    expect(Object.isFrozen(state.poker.seats)).toBe(true)
    expect(Object.isFrozen(state.seatAccounting[0])).toBe(true)
  })

  test('rejects a state version above the safe integer range with the authoritative error', () => {
    const poker = createTestPokerState()

    expect(() =>
      createPrivateTableState({
        stateVersion: Number.MAX_SAFE_INTEGER + 1,
        poker,
        completedHandCount: 0,
        seatAccounting: poker.seats.map((seat) => ({
          seatNumber: seat.seatNumber,
          cumulativeBuyIn: 2_000,
        })),
        lastCompletedHandSummary: null,
      }),
    ).toThrow(AuthoritativeStateValidationError)
  })

  test('requires accounting seats to match the fixed roster exactly once', () => {
    const poker = createTestPokerState()
    const accounting = poker.seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      cumulativeBuyIn: 2_000,
    }))
    const invalidAccounting = [
      accounting.slice(0, -1),
      [...accounting.slice(0, -1), accounting[0]],
    ]

    for (const seatAccounting of invalidAccounting) {
      expect(() =>
        createPrivateTableState({
          stateVersion: 0,
          poker,
          completedHandCount: 0,
          seatAccounting,
          lastCompletedHandSummary: null,
        }),
      ).toThrow(AuthoritativeStateValidationError)
    }
  })

  test('rejects accounting that does not exactly fund stacks plus the current pot', () => {
    const poker = createTestBettingPokerState()

    expect(() =>
      createPrivateTableState({
        stateVersion: 1,
        poker,
        completedHandCount: 0,
        seatAccounting: poker.seats.map((seat) => ({
          seatNumber: seat.seatNumber,
          cumulativeBuyIn: seat.seatNumber === 0 ? 1_999 : 2_000,
        })),
        lastCompletedHandSummary: null,
      }),
    ).toThrow(AuthoritativeStateValidationError)
  })

  test('requires every persisted number and each exact total to stay in the safe integer range', () => {
    const baseline = createTestPokerState()
    const largeStack = 1_600_000_000_000_000
    const overflowingPoker = createTestPokerState({
      seats: baseline.seats.map((seat) => ({ ...seat, stack: largeStack })),
    })

    expect(() =>
      createPrivateTableState({
        stateVersion: 0,
        poker: overflowingPoker,
        seatAccounting: overflowingPoker.seats.map((seat) => ({
          seatNumber: seat.seatNumber,
          cumulativeBuyIn: largeStack,
        })),
        completedHandCount: 0,
        lastCompletedHandSummary: null,
      }),
    ).toThrow(AuthoritativeStateValidationError)
  })

  test('rejects an unsafe nested poker number even when chip accounting still balances', () => {
    const poker = structuredClone(createTestBettingPokerState())
    if (poker.hand?.bettingRound === null || poker.hand === null) {
      throw new Error('Expected a betting-round fixture.')
    }
    const invalidPoker = {
      ...poker,
      hand: {
        ...poker.hand,
        bettingRound: {
          ...poker.hand.bettingRound,
          minimumFullRaiseIncrement: Number.MAX_SAFE_INTEGER + 1,
        },
      },
    }

    expect(() =>
      createPrivateTableState({
        stateVersion: 1,
        poker: invalidPoker,
        completedHandCount: 0,
        seatAccounting: poker.seats.map((seat) => ({
          seatNumber: seat.seatNumber,
          cumulativeBuyIn: 2_000,
        })),
        lastCompletedHandSummary: null,
      }),
    ).toThrow(AuthoritativeStateValidationError)
  })

  test('requires the completed-hand count and latest summary presence to agree', () => {
    const poker = createTestPokerState()
    const seatAccounting = poker.seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      cumulativeBuyIn: 2_000,
    }))

    for (const invalidPair of [
      { completedHandCount: 1, lastCompletedHandSummary: null },
      { completedHandCount: 0, lastCompletedHandSummary: {} },
    ]) {
      expect(() =>
        createPrivateTableState({
          stateVersion: 0,
          poker,
          seatAccounting,
          ...invalidPair,
        }),
      ).toThrow(AuthoritativeStateValidationError)
    }
  })

  test('accepts a roster-consistent latest-hand subset and rejects a mismatched player mirror', () => {
    const completed = createTestCompletedPokerResult()
    const extraSeat = {
      seatNumber: 6,
      playerId: '00000000-0000-4000-8000-000000000007',
      isUser: false,
      stack: 1_000,
      status: 'active' as const,
      streetContribution: 0,
      totalContribution: 0,
    }
    const poker = createTestPokerState({
      seats: [...completed.state.seats, extraSeat],
    })
    const seatAccounting = poker.seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      cumulativeBuyIn: 1_000,
    }))
    const summary = completed.completedHand.summary

    expect(
      createPrivateTableState({
        stateVersion: 2,
        poker,
        completedHandCount: 1,
        seatAccounting,
        lastCompletedHandSummary: summary,
      }).lastCompletedHandSummary,
    ).toEqual(summary)

    expect(() =>
      createPrivateTableState({
        stateVersion: 2,
        poker,
        completedHandCount: 1,
        seatAccounting,
        lastCompletedHandSummary: {
          ...summary,
          seats: summary.seats.map((seat) =>
            seat.seatNumber === 1
              ? {
                  ...seat,
                  playerId: '99999999-9999-4999-8999-999999999999',
                }
              : seat,
          ),
        },
      }),
    ).toThrow(AuthoritativeStateValidationError)
  })
})
