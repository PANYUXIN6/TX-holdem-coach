import type { RandomSource } from './random-source.js'

function normalizeSeatNumbers(
  seatNumbers: readonly number[],
  label: string,
): number[] {
  if (
    !Array.isArray(seatNumbers) ||
    seatNumbers.length < 6 ||
    seatNumbers.length > 9
  ) {
    throw new RangeError(`${label}必须为 6 到 9 个座位。`)
  }

  const normalizedSeatNumbers = [...seatNumbers].sort(
    (left, right) => left - right,
  )

  for (const [index, seatNumber] of normalizedSeatNumbers.entries()) {
    if (!Number.isInteger(seatNumber) || seatNumber < 0 || seatNumber > 8) {
      throw new RangeError(`${label}必须只包含 0 到 8 的整数。`)
    }

    if (seatNumber === normalizedSeatNumbers[index - 1]) {
      throw new RangeError(`${label}不得重复。`)
    }
  }

  return normalizedSeatNumbers
}

function assertSeatNumber(
  seatNumber: number,
  label: string,
): asserts seatNumber is number {
  if (!Number.isInteger(seatNumber) || seatNumber < 0 || seatNumber > 8) {
    throw new RangeError(`${label}必须是 0 到 8 的整数。`)
  }
}

export function clockwiseParticipantSeatNumbersAfter(
  anchorSeatNumber: number,
  participantSeatNumbers: readonly number[],
): readonly number[] {
  assertSeatNumber(anchorSeatNumber, '锚点座位')
  const normalizedSeatNumbers = normalizeSeatNumbers(
    participantSeatNumbers,
    '本手参与座位',
  )
  const participantSet = new Set(normalizedSeatNumbers)

  if (!participantSet.has(anchorSeatNumber)) {
    throw new RangeError('锚点座位必须属于本手参与座位。')
  }

  const clockwiseSeatNumbers: number[] = []
  for (let offset = 1; offset <= 9; offset += 1) {
    const seatNumber = (anchorSeatNumber + offset) % 9
    if (participantSet.has(seatNumber)) {
      clockwiseSeatNumbers.push(seatNumber)
    }
  }

  return clockwiseSeatNumbers
}

export interface ResolveButtonSeatNumberForHandInput {
  readonly currentButtonSeatNumber: number
  readonly participantSeatNumbers: readonly number[]
  readonly completedHandCountBeforeStart: number
}

export function resolveButtonSeatNumberForHand(
  input: ResolveButtonSeatNumberForHandInput,
): number {
  if (
    !Number.isInteger(input.completedHandCountBeforeStart) ||
    input.completedHandCountBeforeStart < 0
  ) {
    throw new RangeError('开手前已完成手数必须是非负整数。')
  }

  const clockwiseSeatNumbers = clockwiseParticipantSeatNumbersAfter(
    input.currentButtonSeatNumber,
    input.participantSeatNumbers,
  )

  return input.completedHandCountBeforeStart === 0
    ? input.currentButtonSeatNumber
    : (clockwiseSeatNumbers[0] as number)
}

export interface BlindSeatNumbers {
  readonly smallBlindSeatNumber: number
  readonly bigBlindSeatNumber: number
}

export function getBlindSeatNumbers(
  buttonSeatNumber: number,
  participantSeatNumbers: readonly number[],
): BlindSeatNumbers {
  const clockwiseSeatNumbers = clockwiseParticipantSeatNumbersAfter(
    buttonSeatNumber,
    participantSeatNumbers,
  )

  return {
    smallBlindSeatNumber: clockwiseSeatNumbers[0] as number,
    bigBlindSeatNumber: clockwiseSeatNumbers[1] as number,
  }
}

export type LogicalPosition =
  'UTG' | 'UTG+1' | 'MP' | 'LJ' | 'HJ' | 'CO' | 'BTN' | 'SB' | 'BB'

export interface LogicalPositionAssignment {
  readonly seatNumber: number
  readonly position: LogicalPosition
}

const POSITION_NAMES_BY_PLAYER_COUNT: Readonly<
  Record<number, readonly LogicalPosition[] | undefined>
