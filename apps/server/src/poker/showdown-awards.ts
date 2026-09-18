import type { ContributionLayer } from './contribution-layers.js'
import type { HandEvaluation } from './hand-evaluator.js'
import type { SettledPot } from './settlement.js'
import { deepFreezeDecisionValue } from './decision-analysis-types.js'

function compareGrades(
  left: HandEvaluation['comparisonGrade'],
  right: HandEvaluation['comparisonGrade'],
): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = (left[index] as number) - (right[index] as number)
    if (difference !== 0) {
      return difference
    }
  }

  return 0
}

function determineWinners(
  eligibleSeatNumbers: readonly number[],
  evaluations: ReadonlyMap<number, HandEvaluation>,
): readonly number[] {
  if (eligibleSeatNumbers.length === 1) {
    return [...eligibleSeatNumbers]
  }

  let bestEvaluation: HandEvaluation | null = null
  let winners: number[] = []

  for (const seatNumber of eligibleSeatNumbers) {
    const evaluation = evaluations.get(seatNumber)
    if (evaluation === undefined) {
      throw new RangeError('有资格参与底池的座位缺少牌型评估。')
    }

    if (
      bestEvaluation === null ||
      compareGrades(
        evaluation.comparisonGrade,
        bestEvaluation.comparisonGrade,
      ) > 0
    ) {
      bestEvaluation = evaluation
      winners = [seatNumber]
    } else if (
      compareGrades(
        evaluation.comparisonGrade,
        bestEvaluation.comparisonGrade,
      ) === 0
    ) {
      winners.push(seatNumber)
    }
  }

  return winners
}

export function projectShowdownAwards(input: {
  readonly layers: readonly ContributionLayer[]
  readonly evaluations: ReadonlyMap<number, HandEvaluation>
  readonly buttonSeatNumber: number
}): readonly SettledPot[] {
  return deepFreezeDecisionValue(
    input.layers.map((layer, potIndex) => {
      if (layer.eligibleSeatNumbers.length === 0)
        throw new RangeError('底池必须有获胜资格者。')
      const winningSeatNumbers = determineWinners(
        layer.eligibleSeatNumbers,
        input.evaluations,
      )
      const baseAmount = Math.floor(layer.amount / winningSeatNumbers.length)
      const remainder = layer.amount % winningSeatNumbers.length
      // Physical seats run 0–8; the button receives an odd chip last.
      const orderedWinners = [...winningSeatNumbers].sort(
        (left, right) =>
          ((left - input.buttonSeatNumber + 8) % 9) -
          ((right - input.buttonSeatNumber + 8) % 9),
      )
      return {
        potIndex,
        kind: potIndex === 0 ? ('main' as const) : ('side' as const),
        amount: layer.amount,
        contributingSeatNumbers: [...layer.contributingSeatNumbers],
        eligibleSeatNumbers: [...layer.eligibleSeatNumbers],
        winningSeatNumbers,
        awards: orderedWinners.map((seatNumber, index) => ({
          seatNumber,
          baseAmount,
          oddChipAmount: index < remainder ? (1 as const) : (0 as const),
          amount: baseAmount + (index < remainder ? 1 : 0),
        })),
      }
    }),
  )
}
