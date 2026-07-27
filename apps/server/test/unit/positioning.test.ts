import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import {
  assignLogicalPositions,
  clockwiseParticipantSeatNumbersAfter,
  findNextActionableSeatNumber,
  findPostflopFirstActionableSeatNumber,
  findPreflopFirstActionableSeatNumber,
  getBlindSeatNumbers,
  resolveButtonSeatNumberForHand,
  selectInitialButtonSeatNumber,
} from '../../src/poker/positioning.js'

describe('selectInitialButtonSeatNumber', () => {
  test('selects from normalized occupied seats with one bounded random draw', () => {
    const requestedBounds: number[] = []
    const occupiedSeatNumbers = [8, 0, 5, 2, 7, 3]
    const occupiedBefore = [...occupiedSeatNumbers]

    const buttonSeatNumber = selectInitialButtonSeatNumber(
      occupiedSeatNumbers,
      {
        nextInt(maxExclusive) {
          requestedBounds.push(maxExclusive)
          return 2
        },
      },
    )

    expect(buttonSeatNumber).toBe(3)
    expect(requestedBounds).toEqual([6])
    expect(occupiedSeatNumbers).toEqual(occupiedBefore)
  })

  test.each([
    { seats: [0, 1, 2, 3, 4, 5] },
    { seats: [0, 1, 2, 3, 4, 5, 6] },
    { seats: [0, 1, 2, 3, 4, 5, 6, 7] },
    { seats: [0, 1, 2, 3, 4, 5, 6, 7, 8] },
  ])(
    'is independent of the input order for $seats.length occupied seats',
    ({ seats }) => {
      const random = { nextInt: () => 3 }

      expect(selectInitialButtonSeatNumber(seats, random)).toBe(
        selectInitialButtonSeatNumber([...seats].reverse(), random),
      )
    },
  )

  test('rejects invalid occupied sets and random source results', () => {
    const validSeats = [0, 1, 2, 3, 4, 5]

    for (const invalidSeats of [
      [],
      [0, 1, 2, 3, 4],
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 8],
      [0, 1, 2, 3, 4, 4],
      [0, 1, 2, 3, 4, 9],
    ]) {
      expect(() =>
        selectInitialButtonSeatNumber(invalidSeats, { nextInt: () => 0 }),
      ).toThrow()
    }

    for (const invalidIndex of [-1, 1.5, Number.NaN, validSeats.length]) {
      expect(() =>
        selectInitialButtonSeatNumber(validSeats, {
          nextInt: () => invalidIndex,
        }),
      ).toThrow('随机源返回了超出范围的索引。')
    }
  })
})

describe('clockwiseParticipantSeatNumbersAfter', () => {
  test('normalizes sparse seats into one button-relative physical order', () => {
    expect(clockwiseParticipantSeatNumbersAfter(8, [3, 8, 0, 6, 1, 5])).toEqual(
      [0, 1, 3, 5, 6, 8],
    )
  })
})

describe('resolveButtonSeatNumberForHand', () => {
  test('keeps the persisted button for the first hand and rotates once thereafter', () => {
    const participantSeatNumbers = [0, 1, 3, 5, 6, 8]

    expect(
      resolveButtonSeatNumberForHand({
        currentButtonSeatNumber: 8,
        participantSeatNumbers,
        completedHandCountBeforeStart: 0,
      }),
    ).toBe(8)
    expect(
      resolveButtonSeatNumberForHand({
        currentButtonSeatNumber: 8,
        participantSeatNumbers,
        completedHandCountBeforeStart: 1,
      }),
    ).toBe(0)
    expect(
      resolveButtonSeatNumberForHand({
        currentButtonSeatNumber: 8,
        participantSeatNumbers,
        completedHandCountBeforeStart: 500,
      }),
    ).toBe(0)
  })

  test('rejects a non-authoritative count shape or a button outside participants', () => {
    for (const completedHandCountBeforeStart of [-1, 1.5, Number.NaN]) {
      expect(() =>
        resolveButtonSeatNumberForHand({
          currentButtonSeatNumber: 0,
          participantSeatNumbers: [0, 1, 2, 3, 4, 5],
          completedHandCountBeforeStart,
        }),
      ).toThrow('开手前已完成手数必须是非负整数。')
    }

    expect(() =>
      resolveButtonSeatNumberForHand({
        currentButtonSeatNumber: 8,
        participantSeatNumbers: [0, 1, 2, 3, 4, 5],
        completedHandCountBeforeStart: 0,
      }),
    ).toThrow('锚点座位必须属于本手参与座位。')
  })
})

