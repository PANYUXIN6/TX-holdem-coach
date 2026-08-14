import { describe, expect, test } from 'vitest'
import {
  initializePokerTable,
  startPokerHand,
} from '../../src/poker/poker-engine.js'
import {
  POKER_RULE_SET_VERSION,
  POKER_RULE_SET_VERSION_V1,
} from '../../src/poker/poker-rule-set.js'
import { createPokerTableState } from '../../src/poker/state.js'
import { createPrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'
import {
  CHECKPOINT_SCHEMA_VERSION,
  HAND_START_CHECKPOINT_PAYLOAD_VERSION,
  decodeCurrentHandStartCheckpointV1,
  encodeHandStartCheckpointV1,
} from '../../src/sessions/hand-audit/hand-start-checkpoint-codec-v1.js'
import {
  CHECKPOINT_V2_SCHEMA_VERSION,
  decodeCurrentHandStartCheckpointV2,
  encodeHandStartCheckpointV2,
  HAND_START_CHECKPOINT_V2_PAYLOAD_VERSION,
} from '../../src/sessions/hand-audit/hand-start-checkpoint-codec-v2.js'
import {
  createHandStartCheckpointVersionRegistry,
  productionHandStartCheckpointVersionRegistry,
} from '../../src/sessions/hand-audit/hand-start-checkpoint-version-registry.js'
import {
  COMPLETED_HAND_RESULT_PAYLOAD_VERSION,
  HAND_RESULT_SCHEMA_VERSION,
  decodeCurrentCompletedHandResultV1,
  encodeCompletedHandResultV1,
} from '../../src/sessions/hand-audit/completed-hand-result-codec-v1.js'
import {
  createCompletedHandResultVersionRegistry,
  productionCompletedHandResultVersionRegistry,
} from '../../src/sessions/hand-audit/completed-hand-result-version-registry.js'
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
  test('keeps the V1 checkpoint codec frozen and readable', () => {
    const input = createCheckpointInput()

    const encoded = encodeHandStartCheckpointV1(input)

    expect({
      rowVersion: HAND_START_CHECKPOINT_PAYLOAD_VERSION,
      envelopeVersion: CHECKPOINT_SCHEMA_VERSION,
    }).toEqual({ rowVersion: 1, envelopeVersion: 1 })
    expect(encoded).toEqual({
      payloadVersion: 1,
      payload: {
        checkpointSchemaVersion: 1,
        checkpoint: input,
      },
    })
    expect(
      decodeCurrentHandStartCheckpointV1(structuredClone(encoded)),
    ).toEqual(encoded)
    expect(
      encoded.payload.checkpoint.startedHand.startingStacks[1]?.stack,
    ).toBe(1_500)
    expect(
      encoded.payload.checkpoint.stateBeforeStartCommand.poker.seats[1]?.stack,
    ).toBe(1_000)
    expect(Object.isFrozen(encoded)).toBe(true)
    expect(Object.isFrozen(encoded.payload.checkpoint.startedHand)).toBe(true)
    expect(
      Object.isFrozen(
        encoded.payload.checkpoint.stateBeforeStartCommand.poker.seats,
      ),
    ).toBe(true)
  })

  test('round-trips the current V2 checkpoint with its bound rule set', () => {
    const input = {
      pokerRuleSetVersion: POKER_RULE_SET_VERSION,
      ...createCheckpointInput(),
    }
    const encoded = encodeHandStartCheckpointV2(input)

    expect({
      rowVersion: HAND_START_CHECKPOINT_V2_PAYLOAD_VERSION,
      envelopeVersion: CHECKPOINT_V2_SCHEMA_VERSION,
    }).toEqual({ rowVersion: 2, envelopeVersion: 2 })
    expect(encoded).toEqual({
      payloadVersion: 2,
      payload: {
        checkpointSchemaVersion: 2,
        checkpoint: input,
      },
    })
    expect(
      decodeCurrentHandStartCheckpointV2(structuredClone(encoded)),
    ).toEqual(encoded)
    expect(Object.isFrozen(encoded)).toBe(true)
    expect(Object.isFrozen(encoded.payload.checkpoint)).toBe(true)
  })

  test('dispatches current V2 and deterministically migrates stored V1 without mutating storage', () => {
    const current = encodeHandStartCheckpointV2({
      pokerRuleSetVersion: POKER_RULE_SET_VERSION,
      ...createCheckpointInput(),
    })

    expect(
      productionHandStartCheckpointVersionRegistry.read(
        current.payloadVersion,
        current.payload,
      ),
    ).toEqual({
      kind: 'decoded',
      value: current.payload.checkpoint,
    })
    const legacy = encodeHandStartCheckpointV1(createCheckpointInput())
    const legacySnapshot = structuredClone(legacy)
    expect(
      productionHandStartCheckpointVersionRegistry.read(
        legacy.payloadVersion,
        legacy.payload,
      ),
    ).toEqual({
      kind: 'decoded',
      value: {
        pokerRuleSetVersion: POKER_RULE_SET_VERSION_V1,
        ...legacy.payload.checkpoint,
      },
    })
    expect(legacy).toEqual(legacySnapshot)
    expect(
      productionHandStartCheckpointVersionRegistry.read(99, {
        checkpointSchemaVersion: 99,
      }),
    ).toEqual({ kind: 'unknownVersion' })

    const legacyRegistry = createHandStartCheckpointVersionRegistry([
      {
        kind: 'legacy',
        identity: { rowPayloadVersion: 7, envelopeSchemaVersion: 3 },
        decode: () => ({ legacy: true }),
        migrate: () => ({
          pokerRuleSetVersion: POKER_RULE_SET_VERSION,
          ...createCheckpointInput(),
        }),
      },
    ])
    expect(
      legacyRegistry.read(7, { checkpointSchemaVersion: 3, legacy: true }),
    ).toEqual({
      kind: 'decoded',
      value: current.payload.checkpoint,
    })
  })

  test('rejects a checkpoint whose started hand contains a zero stack', () => {
    const input = createCheckpointInput()
    const invalid = {
      ...input,
      startedHand: {
        ...input.startedHand,
        startingStacks: input.startedHand.startingStacks.map((stack, index) =>
          index === 0 ? { ...stack, stack: 0 } : stack,
        ),
      },
    }

    expect(() => encodeHandStartCheckpointV1(invalid)).toThrow(
      '手牌审计载荷无效。',
    )
  })

  test('rejects a checkpoint whose button and logical positions do not mirror', () => {
    const input = createCheckpointInput()
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

    expect(() => encodeHandStartCheckpointV1(invalid)).toThrow(
      '手牌审计载荷无效。',
    )
  })

  test('round-trips a complete M1.9 hand result as an independently versioned deep-frozen value', () => {
    const result = createTestCompletedPokerResult().completedHand

    const encoded = encodeCompletedHandResultV1(result)

    expect({
      rowVersion: COMPLETED_HAND_RESULT_PAYLOAD_VERSION,
      envelopeVersion: HAND_RESULT_SCHEMA_VERSION,
    }).toEqual({ rowVersion: 1, envelopeVersion: 1 })
    expect(encoded).toEqual({
      payloadVersion: 1,
      payload: { handResultSchemaVersion: 1, result },
    })
    expect(
      decodeCurrentCompletedHandResultV1(structuredClone(encoded)),
    ).toEqual(encoded)
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

    expect(() => encodeCompletedHandResultV1(invalid)).toThrow(
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
      encodeCompletedHandResultV1({
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
      encodeCompletedHandResultV1({
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
      encodeCompletedHandResultV1({
        ...result,
        pots: duplicatedPots,
        summary: { ...result.summary, pots: duplicatedPots },
      }),
    ).toThrow('手牌审计载荷无效。')
  })

  test('rejects a result whose persisted card zones no longer form one exact standard deck', () => {
    const result = createTestCompletedPokerResult().completedHand

    expect(() =>
      encodeCompletedHandResultV1({
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
      encodeCompletedHandResultV1({
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

  test('dispatches current and explicitly injected legacy completed-result versions', () => {
    const current = encodeCompletedHandResultV1(
      createTestCompletedPokerResult().completedHand,
    )

    expect(
      productionCompletedHandResultVersionRegistry.read(
        current.payloadVersion,
        current.payload,
      ),
    ).toEqual({ kind: 'decoded', value: current.payload.result })
    expect(
      productionCompletedHandResultVersionRegistry.read(2, {
        handResultSchemaVersion: 2,
      }),
    ).toEqual({ kind: 'unknownVersion' })

    expect(
      productionCompletedHandResultVersionRegistry.read(1, {
        resultSchemaVersion: 1,
        result: current.payload.result,
      }),
    ).toEqual({ kind: 'invalidPayload' })

    const legacy = createCompletedHandResultVersionRegistry([
      {
        kind: 'legacy',
        identity: { rowPayloadVersion: 3, envelopeSchemaVersion: 4 },
        decode: () => ({ legacy: true }),
        migrate: () => createTestCompletedPokerResult().completedHand,
      },
    ])
    expect(
      legacy.read(3, { handResultSchemaVersion: 4, legacy: true }),
    ).toEqual({
      kind: 'decoded',
      value: current.payload.result,
    })
  })

  test('classifies a registered current version with a damaged payload separately from an unknown version', () => {
    expect(
      productionHandStartCheckpointVersionRegistry.read(1, {
        checkpointSchemaVersion: 1,
        checkpoint: {},
      }),
    ).toEqual({ kind: 'invalidPayload' })
    expect(
      productionCompletedHandResultVersionRegistry.read(1, {
        handResultSchemaVersion: 1,
        result: {},
      }),
    ).toEqual({ kind: 'invalidPayload' })
  })
})
