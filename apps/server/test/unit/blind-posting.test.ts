import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { postBlinds } from '../../src/poker/blind-posting.js'
import { createTestPokerState } from '../poker/create-test-poker-state.js'

describe('postBlinds', () => {
  test('posts fixed blinds into a new seat array', () => {
    const state = createTestPokerState()
    const seatsBefore = structuredClone(state.seats)

    const result = postBlinds({
      seats: state.seats,
      buttonSeatNumber: 0,
      participantSeatNumbers: [5, 2, 0, 4, 1, 3],
    })

    expect(result).toMatchObject({
      smallBlind: { seatNumber: 1, actualAmount: 10 },
      bigBlind: { seatNumber: 2, actualAmount: 20 },
      potDelta: 30,
      preflopCurrentBet: 20,
      minimumFullRaiseIncrement: 20,
    })
    expect(result.seats.find((seat) => seat.seatNumber === 1)).toMatchObject({
      stack: 1990,
      status: 'active',
      streetContribution: 10,
      totalContribution: 10,
    })
    expect(result.seats.find((seat) => seat.seatNumber === 2)).toMatchObject({
      stack: 1980,
      status: 'active',
      streetContribution: 20,
      totalContribution: 20,
    })
    expect(result.seats).not.toBe(state.seats)
    for (const [index, seat] of result.seats.entries()) {
      expect(seat).not.toBe(state.seats[index])
    }
    expect(state.seats).toEqual(seatsBefore)
  })

  test('posts only remaining short stacks while preserving nominal preflop baselines', () => {
    const state = createTestPokerState()
    const seats = state.seats.map((seat) => {
      if (seat.seatNumber === 1) {
        return { ...seat, stack: 7 }
      }

      if (seat.seatNumber === 2) {
        return { ...seat, stack: 13 }
      }

      return { ...seat }
    })

    const result = postBlinds({
      seats,
      buttonSeatNumber: 0,
      participantSeatNumbers: [0, 1, 2, 3, 4, 5],
    })

    expect(result).toMatchObject({
      smallBlind: { seatNumber: 1, actualAmount: 7 },
      bigBlind: { seatNumber: 2, actualAmount: 13 },
      potDelta: 20,
      preflopCurrentBet: 20,
      minimumFullRaiseIncrement: 20,
    })
    expect(result.seats.find((seat) => seat.seatNumber === 1)).toMatchObject({
      stack: 0,
      status: 'allIn',
      streetContribution: 7,
      totalContribution: 7,
    })
    expect(result.seats.find((seat) => seat.seatNumber === 2)).toMatchObject({
      stack: 0,
      status: 'allIn',
      streetContribution: 13,
      totalContribution: 13,
    })
  })

  test('rejects repeated blinds, prior contributions, and an invalid button', () => {
    const state = createTestPokerState()
    const input = {
      seats: state.seats,
      buttonSeatNumber: 0,
      participantSeatNumbers: [0, 1, 2, 3, 4, 5],
    } as const
    const posted = postBlinds(input)

    expect(() => postBlinds({ ...input, seats: posted.seats })).toThrow(
      '下盲前所有本手投入必须为零。',
    )
    expect(() =>
      postBlinds({
        ...input,
        seats: state.seats.map((seat) =>
          seat.seatNumber === 5 ? { ...seat, totalContribution: 1 } : seat,
        ),
      }),
    ).toThrow('下盲前所有本手投入必须为零。')
    expect(() => postBlinds({ ...input, buttonSeatNumber: 8 })).toThrow(
      '锚点座位必须属于本手参与座位。',
    )
  })

  test('rejects non-active, empty-stack, and non-corresponding starting seats', () => {
    const state = createTestPokerState()
    const input = {
      buttonSeatNumber: 0,
      participantSeatNumbers: [0, 1, 2, 3, 4, 5],
    } as const

    expect(() =>
      postBlinds({
        ...input,
        seats: state.seats.map((seat) =>
          seat.seatNumber === 3 ? { ...seat, status: 'folded' as const } : seat,
        ),
      }),
    ).toThrow('本手参与座位必须以正整数筹码和 active 状态下盲。')
    expect(() =>
      postBlinds({
        ...input,
        seats: state.seats.map((seat) =>
          seat.seatNumber === 3 ? { ...seat, stack: 0 } : seat,
        ),
      }),
    ).toThrow('本手参与座位必须以正整数筹码和 active 状态下盲。')
    expect(() =>
      postBlinds({
        ...input,
        seats: [...state.seats.slice(0, 5), state.seats[0]!],
      }),
    ).toThrow('下盲座位必须与本手参与座位一一对应。')
  })

  test('conserves the exact blind pot delta for arbitrary short stacks', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        fc.integer({ min: 1, max: 50 }),
        (smallBlindStack, bigBlindStack) => {
          const state = createTestPokerState()
          const seats = state.seats.map((seat) => {
            if (seat.seatNumber === 1) {
              return { ...seat, stack: smallBlindStack }
            }

            if (seat.seatNumber === 2) {
              return { ...seat, stack: bigBlindStack }
            }

            return { ...seat }
          })
          const totalBefore = seats.reduce(
            (total, seat) => total + seat.stack,
            0,
          )
          const result = postBlinds({
            seats,
            buttonSeatNumber: 0,
            participantSeatNumbers: [0, 1, 2, 3, 4, 5],
          })
          const totalAfter = result.seats.reduce(
            (total, seat) => total + seat.stack,
            0,
          )

          expect(totalBefore - totalAfter).toBe(result.potDelta)
          expect(result.smallBlind.actualAmount).toBe(
            Math.min(smallBlindStack, 10),
          )
          expect(result.bigBlind.actualAmount).toBe(Math.min(bigBlindStack, 20))
        },
      ),
      { numRuns: 100 },
    )
  })
})