describe('blind seats and logical positions', () => {
  test.each([
    {
      playerCount: 6,
      buttonSeatNumber: 8,
      participantSeatNumbers: [3, 8, 0, 6, 1, 5],
      expectedBlinds: {
        smallBlindSeatNumber: 0,
        bigBlindSeatNumber: 1,
      },
      expectedPositions: [
        [3, 'UTG'],
        [5, 'HJ'],
        [6, 'CO'],
        [8, 'BTN'],
        [0, 'SB'],
        [1, 'BB'],
      ],
    },
    {
      playerCount: 7,
      buttonSeatNumber: 5,
      participantSeatNumbers: [7, 2, 0, 5, 8, 3, 6],
      expectedBlinds: {
        smallBlindSeatNumber: 6,
        bigBlindSeatNumber: 7,
      },
      expectedPositions: [
        [8, 'UTG'],
        [0, 'LJ'],
        [2, 'HJ'],
        [3, 'CO'],
        [5, 'BTN'],
        [6, 'SB'],
        [7, 'BB'],
      ],
    },
    {
      playerCount: 8,
      buttonSeatNumber: 7,
      participantSeatNumbers: [8, 5, 0, 7, 1, 2, 3, 6],
      expectedBlinds: {
        smallBlindSeatNumber: 8,
        bigBlindSeatNumber: 0,
      },
      expectedPositions: [
        [1, 'UTG'],
        [2, 'MP'],
        [3, 'LJ'],
        [5, 'HJ'],
        [6, 'CO'],
        [7, 'BTN'],
        [8, 'SB'],
        [0, 'BB'],
      ],
    },
    {
      playerCount: 9,
      buttonSeatNumber: 6,
      participantSeatNumbers: [4, 8, 1, 6, 0, 7, 2, 5, 3],
      expectedBlinds: {
        smallBlindSeatNumber: 7,
        bigBlindSeatNumber: 8,
      },
      expectedPositions: [
        [0, 'UTG'],
        [1, 'UTG+1'],
        [2, 'MP'],
        [3, 'LJ'],
        [4, 'HJ'],
        [5, 'CO'],
        [6, 'BTN'],
        [7, 'SB'],
        [8, 'BB'],
      ],
    },
  ])(
    'maps a sparse $playerCount-player table from one topology',
    ({
      buttonSeatNumber,
      participantSeatNumbers,
      expectedBlinds,
      expectedPositions,
    }) => {
      expect(
        getBlindSeatNumbers(buttonSeatNumber, participantSeatNumbers),
      ).toEqual(expectedBlinds)
      expect(
        assignLogicalPositions(buttonSeatNumber, participantSeatNumbers).map(
          ({ seatNumber, position }) => [seatNumber, position],
        ),
      ).toEqual(expectedPositions)
    },
  )

  test('keeps every topology result inside the participant set', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 0, max: 8 }), {
          minLength: 6,
          maxLength: 9,
        }),
        fc.integer({ min: 0, max: 100 }),
        (participantSeatNumbers, selector) => {
          const buttonSeatNumber =
            participantSeatNumbers[selector % participantSeatNumbers.length]!
          const participantSet = new Set(participantSeatNumbers)
          const clockwise = clockwiseParticipantSeatNumbersAfter(
            buttonSeatNumber,
            participantSeatNumbers,
          )
          const blinds = getBlindSeatNumbers(
            buttonSeatNumber,
            participantSeatNumbers,
          )
          const positions = assignLogicalPositions(
            buttonSeatNumber,
            participantSeatNumbers,
          )

          expect(new Set(clockwise)).toEqual(participantSet)
          expect(clockwise.at(-1)).toBe(buttonSeatNumber)
          expect(participantSet.has(blinds.smallBlindSeatNumber)).toBe(true)
          expect(participantSet.has(blinds.bigBlindSeatNumber)).toBe(true)
          expect(
            new Set(positions.map((position) => position.seatNumber)),
          ).toEqual(participantSet)
          expect(
            new Set(positions.map((position) => position.position)),
          ).toHaveLength(participantSeatNumbers.length)
        },
      ),
      { numRuns: 100 },
    )
  })
})

