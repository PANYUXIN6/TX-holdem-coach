import { describe, expect, test } from 'vitest'
import {
  initializePokerTable,
  startPokerHand,
} from '../../src/poker/poker-engine.js'
import { POKER_RULE_SET_VERSION } from '../../src/poker/poker-rule-set.js'
import { createPokerTableState } from '../../src/poker/state.js'
import { createPrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'
import {
  currentHandStartCheckpointReader,
  decodeCurrentHandStartCheckpoint,
  encodeCurrentHandStartCheckpoint,
  HAND_START_CHECKPOINT_PAYLOAD_VERSION,
} from '../../src/sessions/hand-audit/hand-start-checkpoint-codec.js'
import {
  COMPLETED_HAND_RESULT_PAYLOAD_VERSION,
  currentCompletedHandResultReader,
  decodeCurrentCompletedHandResult,
  encodeCompletedHandResult,
} from '../../src/sessions/hand-audit/completed-hand-result-codec.js'
import { createTestCompletedPokerResult } from '../poker/create-test-completed-poker-result.js'

const handId = '10000000-0000-4000-8000-000000000001'
const randomSource = Object.freeze({ nextInt: () => 0 })

function createCheckpointInput() {
  const poker = initializePokerTable(
    Array.from({ length: 6 }, (_, seatNumber) => ({
      seatNumber,
      playerId: `00000000-0000-4000-8000-${(seatNumber + 1)
        .toString()
        .padStart(12, '0')}`,
      isUser: seatNumber === 0,
      stack: 1_000,
      status: 'active' as const,
      streetContribution: 0,
      totalContribution: 0,
    })),
    randomSource,
  )
  const stateBeforeStartCommand = createPrivateTableState({
    stateVersion: 7,
    poker,
    completedHandCount: 0,
    seatAccounting: poker.seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      cumulativeBuyIn: 1_000,
    })),
    lastCompletedHandSummary: null,
  })
  const afterAutoRebuy = createPokerTableState({
    ...poker,
    seats: poker.seats.map((seat) =>
      seat.seatNumber === 1
        ? { ...seat, stack: 1_500 }
        : { ...seat, stack: seat.stack },
    ),
  })
  const { startedHand } = startPokerHand(afterAutoRebuy, {
    handId,
    completedHandCountBeforeStart: 0,
    randomSource,
  })
  return { stateBeforeStartCommand, startedHand }
}

