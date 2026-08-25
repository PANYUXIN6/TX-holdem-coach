export type ContributionLayerSeatStatus = 'active' | 'folded' | 'allIn' | 'out'

export interface ContributionLayerSeat {
  readonly seatNumber: number
  readonly status: ContributionLayerSeatStatus
  readonly totalContribution: number
}

export interface ContributionLayer {
  readonly layerIndex: number
  readonly lowerContributionExclusive: number
  readonly upperContributionInclusive: number
  readonly amount: number
  readonly contributingSeatNumbers: readonly number[]
  readonly eligibleSeatNumbers: readonly number[]
}

export interface UncalledContributionCandidate {
  readonly layerIndex: number
  readonly seatNumber: number
  readonly amount: number
  readonly lowerContributionExclusive: number
  readonly upperContributionInclusive: number
}

export interface ContributionLayerProjection {
  readonly layers: readonly ContributionLayer[]
  readonly totalContribution: number
  readonly uncalledContributionCandidate: UncalledContributionCandidate | null
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

function isEligible(status: ContributionLayerSeatStatus): boolean {
  return status === 'active' || status === 'allIn'
}

export function projectContributionLayers(input: {
  readonly pot: number
  readonly seats: readonly ContributionLayerSeat[]
}): ContributionLayerProjection {
  if (
    !Number.isSafeInteger(input.pot) ||
    input.pot < 0 ||
    input.seats.some(
      (seat) =>
        !Number.isSafeInteger(seat.seatNumber) ||
        seat.seatNumber < 0 ||
        !['active', 'folded', 'allIn', 'out'].includes(seat.status) ||
        !Number.isSafeInteger(seat.totalContribution) ||
        seat.totalContribution < 0,
    ) ||
    new Set(input.seats.map((seat) => seat.seatNumber)).size !==
      input.seats.length
  ) {
    throw new RangeError('贡献分层输入无效。')
  }

  const seats = [...input.seats].sort(
    (left, right) => left.seatNumber - right.seatNumber,
  )
  const levels = [
    ...new Set(
      seats
        .map((seat) => seat.totalContribution)
        .filter((contribution) => contribution > 0),
    ),
  ].sort((left, right) => left - right)
  const layers: ContributionLayer[] = []
  let previousLevel = 0

  for (const level of levels) {
    const contributors = seats.filter((seat) => seat.totalContribution >= level)
    const eligibleSeatNumbers = contributors
      .filter((seat) => isEligible(seat.status))
      .map((seat) => seat.seatNumber)
    const amount = (level - previousLevel) * contributors.length

    if (
      !Number.isSafeInteger(amount) ||
      amount <= 0 ||
      eligibleSeatNumbers.length === 0
    ) {
      throw new RangeError('每个贡献层必须有安全金额和至少一名获胜资格者。')
    }

    layers.push({
      layerIndex: layers.length,
      lowerContributionExclusive: previousLevel,
      upperContributionInclusive: level,
      amount,
      contributingSeatNumbers: contributors.map((seat) => seat.seatNumber),
      eligibleSeatNumbers,
    })
    previousLevel = level
  }

  const totalContribution = layers.reduce(
    (total, layer) => total + layer.amount,
    0,
  )
  if (
    !Number.isSafeInteger(totalContribution) ||
    totalContribution !== input.pot
  ) {
    throw new RangeError('贡献分层总额必须严格等于当前底池。')
  }

  const highestLayer = layers.at(-1)
  const uncalledContributionCandidate =
    highestLayer?.contributingSeatNumbers.length === 1
      ? {
          layerIndex: highestLayer.layerIndex,
          seatNumber: highestLayer.contributingSeatNumbers[0]!,
          amount: highestLayer.amount,
          lowerContributionExclusive: highestLayer.lowerContributionExclusive,
          upperContributionInclusive: highestLayer.upperContributionInclusive,
        }
      : null

  return deepFreeze({
    layers,
    totalContribution,
    uncalledContributionCandidate,
  })
}
