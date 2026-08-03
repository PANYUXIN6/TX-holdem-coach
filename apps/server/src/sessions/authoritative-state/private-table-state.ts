import { z } from 'zod'
import {
  CompletedHandSummarySchema,
  type CompletedHandSummary,
} from '../../poker/hand-result.js'
import {
  createPokerTableState,
  type PokerTableState,
} from '../../poker/state.js'
import { AuthoritativeStateValidationError } from './errors.js'

const SafeNonnegativeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)

const SeatAccountingSchema = z.strictObject({
  seatNumber: z.number().int().min(0).max(8),
  cumulativeBuyIn: SafeNonnegativeIntegerSchema,
})

const PrivateTableStateInputSchema = z.strictObject({
  stateVersion: SafeNonnegativeIntegerSchema,
  poker: z.unknown(),
  completedHandCount: SafeNonnegativeIntegerSchema,
  seatAccounting: z.array(SeatAccountingSchema),
  lastCompletedHandSummary: z.unknown().nullable(),
})

export interface SeatAccounting {
  readonly seatNumber: number
  readonly cumulativeBuyIn: number
}

export interface PrivateTableState {
  readonly stateVersion: number
  readonly poker: PokerTableState
  readonly completedHandCount: number
  readonly seatAccounting: readonly SeatAccounting[]
  readonly lastCompletedHandSummary: CompletedHandSummary | null
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

export function createPrivateTableState(input: unknown): PrivateTableState {
  try {
    const parsed = PrivateTableStateInputSchema.parse(input)
    const poker = createPokerTableState(parsed.poker)
    const pokerSeatNumbers = new Set(poker.seats.map((seat) => seat.seatNumber))
    const accountingSeatNumbers = new Set(
      parsed.seatAccounting.map((seat) => seat.seatNumber),
    )
    if (
      accountingSeatNumbers.size !== parsed.seatAccounting.length ||
      accountingSeatNumbers.size !== pokerSeatNumbers.size ||
      [...accountingSeatNumbers].some(
        (seatNumber) => !pokerSeatNumbers.has(seatNumber),
      )
    ) {
      throw new Error('Accounting seats do not match the roster.')
    }
    const totalBuyIn = parsed.seatAccounting.reduce(
      (total, accounting) => total + BigInt(accounting.cumulativeBuyIn),
      0n,
    )
    const totalStacksAndPot = poker.seats.reduce(
      (total, seat) => {
        if (!Number.isSafeInteger(seat.stack)) {
          throw new Error('Stack is not a safe integer.')
        }
        return total + BigInt(seat.stack)
      },
      BigInt(poker.hand?.pot ?? 0),
    )
    const maximumSafeInteger = BigInt(Number.MAX_SAFE_INTEGER)
    if (
      totalBuyIn !== totalStacksAndPot ||
      totalBuyIn > maximumSafeInteger ||
      totalStacksAndPot > maximumSafeInteger
    ) {
      throw new Error('Accounting does not conserve chips.')
    }
    if (
      (parsed.completedHandCount === 0) !==
      (parsed.lastCompletedHandSummary === null)
    ) {
      throw new Error('Completed-hand summary presence is inconsistent.')
    }
    const lastCompletedHandSummary =
      parsed.lastCompletedHandSummary === null
        ? null
        : CompletedHandSummarySchema.parse(parsed.lastCompletedHandSummary)
    if (lastCompletedHandSummary !== null) {
      const rosterBySeat = new Map(
        poker.seats.map((seat) => [seat.seatNumber, seat]),
      )
      if (
        lastCompletedHandSummary.seats.some((summarySeat) => {
          const rosterSeat = rosterBySeat.get(summarySeat.seatNumber)
          return (
            rosterSeat === undefined ||
            rosterSeat.playerId !== summarySeat.playerId ||
            rosterSeat.isUser !== summarySeat.isUser
          )
        })
      ) {
        throw new Error('Completed-hand summary does not match the roster.')
      }
    }
    return deepFreeze({
      stateVersion: parsed.stateVersion,
      poker,
      completedHandCount: parsed.completedHandCount,
      seatAccounting: [...parsed.seatAccounting].sort(
        (left, right) => left.seatNumber - right.seatNumber,
      ),
      lastCompletedHandSummary,
    })
  } catch {
    throw new AuthoritativeStateValidationError()
  }
}
