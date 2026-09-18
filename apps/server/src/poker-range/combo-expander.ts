import {
  RANGE_HAND_CLASSES,
  RANGE_SUITS,
  type Card,
  type RangeWeight,
} from './opponent-range-pack.js'

export interface WeightedCombo {
  readonly cards: readonly [Card, Card]
  readonly weight: number
  readonly handClass: string
}
export interface RangeChartCell {
  readonly handClass: string
  readonly relativeComboWeightBasisPoints: number
  readonly availableComboCount: number
  readonly normalizedMass: number
}
export function cardKey(card: Card): string {
  return `${card.rank}:${card.suit}`
}
export function normalizeComboWeights(
  combos: readonly WeightedCombo[],
): WeightedCombo[] {
  const total = combos.reduce((sum, combo) => sum + combo.weight, 0)
  if (!Number.isFinite(total) || total <= 0) return []
  return combos
    .filter((combo) => combo.weight > 0)
    .map((combo) => ({ ...combo, weight: combo.weight / total }))
}
export function projectRangeChart(
  weights: readonly RangeWeight[],
  combos: readonly WeightedCombo[],
): RangeChartCell[] {
  return weights.map((cell) => {
    const available = combos.filter(
      (combo) => combo.handClass === cell.handClass,
    )
    return {
      ...cell,
      availableComboCount: available.length,
      normalizedMass: available.reduce((sum, combo) => sum + combo.weight, 0),
    }
  })
}
export function expandRangeWeights(
  weights: readonly RangeWeight[],
  knownCards: readonly Card[],
): { combos: WeightedCombo[]; chart: RangeChartCell[] } {
  if (
    weights.length !== 169 ||
    new Set(weights.map((cell) => cell.handClass)).size !== 169 ||
    weights.some(
      (cell) =>
        !RANGE_HAND_CLASSES.includes(cell.handClass) ||
        !Number.isInteger(cell.relativeComboWeightBasisPoints) ||
        cell.relativeComboWeightBasisPoints < 0 ||
        cell.relativeComboWeightBasisPoints > 10000,
    )
  )
    throw new TypeError('range_invalid_weights')
  const blocked = new Set(knownCards.map(cardKey))
  if (blocked.size !== knownCards.length)
    throw new TypeError('range_duplicate_known_card')
  const raw: WeightedCombo[] = []
  for (const cell of weights) {
    if (cell.relativeComboWeightBasisPoints === 0) continue
    const firstRank = cell.handClass[0] as Card['rank']
    const secondRank = cell.handClass[1] as Card['rank']
    for (const [i, firstSuit] of RANGE_SUITS.entries()) {
      for (const [j, secondSuit] of RANGE_SUITS.entries()) {
        if (
          firstRank === secondRank
            ? i >= j
            : cell.handClass[2] === 's'
              ? i !== j
              : i === j
        )
          continue
        const cards: [Card, Card] = [
          { rank: firstRank, suit: firstSuit },
          { rank: secondRank, suit: secondSuit },
        ]
        if (cards.some((card) => blocked.has(cardKey(card)))) continue
        raw.push({
          cards,
          weight: cell.relativeComboWeightBasisPoints,
          handClass: cell.handClass,
        })
      }
    }
  }
  const combos = normalizeComboWeights(raw)
  return { combos, chart: projectRangeChart(weights, combos) }
}
