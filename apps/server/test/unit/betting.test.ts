import type { LegalAction } from '@tx-holdem-coach/contracts'
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { applyBettingAction, getLegalActions } from '../../src/poker/betting.js'
import type { PokerCommand } from '../../src/poker/commands.js'
import type { PokerState } from '../../src/poker/state.js'
import { createTestBettingPokerState } from '../poker/create-test-poker-state.js'

function bettingRoundOf(state: ReturnType<typeof createTestBettingPokerState>) {
  const bettingRound = state.hand?.bettingRound

  if (bettingRound === null || bettingRound === undefined) {
    throw new Error('预期下注状态夹具包含下注轮。')
  }

  return bettingRound
}

function commandForLegalAction(
  actorSeatNumber: number,
  action: LegalAction,
  selector: number,
): PokerCommand {
  if (action.type === 'bet' || action.type === 'raise') {
    const targetStreetCommitment =
      action.minTarget + (selector % (action.maxTarget - action.minTarget + 1))

    return {
      actorSeatNumber,
      action: { type: action.type, targetStreetCommitment },
    }
  }

  return {
    actorSeatNumber,
    action: { type: action.type },
  }
}

describe('getLegalActions', () => {
  test('describes fold, call, a full raise range, and all-in when facing the big blind', () => {
    const state = createTestBettingPokerState()

    expect(getLegalActions(state)).toEqual([
      { type: 'fold' },
      { type: 'call', amount: 20 },
      {
        type: 'raise',
        minTarget: 40,
        maxTarget: 1999,
        suggestedTargets: [
          { kind: 'minimum', targetStreetCommitment: 40 },
          { kind: 'halfPot', targetStreetCommitment: 45 },
          { kind: 'twoThirdsPot', targetStreetCommitment: 54 },
          { kind: 'pot', targetStreetCommitment: 70 },
        ],
      },
      { type: 'allIn', target: 2000 },
    ])
  })

  test('offers check and bet choices when no wager exists on the street', () => {
    const baseline = createTestBettingPokerState()
    const state = createTestBettingPokerState({
      seats: baseline.seats.map((seat) => ({
        ...seat,
        streetContribution: 0,
      })),
      hand: {
        street: 'flop',
        bettingRound: {
          currentBet: 0,
          minimumFullRaiseIncrement: 20,
          seatStates: bettingRoundOf(baseline).seatStates,
        },
      },
    })

    expect(getLegalActions(state)).toEqual([
      { type: 'fold' },
      { type: 'check' },
      {
        type: 'bet',
        minTarget: 20,
        maxTarget: 1999,
        suggestedTargets: [
          { kind: 'minimum', targetStreetCommitment: 20 },
          { kind: 'pot', targetStreetCommitment: 30 },
        ],
      },
      { type: 'allIn', target: 2000 },
    ])
  })

  test('preserves the big blind option after matching the nominal wager', () => {
    const state = createTestBettingPokerState({
      hand: { currentActorSeatNumber: 2 },
    })

    expect(getLegalActions(state)).toEqual([
      { type: 'fold' },
      { type: 'check' },
      {
        type: 'raise',
        minTarget: 40,
        maxTarget: 1999,
        suggestedTargets: [
          { kind: 'minimum', targetStreetCommitment: 40 },
          { kind: 'pot', targetStreetCommitment: 50 },
        ],
      },
      { type: 'allIn', target: 2000 },
    ])
  })

  test('uses all-in instead of call when the actor cannot complete the call', () => {
    const baseline = createTestBettingPokerState()
    const state = createTestBettingPokerState({
      seats: baseline.seats.map((seat) =>
        seat.seatNumber === 3 ? { ...seat, stack: 15 } : seat,
      ),
    })

    expect(getLegalActions(state)).toEqual([
      { type: 'fold' },
      { type: 'allIn', target: 15 },
    ])
  })

  test('withholds raise and active all-in after one short raise has not reopened betting', () => {
    const baseline = createTestBettingPokerState()
    const state = createTestBettingPokerState({
      seats: baseline.seats.map((seat) => {
        if (seat.seatNumber === 3) {
          return {
            ...seat,
            stack: 1980,
            streetContribution: 20,
            totalContribution: 20,
          }
        }
        if (seat.seatNumber === 4) {
          return {
            ...seat,
            stack: 1970,
            streetContribution: 30,
            totalContribution: 30,
          }
        }

        return seat
      }),
      hand: {
        pot: 80,
        bettingRound: {
          currentBet: 30,
          minimumFullRaiseIncrement: 20,
          seatStates: bettingRoundOf(baseline).seatStates.map((seatState) =>
            seatState.seatNumber === 3
              ? { ...seatState, betLevelAfterLastAction: 20 }
              : seatState,
          ),
        },
      },
    })

    expect(getLegalActions(state)).toEqual([
      { type: 'fold' },
      { type: 'call', amount: 10 },
    ])
  })

  test('clips and deduplicates suggested targets before the independent all-in', () => {
    const baseline = createTestBettingPokerState()
    const state = createTestBettingPokerState({
      seats: baseline.seats.map((seat) =>
        seat.seatNumber === 3 ? { ...seat, stack: 50 } : seat,
      ),
    })

    expect(getLegalActions(state)).toEqual([
      { type: 'fold' },
      { type: 'call', amount: 20 },
      {
        type: 'raise',
        minTarget: 40,
        maxTarget: 49,
        suggestedTargets: [
          { kind: 'minimum', targetStreetCommitment: 40 },
          { kind: 'halfPot', targetStreetCommitment: 45 },
          { kind: 'twoThirdsPot', targetStreetCommitment: 49 },
        ],
      },
      { type: 'allIn', target: 50 },
    ])
  })

  test('rounds pot fractions upward with integer arithmetic', () => {
    const baseline = createTestBettingPokerState()
    const state = createTestBettingPokerState({
      seats: baseline.seats.map((seat) => ({
        ...seat,
        streetContribution: 0,
        totalContribution: seat.seatNumber === 1 ? 11 : seat.totalContribution,
      })),
      hand: {
        street: 'flop',
        pot: 31,
        bettingRound: {
          currentBet: 0,
          minimumFullRaiseIncrement: 20,
          seatStates: bettingRoundOf(baseline).seatStates,
        },
      },
    })

    expect(getLegalActions(state)[2]).toEqual({
      type: 'bet',
      minTarget: 20,
      maxTarget: 1999,
      suggestedTargets: [
        { kind: 'minimum', targetStreetCommitment: 20 },
        { kind: 'twoThirdsPot', targetStreetCommitment: 21 },
        { kind: 'pot', targetStreetCommitment: 31 },
      ],
    })
  })

  test('raises by a full minimum increment above a short postflop all-in opener', () => {
    const baseline = createTestBettingPokerState()
    const state = createTestBettingPokerState({
      seats: baseline.seats.map((seat) => {
        if (seat.seatNumber === 4) {
          return {
            ...seat,
            stack: 0,
            status: 'allIn' as const,
            streetContribution: 7,
            totalContribution: 7,
          }
        }

        return {
          ...seat,
          streetContribution: 0,
          totalContribution: 0,
        }
      }),
      hand: {
        street: 'flop',
        pot: 7,
        bettingRound: {
          currentBet: 7,
          minimumFullRaiseIncrement: 20,
          seatStates: bettingRoundOf(baseline).seatStates.map((seatState) =>
            seatState.seatNumber === 4
              ? { ...seatState, betLevelAfterLastAction: 7 }
              : seatState,
          ),
        },
      },
    })

    expect(getLegalActions(state)).toEqual([
      { type: 'fold' },
      { type: 'call', amount: 7 },
      {
        type: 'raise',
        minTarget: 27,
        maxTarget: 1999,
        suggestedTargets: [{ kind: 'minimum', targetStreetCommitment: 27 }],
      },
      { type: 'allIn', target: 2000 },
    ])
  })

  test('keeps every generated suggestion canonical for controlled legal states', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 22, max: 3000 }),
        fc.integer({ min: 0, max: 5000 }),
        (actorStack, pot) => {
          const baseline = createTestBettingPokerState()
          const state = createTestBettingPokerState({
            seats: baseline.seats.map((seat) => ({
              ...seat,
              stack: seat.seatNumber === 3 ? actorStack : seat.stack,
              streetContribution: 0,
              totalContribution: seat.seatNumber === 1 ? pot : 0,
            })),
            hand: {
              street: 'flop',
              pot,
              bettingRound: {
                currentBet: 0,
                minimumFullRaiseIncrement: 20,
                seatStates: bettingRoundOf(baseline).seatStates,
              },
            },
          })
          const bet = getLegalActions(state).find(
            (action) => action.type === 'bet',
          )

          if (bet === undefined) {
            throw new Error('预期受控状态始终存在普通下注区间。')
          }

          const priorities = {
            minimum: 0,
            halfPot: 1,
            twoThirdsPot: 2,
            pot: 3,
          } as const
          const kinds = bet.suggestedTargets.map(({ kind }) => kind)
          const targets = bet.suggestedTargets.map(
            ({ targetStreetCommitment }) => targetStreetCommitment,
          )

          expect(bet.suggestedTargets[0]).toEqual({
            kind: 'minimum',
            targetStreetCommitment: bet.minTarget,
          })
          expect(new Set(kinds).size).toBe(kinds.length)
          expect(new Set(targets).size).toBe(targets.length)
          expect(kinds.map((kind) => priorities[kind])).toEqual(
            [...kinds]
              .map((kind) => priorities[kind])
              .sort((left, right) => left - right),
          )
          for (const target of targets) {
            expect(target).toBeGreaterThanOrEqual(bet.minTarget)
            expect(target).toBeLessThanOrEqual(bet.maxTarget)
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})

describe('applyBettingAction', () => {
  test('applies a call as an immutable intermediate betting transition', () => {
    const state = createTestBettingPokerState()
    const stateBefore = structuredClone(state)

    const result = applyBettingAction(state, {
      actorSeatNumber: 3,
      action: { type: 'call' },
    })

    expect(result).toMatchObject({
      actorSeatNumber: 3,
      action: { type: 'call' },
      contributionDelta: 20,
      pot: 50,
      bettingRound: {
        currentBet: 20,
        minimumFullRaiseIncrement: 20,
      },
    })
    expect(
      result.seats.find(({ seatNumber }) => seatNumber === 3),
    ).toMatchObject({
      stack: 1980,
      status: 'active',
      streetContribution: 20,
      totalContribution: 20,
    })
    expect(
      result.bettingRound.seatStates.find(({ seatNumber }) => seatNumber === 3),
    ).toEqual({
      seatNumber: 3,
      betLevelAfterLastAction: 20,
    })
    expect(result).not.toHaveProperty('currentActorSeatNumber')
    expect(result).not.toHaveProperty('street')
    expect(result).not.toHaveProperty('stateVersion')
    expect(result).not.toHaveProperty('hand')
    expect(state).toEqual(stateBefore)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.seats)).toBe(true)
    expect(Object.isFrozen(result.bettingRound)).toBe(true)
    expect(Object.isFrozen(result.bettingRound.seatStates)).toBe(true)
  })

  test('records the table bet level after fold and check without moving chips', () => {
    const folded = applyBettingAction(createTestBettingPokerState(), {
      actorSeatNumber: 3,
      action: { type: 'fold' },
    })
    const checked = applyBettingAction(
      createTestBettingPokerState({
        hand: { currentActorSeatNumber: 2 },
      }),
      {
        actorSeatNumber: 2,
        action: { type: 'check' },
      },
    )

    expect(folded).toMatchObject({
      contributionDelta: 0,
      pot: 30,
      bettingRound: {
        currentBet: 20,
        minimumFullRaiseIncrement: 20,
      },
    })
    expect(
      folded.seats.find(({ seatNumber }) => seatNumber === 3),
    ).toMatchObject({ status: 'folded', stack: 2000 })
    expect(
      folded.bettingRound.seatStates.find(({ seatNumber }) => seatNumber === 3),
    ).toMatchObject({ betLevelAfterLastAction: 20 })

    expect(checked).toMatchObject({
      contributionDelta: 0,
      pot: 30,
      bettingRound: {
        currentBet: 20,
        minimumFullRaiseIncrement: 20,
      },
    })
    expect(
      checked.bettingRound.seatStates.find(
        ({ seatNumber }) => seatNumber === 2,
      ),
    ).toMatchObject({ betLevelAfterLastAction: 20 })
  })

  test('applies an exact non-suggested full raise target', () => {
    const result = applyBettingAction(createTestBettingPokerState(), {
      actorSeatNumber: 3,
      action: { type: 'raise', targetStreetCommitment: 41 },
    })

    expect(result).toMatchObject({
      contributionDelta: 41,
      pot: 71,
      bettingRound: {
        currentBet: 41,
        minimumFullRaiseIncrement: 21,
      },
    })
    expect(
      result.seats.find(({ seatNumber }) => seatNumber === 3),
    ).toMatchObject({
      stack: 1959,
      streetContribution: 41,
      totalContribution: 41,
    })
    expect(
      result.bettingRound.seatStates.find(({ seatNumber }) => seatNumber === 3),
    ).toMatchObject({ betLevelAfterLastAction: 41 })
  })

  test('applies a postflop bet and sets its amount as the new full increment', () => {
    const baseline = createTestBettingPokerState()
    const state = createTestBettingPokerState({
      seats: baseline.seats.map((seat) => ({
        ...seat,
        streetContribution: 0,
      })),
      hand: {
        street: 'flop',
        bettingRound: {
          currentBet: 0,
          minimumFullRaiseIncrement: 20,
          seatStates: bettingRoundOf(baseline).seatStates,
        },
      },
    })

    const result = applyBettingAction(state, {
      actorSeatNumber: 3,
      action: { type: 'bet', targetStreetCommitment: 40 },
    })

    expect(result).toMatchObject({
      contributionDelta: 40,
      pot: 70,
      bettingRound: {
        currentBet: 40,
        minimumFullRaiseIncrement: 40,
      },
    })
  })

  test('records a short all-in call at the full level it faced', () => {
    const baseline = createTestBettingPokerState()
    const state = createTestBettingPokerState({
      seats: baseline.seats.map((seat) =>
        seat.seatNumber === 3 ? { ...seat, stack: 15 } : seat,
      ),
    })

    const result = applyBettingAction(state, {
      actorSeatNumber: 3,
      action: { type: 'allIn' },
    })

    expect(result).toMatchObject({
      contributionDelta: 15,
      pot: 45,
      bettingRound: {
        currentBet: 20,
        minimumFullRaiseIncrement: 20,
      },
    })
    expect(
      result.seats.find(({ seatNumber }) => seatNumber === 3),
    ).toMatchObject({
      stack: 0,
      status: 'allIn',
      streetContribution: 15,
      totalContribution: 15,
    })
    expect(
      result.bettingRound.seatStates.find(({ seatNumber }) => seatNumber === 3),
    ).toMatchObject({ betLevelAfterLastAction: 20 })
  })

  test('raises currentBet without shrinking the full increment for one short all-in', () => {
    const baseline = createTestBettingPokerState()
    const state = createTestBettingPokerState({
      seats: baseline.seats.map((seat) =>
        seat.seatNumber === 3 ? { ...seat, stack: 30 } : seat,
      ),
    })

    const result = applyBettingAction(state, {
      actorSeatNumber: 3,
      action: { type: 'allIn' },
    })

    expect(result).toMatchObject({
      contributionDelta: 30,
      pot: 60,
      bettingRound: {
        currentBet: 30,
        minimumFullRaiseIncrement: 20,
      },
    })
    expect(
      result.bettingRound.seatStates.find(({ seatNumber }) => seatNumber === 3),
    ).toMatchObject({ betLevelAfterLastAction: 30 })
  })

  test('uses the actual increase when an all-in makes a full raise', () => {
    const baseline = createTestBettingPokerState()
    const state = createTestBettingPokerState({
      seats: baseline.seats.map((seat) =>
        seat.seatNumber === 3 ? { ...seat, stack: 55 } : seat,
      ),
    })

    const result = applyBettingAction(state, {
      actorSeatNumber: 3,
      action: { type: 'allIn' },
    })

    expect(result).toMatchObject({
      contributionDelta: 55,
      pot: 85,
      bettingRound: {
        currentBet: 55,
        minimumFullRaiseIncrement: 35,
      },
    })
  })

  test('rejects strict-command, actor, action, and exact-target violations', () => {
    const state = createTestBettingPokerState()
    const invalidCommands = [
      {
        actorSeatNumber: 4,
        action: { type: 'call' },
      },
      {
        actorSeatNumber: 3,
        action: { type: 'check' },
      },
      {
        actorSeatNumber: 3,
        action: { type: 'raise', targetStreetCommitment: 39 },
      },
      {
        actorSeatNumber: 3,
        action: { type: 'raise', targetStreetCommitment: 2000 },
      },
      {
        actorSeatNumber: 3,
        action: { type: 'call' },
        expectedStateVersion: 0,
      },
    ]

    for (const command of invalidCommands) {
      expect(() => applyBettingAction(state, command as PokerCommand)).toThrow()
    }
  })

  test('defensively rejects betting states that bypass stable-state invariants', () => {
    const invalidPotState = structuredClone(
      createTestBettingPokerState(),
    ) as unknown as {
      hand: { pot: number }
    }
    invalidPotState.hand.pot = 31

    const invalidContributionState = structuredClone(
      createTestBettingPokerState(),
    ) as unknown as {
      seats: Array<{ seatNumber: number; streetContribution: number }>
    }
    const actor = invalidContributionState.seats.find(
      ({ seatNumber }) => seatNumber === 3,
    )
    if (actor === undefined) {
      throw new Error('预期下注状态夹具包含当前行动者。')
    }
    actor.streetContribution = 21

    expect(() =>
      getLegalActions(invalidPotState as unknown as PokerState),
    ).toThrow('底池')
    expect(() =>
      getLegalActions(invalidContributionState as unknown as PokerState),
    ).toThrow('本街投入')
  })

  test('conserves every chip delta for controlled legal actions', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3000 }),
        fc.nat(),
        (actorStack, selector) => {
          const baseline = createTestBettingPokerState()
          const state = createTestBettingPokerState({
            seats: baseline.seats.map((seat) =>
              seat.seatNumber === 3 ? { ...seat, stack: actorStack } : seat,
            ),
          })
          const legalActions = getLegalActions(state)
          const legalAction = legalActions[
            selector % legalActions.length
          ] as LegalAction
          const command = commandForLegalAction(3, legalAction, selector)
          const actorBefore = state.seats.find(
            ({ seatNumber }) => seatNumber === 3,
          )

          if (actorBefore === undefined) {
            throw new Error('预期下注状态夹具包含当前行动者。')
          }

          const result = applyBettingAction(state, command)
          const actorAfter = result.seats.find(
            ({ seatNumber }) => seatNumber === 3,
          )

          if (actorAfter === undefined) {
            throw new Error('预期迁移结果保留行动者座位。')
          }

          expect(actorBefore.stack - actorAfter.stack).toBe(
            result.contributionDelta,
          )
          expect(
            actorAfter.streetContribution - actorBefore.streetContribution,
          ).toBe(result.contributionDelta)
          expect(
            actorAfter.totalContribution - actorBefore.totalContribution,
          ).toBe(result.contributionDelta)
          expect(result.pot - (state.hand?.pot ?? 0)).toBe(
            result.contributionDelta,
          )
        },
      ),
      { numRuns: 100 },
    )
  })
})
