import { z } from 'zod'
import {
  createStartedHandFacts,
  type StartedHandFacts,
} from '../../poker/hand-result.js'
import {
  POKER_RULE_SET_VERSION_V1,
  type PokerRuleSetVersion,
} from '../../poker/poker-rule-set.js'
import {
  createPrivateTableState,
  type PrivateTableState,
} from '../authoritative-state/private-table-state.js'
import { HandAuditPayloadValidationError } from './errors.js'

const SafePositiveIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
const SafeNonnegativeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
const SeatNumberSchema = z.number().int().min(0).max(8)
const StartedHandFactsSchema = z.strictObject({
  handId: z.uuid(),
  handNumber: SafePositiveIntegerSchema,
  participantSeatNumbers: z.array(SeatNumberSchema).min(6).max(9),
  buttonSeatNumber: SeatNumberSchema,
  smallBlindSeatNumber: SeatNumberSchema,
  bigBlindSeatNumber: SeatNumberSchema,
  positions: z.array(
    z.strictObject({
      seatNumber: SeatNumberSchema,
      position: z.enum([
        'UTG',
        'UTG+1',
        'MP',
        'LJ',
        'HJ',
        'CO',
        'BTN',
        'SB',
        'BB',
      ]),
    }),
  ),
  startingStacks: z.array(
    z.strictObject({
      seatNumber: SeatNumberSchema,
      stack: SafeNonnegativeIntegerSchema.positive(),
    }),
  ),
})
const HandStartCheckpointInputSchema = z.strictObject({
  stateBeforeStartCommand: z.unknown(),
  startedHand: StartedHandFactsSchema,
})
const HandStartCheckpointV2InputSchema = z.strictObject({
  pokerRuleSetVersion: z.literal(POKER_RULE_SET_VERSION_V1),
  stateBeforeStartCommand: z.unknown(),
  startedHand: StartedHandFactsSchema,
})

export interface HandStartCheckpointV1 {
  readonly stateBeforeStartCommand: PrivateTableState
  readonly startedHand: StartedHandFacts
}

export interface HandStartCheckpointV2 extends HandStartCheckpointV1 {
  readonly pokerRuleSetVersion: PokerRuleSetVersion
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const nestedValue of Object.values(value)) {
      deepFreeze(nestedValue)
    }
    Object.freeze(value)
  }
  return value
}

export function createHandStartCheckpointV1(
  input: unknown,
): HandStartCheckpointV1 {
  try {
    const parsed = HandStartCheckpointInputSchema.parse(input)
    const stateBeforeStartCommand = createPrivateTableState(
      parsed.stateBeforeStartCommand,
    )
    const startedHand = createStartedHandFacts(parsed.startedHand)
    const checkpointSeatNumbers = stateBeforeStartCommand.poker.seats.map(
      (seat) => seat.seatNumber,
    )
    const positionBySeat = new Map(
      startedHand.positions.map((position) => [
        position.seatNumber,
        position.position,
      ]),
    )
    if (
      stateBeforeStartCommand.poker.pokerPhase !== 'betweenHands' ||
      stateBeforeStartCommand.poker.hand !== null ||
      startedHand.handNumber !==
        stateBeforeStartCommand.completedHandCount + 1 ||
      checkpointSeatNumbers.length !==
        startedHand.participantSeatNumbers.length ||
      checkpointSeatNumbers.some(
        (seatNumber) =>
          !startedHand.participantSeatNumbers.includes(seatNumber),
      ) ||
      new Set(startedHand.positions.map((position) => position.position))
        .size !== startedHand.positions.length ||
      positionBySeat.get(startedHand.buttonSeatNumber) !== 'BTN' ||
      positionBySeat.get(startedHand.smallBlindSeatNumber) !== 'SB' ||
      positionBySeat.get(startedHand.bigBlindSeatNumber) !== 'BB'
    ) {
      throw new Error('Hand-start checkpoint mirrors do not match.')
    }
    return deepFreeze({ stateBeforeStartCommand, startedHand })
  } catch (error) {
    if (error instanceof HandAuditPayloadValidationError) throw error
    throw new HandAuditPayloadValidationError()
  }
}

export function createHandStartCheckpointV2(
  input: unknown,
): HandStartCheckpointV2 {
  try {
    const parsed = HandStartCheckpointV2InputSchema.parse(input)
    const checkpointV1 = createHandStartCheckpointV1({
      stateBeforeStartCommand: parsed.stateBeforeStartCommand,
      startedHand: parsed.startedHand,
    })
    return deepFreeze({
      pokerRuleSetVersion: POKER_RULE_SET_VERSION_V1,
      ...checkpointV1,
    })
  } catch (error) {
    if (error instanceof HandAuditPayloadValidationError) throw error
    throw new HandAuditPayloadValidationError()
  }
}
