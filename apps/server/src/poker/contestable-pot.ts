import {
  projectContributionLayers,
  type ContributionLayerSeatStatus,
} from './contribution-layers.js'

export interface ContestablePotSeat {
  readonly seatNumber: number
  readonly status: ContributionLayerSeatStatus
  readonly stack: number
  readonly totalContribution: number
}

export interface ContestablePotProjectionData<TSourceRef> {
  readonly contestablePotSchemaVersion: 1
  readonly projectorVersion: 1
  readonly sourceRefs: readonly TSourceRef[]
  readonly potBreakdown: readonly {
    readonly potId: string
    readonly amount: number
    readonly lowerContributionExclusive: number
    readonly upperContributionInclusive: number
    readonly contributingSeatNumbers: readonly number[]
    readonly eligibleSeatNumbers: readonly number[]
  }[]
  readonly effectiveStacksByOpponent: readonly {
    readonly opponentSeatNumber: number
    readonly currentEffectiveStack: number
    readonly maximumAdditionalMatchedContribution: number
  }[]
  readonly heroContestablePotBefore: number
  readonly heroMaximumContestableAmount: number
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

function isStillCompeting(status: ContributionLayerSeatStatus): boolean {
  return status === 'active' || status === 'allIn'
}

function safeSum(values: readonly number[]): number {
  const total = values.reduce((sum, value) => sum + value, 0)
  if (!Number.isSafeInteger(total)) {
    throw new RangeError('可争夺底池金额超出安全整数范围。')
  }
  return total
}

function maximumContributionLevel(seat: ContestablePotSeat): number {
  const maximum =
    seat.status === 'active'
      ? seat.totalContribution + seat.stack
      : seat.totalContribution
  if (!Number.isSafeInteger(maximum)) {
    throw new RangeError('座位最大投入超出安全整数范围。')
  }
  return maximum
}

export function projectContestablePot<TSourceRef>(input: {
  readonly heroSeatNumber: number
  readonly pot: number
  readonly seats: readonly ContestablePotSeat[]
  readonly sourceRefs: readonly TSourceRef[]
}): ContestablePotProjectionData<TSourceRef> {
  if (
    !Number.isSafeInteger(input.heroSeatNumber) ||
    input.heroSeatNumber < 0 ||
    input.seats.some(
      (seat) =>
        !Number.isSafeInteger(seat.stack) ||
        seat.stack < 0 ||
        !Number.isSafeInteger(seat.totalContribution) ||
        seat.totalContribution < 0,
    )
  ) {
    throw new RangeError('可争夺底池输入无效。')
  }

  const hero = input.seats.find(
    (seat) => seat.seatNumber === input.heroSeatNumber,
  )
  if (hero === undefined || !isStillCompeting(hero.status)) {
    throw new RangeError('Hero 必须是仍有获胜资格的参与座位。')
  }

  const contributionProjection = projectContributionLayers({
    pot: input.pot,
    seats: input.seats,
  })
  const potBreakdown = contributionProjection.layers.map((layer, index) => ({
    potId: index === 0 ? 'main' : `side-${index}`,
    amount: layer.amount,
    lowerContributionExclusive: layer.lowerContributionExclusive,
    upperContributionInclusive: layer.upperContributionInclusive,
    contributingSeatNumbers: [...layer.contributingSeatNumbers],
    eligibleSeatNumbers: [...layer.eligibleSeatNumbers],
  }))
  const competingOpponents = input.seats
    .filter(
      (seat) =>
        seat.seatNumber !== hero.seatNumber && isStillCompeting(seat.status),
    )
    .sort((left, right) => left.seatNumber - right.seatNumber)
  const heroMaximumContribution = maximumContributionLevel(hero)

  const effectiveStacksByOpponent = competingOpponents.map((opponent) => ({
    opponentSeatNumber: opponent.seatNumber,
    currentEffectiveStack: Math.min(hero.stack, opponent.stack),
    maximumAdditionalMatchedContribution: Math.min(
      opponent.stack,
      Math.max(0, heroMaximumContribution - opponent.totalContribution),
    ),
  }))
  const heroContestablePotBefore = safeSum(
    contributionProjection.layers
      .filter((layer) => layer.eligibleSeatNumbers.includes(hero.seatNumber))
      .map((layer) => layer.amount),
  )
  const maximumMatchedHeroContribution = Math.min(
    heroMaximumContribution,
    Math.max(
      0,
      ...input.seats
        .filter((seat) => seat.seatNumber !== hero.seatNumber)
        .map(maximumContributionLevel),
    ),
  )
  const heroMaximumContestableAmount = safeSum(
    input.seats.map((seat) => {
      if (seat.seatNumber === hero.seatNumber) {
        return maximumMatchedHeroContribution
      }
      return Math.min(
        maximumMatchedHeroContribution,
        maximumContributionLevel(seat),
      )
    }),
  )

  let sourceRefs: TSourceRef[]
  try {
    sourceRefs = structuredClone([...input.sourceRefs])
  } catch {
    throw new RangeError('事实来源必须是可复制的纯值。')
  }

  return deepFreeze({
    contestablePotSchemaVersion: 1,
    projectorVersion: 1,
    sourceRefs,
    potBreakdown,
    effectiveStacksByOpponent,
    heroContestablePotBefore,
    heroMaximumContestableAmount,
  })
}