describe('actionable seat order', () => {
  const participantSeatNumbers = [0, 1, 3, 5, 6, 8]
  const seats = [
    { seatNumber: 0, status: 'active' as const, stack: 100 },
    { seatNumber: 1, status: 'active' as const, stack: 100 },
    { seatNumber: 3, status: 'folded' as const, stack: 100 },
    { seatNumber: 5, status: 'allIn' as const, stack: 0 },
    { seatNumber: 6, status: 'out' as const, stack: 100 },
    { seatNumber: 8, status: 'active' as const, stack: 0 },
  ]

  test('skips only non-actionable seats from the supplied anchor', () => {
    expect(
      findNextActionableSeatNumber({
        anchorSeatNumber: 1,
        participantSeatNumbers,
        seats,
      }),
    ).toBe(0)
  })

  test('derives preflop and postflop starting anchors from the shared topology', () => {
    const seatsWithDistinctStartingActors = seats.map((seat) =>
      seat.seatNumber === 3
        ? { ...seat, status: 'active' as const, stack: 100 }
        : seat,
    )

    expect(
      findPreflopFirstActionableSeatNumber({
        buttonSeatNumber: 8,
        participantSeatNumbers,
        seats: seatsWithDistinctStartingActors,
      }),
    ).toBe(3)
    expect(
      findPostflopFirstActionableSeatNumber({
        buttonSeatNumber: 8,
        participantSeatNumbers,
        seats: seatsWithDistinctStartingActors,
      }),
    ).toBe(0)
  })

  test('returns null instead of wrapping back to the anchor', () => {
    const onlyAnchorCanAct = seats.map((seat) => ({
      ...seat,
      status: seat.seatNumber === 1 ? ('active' as const) : ('allIn' as const),
      stack: seat.seatNumber === 1 ? 100 : 0,
    }))

    expect(
      findNextActionableSeatNumber({
        anchorSeatNumber: 1,
        participantSeatNumbers,
        seats: onlyAnchorCanAct,
      }),
    ).toBeNull()
  })

  test('rejects missing, duplicate, and invalid current seat records', () => {
    expect(() =>
      findNextActionableSeatNumber({
        anchorSeatNumber: 1,
        participantSeatNumbers,
        seats: seats.slice(0, 5),
      }),
    ).toThrow('当前座位记录必须与本手参与座位一一对应。')
    expect(() =>
      findNextActionableSeatNumber({
        anchorSeatNumber: 1,
        participantSeatNumbers,
        seats: [...seats.slice(0, 5), seats[0]!],
      }),
    ).toThrow('当前座位记录必须与本手参与座位一一对应。')
    expect(() =>
      findNextActionableSeatNumber({
        anchorSeatNumber: 1,
        participantSeatNumbers,
        seats: seats.map((seat, index) =>
          index === 0 ? { ...seat, stack: -1 } : seat,
        ),
      }),
    ).toThrow('当前座位筹码必须是非负整数。')
  })

  test('always returns another active positive-stack participant', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 0, max: 8 }), {
          minLength: 6,
          maxLength: 9,
        }),
        fc.integer({ min: 0, max: 100 }),
        (generatedSeats, selector) => {
          const participantSeatNumbers = [...generatedSeats]
          const anchorSeatNumber =
            participantSeatNumbers[selector % participantSeatNumbers.length]!
          const currentSeats = participantSeatNumbers.map(
            (seatNumber, index) => ({
              seatNumber,
              status:
                index % 4 === 0
                  ? ('folded' as const)
                  : index % 4 === 1
                    ? ('allIn' as const)
                    : index % 4 === 2
                      ? ('out' as const)
                      : ('active' as const),
              stack: index % 5 === 0 ? 0 : index + 1,
            }),
          )
          const result = findNextActionableSeatNumber({
            anchorSeatNumber,
            participantSeatNumbers,
            seats: currentSeats,
          })

          if (result !== null) {
            const resultSeat = currentSeats.find(
              (seat) => seat.seatNumber === result,
            )
            expect(result).not.toBe(anchorSeatNumber)
            expect(resultSeat).toMatchObject({
              status: 'active',
            })
            expect(resultSeat?.stack).toBeGreaterThan(0)
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  test('does not mutate participant or current seat inputs', () => {
    const participantBefore = [...participantSeatNumbers]
    const seatsBefore = structuredClone(seats)

    clockwiseParticipantSeatNumbersAfter(8, participantSeatNumbers)
    getBlindSeatNumbers(8, participantSeatNumbers)
    assignLogicalPositions(8, participantSeatNumbers)
    findNextActionableSeatNumber({
      anchorSeatNumber: 1,
      participantSeatNumbers,
      seats,
    })

    expect(participantSeatNumbers).toEqual(participantBefore)
    expect(seats).toEqual(seatsBefore)
  })
})