> = Object.freeze({
  6: ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
  7: ['UTG', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
  8: ['UTG', 'MP', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
  9: ['UTG', 'UTG+1', 'MP', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
})

export function assignLogicalPositions(
  buttonSeatNumber: number,
  participantSeatNumbers: readonly number[],
): readonly LogicalPositionAssignment[] {
  const clockwiseSeatNumbers = clockwiseParticipantSeatNumbersAfter(
    buttonSeatNumber,
    participantSeatNumbers,
  )
  const preflopSeatNumbers = [
    ...clockwiseSeatNumbers.slice(2),
    ...clockwiseSeatNumbers.slice(0, 2),
  ]
  const positionNames =
    POSITION_NAMES_BY_PLAYER_COUNT[preflopSeatNumbers.length]

  if (positionNames === undefined) {
    throw new RangeError('本手参与座位必须为 6 到 9 个。')
  }

  return preflopSeatNumbers.map((seatNumber, index) => ({
    seatNumber,
    position: positionNames[index] as LogicalPosition,
  }))
}

export type ActionOrderSeatStatus = 'active' | 'folded' | 'allIn' | 'out'

export interface ActionOrderSeat {
  readonly seatNumber: number
  readonly status: ActionOrderSeatStatus
  readonly stack: number
}

export interface FindNextActionableSeatNumberInput {
  readonly anchorSeatNumber: number
  readonly participantSeatNumbers: readonly number[]
  readonly seats: readonly ActionOrderSeat[]
}

function indexActionOrderSeats(
  participantSeatNumbers: readonly number[],
  seats: readonly ActionOrderSeat[],
): ReadonlyMap<number, ActionOrderSeat> {
  if (!Array.isArray(seats) || seats.length !== participantSeatNumbers.length) {
    throw new RangeError('当前座位记录必须与本手参与座位一一对应。')
  }

  const participantSet = new Set(participantSeatNumbers)
  const seatByNumber = new Map<number, ActionOrderSeat>()
  const validStatuses = new Set<ActionOrderSeatStatus>([
    'active',
    'folded',
    'allIn',
    'out',
  ])

  for (const seat of seats) {
    if (seat === null || typeof seat !== 'object' || Array.isArray(seat)) {
      throw new TypeError('当前座位记录必须是对象。')
    }

    assertSeatNumber(seat.seatNumber, '当前座位')

    if (
      !participantSet.has(seat.seatNumber) ||
      seatByNumber.has(seat.seatNumber)
    ) {
      throw new RangeError('当前座位记录必须与本手参与座位一一对应。')
    }

    if (!validStatuses.has(seat.status)) {
      throw new RangeError('当前座位状态无效。')
    }

    if (!Number.isInteger(seat.stack) || seat.stack < 0) {
      throw new RangeError('当前座位筹码必须是非负整数。')
    }

    seatByNumber.set(seat.seatNumber, seat)
  }

  return seatByNumber
}

export function findNextActionableSeatNumber(
  input: FindNextActionableSeatNumberInput,
): number | null {
  const clockwiseSeatNumbers = clockwiseParticipantSeatNumbersAfter(
    input.anchorSeatNumber,
    input.participantSeatNumbers,
  )
  const seatByNumber = indexActionOrderSeats(clockwiseSeatNumbers, input.seats)

  for (const seatNumber of clockwiseSeatNumbers) {
    if (seatNumber === input.anchorSeatNumber) {
      continue
    }

    const seat = seatByNumber.get(seatNumber)
    if (seat?.status === 'active' && seat.stack > 0) {
      return seatNumber
    }
  }

  return null
}

export interface FindStreetFirstActionableSeatNumberInput {
  readonly buttonSeatNumber: number
  readonly participantSeatNumbers: readonly number[]
  readonly seats: readonly ActionOrderSeat[]
}

export function findPreflopFirstActionableSeatNumber(
  input: FindStreetFirstActionableSeatNumberInput,
): number | null {
  const { bigBlindSeatNumber } = getBlindSeatNumbers(
    input.buttonSeatNumber,
    input.participantSeatNumbers,
  )

  return findNextActionableSeatNumber({
    anchorSeatNumber: bigBlindSeatNumber,
    participantSeatNumbers: input.participantSeatNumbers,
    seats: input.seats,
  })
}

export function findPostflopFirstActionableSeatNumber(
  input: FindStreetFirstActionableSeatNumberInput,
): number | null {
  return findNextActionableSeatNumber({
    anchorSeatNumber: input.buttonSeatNumber,
    participantSeatNumbers: input.participantSeatNumbers,
    seats: input.seats,
  })
}

export function selectInitialButtonSeatNumber(
  occupiedSeatNumbers: readonly number[],
  random: RandomSource,
): number {
  const normalizedSeatNumbers = normalizeSeatNumbers(
    occupiedSeatNumbers,
    '实际入座座位',
  )
  const selectedIndex = random.nextInt(normalizedSeatNumbers.length)

  if (
    !Number.isInteger(selectedIndex) ||
    selectedIndex < 0 ||
    selectedIndex >= normalizedSeatNumbers.length
  ) {
    throw new RangeError('随机源返回了超出范围的索引。')
  }

  return normalizedSeatNumbers[selectedIndex] as number
}