describe('hand audit codecs', () => {
  test('round-trips the current checkpoint with its bound rule set', () => {
    const input = {
      pokerRuleSetVersion: POKER_RULE_SET_VERSION,
      ...createCheckpointInput(),
    }
    const encoded = encodeCurrentHandStartCheckpoint(input)

    expect(HAND_START_CHECKPOINT_PAYLOAD_VERSION).toBe(1)
    expect(encoded).toEqual({
      payloadVersion: 1,
      payload: {
        checkpoint: input,
      },
    })
    expect(decodeCurrentHandStartCheckpoint(structuredClone(encoded))).toEqual(
      encoded,
    )
    expect(Object.isFrozen(encoded)).toBe(true)
    expect(Object.isFrozen(encoded.payload.checkpoint)).toBe(true)
  })

  test('reads the current checkpoint and classifies unknown or damaged rows', () => {
    const current = encodeCurrentHandStartCheckpoint({
      pokerRuleSetVersion: POKER_RULE_SET_VERSION,
      ...createCheckpointInput(),
    })

    expect(
      currentHandStartCheckpointReader.read(
        current.payloadVersion,
        current.payload,
      ),
    ).toEqual({
      kind: 'decoded',
      value: current.payload.checkpoint,
    })
    expect(
      currentHandStartCheckpointReader.read(99, { checkpoint: {} }),
    ).toEqual({ kind: 'unknownVersion' })
    expect(
      currentHandStartCheckpointReader.read(1, { checkpoint: {} }),
    ).toEqual({ kind: 'invalidPayload' })
  })

  test('rejects a checkpoint whose started hand contains a zero stack', () => {
    const input = {
      pokerRuleSetVersion: POKER_RULE_SET_VERSION,
      ...createCheckpointInput(),
    }
    const invalid = {
      ...input,
      startedHand: {
        ...input.startedHand,
        startingStacks: input.startedHand.startingStacks.map((stack, index) =>
          index === 0 ? { ...stack, stack: 0 } : stack,
        ),
      },
    }

    expect(() => encodeCurrentHandStartCheckpoint(invalid)).toThrow(
      '手牌审计载荷无效。',
    )
  })

  test('rejects a checkpoint whose button and logical positions do not mirror', () => {
    const input = {
      pokerRuleSetVersion: POKER_RULE_SET_VERSION,
      ...createCheckpointInput(),
    }
    const invalid = {
      ...input,
      startedHand: {
        ...input.startedHand,
        positions: input.startedHand.positions.map((position) =>
          position.seatNumber === input.startedHand.buttonSeatNumber
            ? { ...position, position: 'CO' as const }
            : position,
        ),
      },
    }

    expect(() => encodeCurrentHandStartCheckpoint(invalid)).toThrow(
      '手牌审计载荷无效。',
    )
  })

  test('round-trips a complete M1.9 hand result as an independently versioned deep-frozen value', () => {
    const result = createTestCompletedPokerResult().completedHand

    const encoded = encodeCompletedHandResult(result)

    expect(COMPLETED_HAND_RESULT_PAYLOAD_VERSION).toBe(1)
    expect(encoded).toEqual({
      payloadVersion: 1,
      payload: { result },
    })
    expect(decodeCurrentCompletedHandResult(structuredClone(encoded))).toEqual(
      encoded,
    )
    expect(Object.isFrozen(encoded.payload.result.remainingDeck)).toBe(true)
    expect(Object.isFrozen(encoded.payload.result.summary)).toBe(true)
  })

  test('rejects a chip-conserving result whose per-seat payout arithmetic is false', () => {
    const result = createTestCompletedPokerResult().completedHand
    const shiftPayout = (seat: (typeof result.seats)[number], index: number) =>
      index === 0
        ? {
            ...seat,
            endingStack: seat.endingStack + 1,
            netChange: seat.netChange + 1,
          }
        : index === 1
          ? {
              ...seat,
              endingStack: seat.endingStack - 1,
              netChange: seat.netChange - 1,
            }
          : seat
    const invalid = {
      ...result,
      seats: result.seats.map(shiftPayout),
      summary: {
        ...result.summary,
        seats: result.summary.seats.map(shiftPayout),
      },
    }

    expect(() => encodeCompletedHandResult(invalid)).toThrow(
      '手牌审计载荷无效。',
    )
  })

  test('rejects a contribution above the starting stack even when payout arithmetic balances', () => {
    const result = createTestCompletedPokerResult().completedHand
    const seats = result.seats.map((seat) =>
      seat.seatNumber === 2 ? { ...seat, totalContribution: 2_000 } : seat,
    )
    const uncalledBetReturns = result.uncalledBetReturns.map((returned) =>
      returned.seatNumber === 2 ? { ...returned, amount: 1_990 } : returned,
    )

    expect(() =>
      encodeCompletedHandResult({
        ...result,
        seats,
        uncalledBetReturns,
        summary: {
          ...result.summary,
          seats,
          uncalledBetReturns,
        },
      }),
    ).toThrow('手牌审计载荷无效。')
  })

  test('rejects an uncalled return above its seat contribution even when all totals balance', () => {
    const result = createTestCompletedPokerResult().completedHand
    const seats = result.seats.map((seat) => {
      if (seat.seatNumber === 1) {
        return {
          ...seat,
          endingStack: 970,
          totalContribution: 30,
          netChange: -30,
        }
      }
      if (seat.seatNumber === 2) {
        return { ...seat, endingStack: 1_030, netChange: 30 }
      }
      return seat
    })
    const uncalledBetReturns = result.uncalledBetReturns.map((returned) =>
      returned.seatNumber === 2 ? { ...returned, amount: 30 } : returned,
    )

    expect(() =>
      encodeCompletedHandResult({
        ...result,
        seats,
        uncalledBetReturns,
        summary: {
          ...result.summary,
          seats,
          uncalledBetReturns,
        },
      }),
    ).toThrow('手牌审计载荷无效。')
  })

  test('rejects duplicate awards for the same winning seat even when pot arithmetic still balances', () => {
    const result = createTestCompletedPokerResult().completedHand
    const firstPot = result.pots[0]!
    const firstAward = firstPot.awards[0]!
    const duplicatedAwards = [
      {
        ...firstAward,
        baseAmount: 1,
        oddChipAmount: 0 as const,
        amount: 1,
      },
      {
        ...firstAward,
        baseAmount: firstAward.amount - 1,
        oddChipAmount: 0 as const,
        amount: firstAward.amount - 1,
      },
    ]
    const duplicatedPots = result.pots.map((pot, index) =>
      index === 0 ? { ...pot, awards: duplicatedAwards } : pot,
    )

    expect(() =>
      encodeCompletedHandResult({
        ...result,
        pots: duplicatedPots,
        summary: { ...result.summary, pots: duplicatedPots },
      }),
    ).toThrow('手牌审计载荷无效。')
  })

  test('rejects a result whose persisted card zones no longer form one exact standard deck', () => {
    const result = createTestCompletedPokerResult().completedHand

    expect(() =>
      encodeCompletedHandResult({
        ...result,
        remainingDeck: [
          result.remainingDeck[1]!,
          ...result.remainingDeck.slice(1),
        ],
      }),
    ).toThrow('手牌审计载荷无效。')
  })

  test('accepts structurally and arithmetically consistent recorded payouts without recomputing the poker winner', () => {
    const result = createTestCompletedPokerResult().completedHand
    const firstPot = result.pots[0]!
    const recordedWinner = firstPot.winningSeatNumbers[0]!
    const alternativeWinner = firstPot.contributingSeatNumbers.find(
      (seatNumber) => seatNumber !== recordedWinner,
    )!
    const redistributedPots = result.pots.map((pot, index) =>
      index === 0
        ? {
            ...pot,
            eligibleSeatNumbers: [alternativeWinner],
            winningSeatNumbers: [alternativeWinner],
            awards: pot.awards.map((award) => ({
              ...award,
              seatNumber: alternativeWinner,
            })),
          }
        : pot,
    )
    const awardBySeat = new Map<number, bigint>()
    for (const award of redistributedPots.flatMap((pot) => pot.awards)) {
      awardBySeat.set(
        award.seatNumber,
        (awardBySeat.get(award.seatNumber) ?? 0n) + BigInt(award.amount),
      )
    }
    const returnedBySeat = new Map<number, bigint>()
    for (const returned of result.uncalledBetReturns) {
      returnedBySeat.set(
        returned.seatNumber,
        (returnedBySeat.get(returned.seatNumber) ?? 0n) +
          BigInt(returned.amount),
      )
    }
    const redistributedSeats = result.seats.map((seat) => {
      const endingStack = Number(
        BigInt(seat.startingStack) -
          BigInt(seat.totalContribution) +
          (returnedBySeat.get(seat.seatNumber) ?? 0n) +
          (awardBySeat.get(seat.seatNumber) ?? 0n),
      )
      return {
        ...seat,
        endingStack,
        netChange: endingStack - seat.startingStack,
      }
    })

    expect(() =>
      encodeCompletedHandResult({
        ...result,
        pots: redistributedPots,
        seats: redistributedSeats,
        summary: {
          ...result.summary,
          pots: redistributedPots,
          seats: redistributedSeats,
        },
      }),
    ).not.toThrow()
  })

  test('reads the current completed result and classifies unknown rows', () => {
    const current = encodeCompletedHandResult(
      createTestCompletedPokerResult().completedHand,
    )

    expect(
      currentCompletedHandResultReader.read(
        current.payloadVersion,
        current.payload,
      ),
    ).toEqual({ kind: 'decoded', value: current.payload.result })
    expect(currentCompletedHandResultReader.read(2, { result: {} })).toEqual({
      kind: 'unknownVersion',
    })
  })

  test('classifies a damaged current result payload', () => {
    expect(currentCompletedHandResultReader.read(1, { result: {} })).toEqual({
      kind: 'invalidPayload',
    })
  })
})
