import type { DecisionAnalysisPublicAction } from '../poker/decision-analysis-input.js'
import { normalizeComboWeights, type WeightedCombo } from './combo-expander.js'
import type { Card, RangeUpdateRule } from './opponent-range-pack.js'
import {
  matchesRangeApplicability,
  type RangeMatchContext,
} from './range-scenario.js'

export interface RangeUpdateTrace {
  readonly eventSeq: number
  readonly ruleId: string
  readonly sourceRefs: readonly string[]
  readonly weightMultiplierBasisPoints: number
  readonly affectedComboCount: number
  readonly massBefore: number
  readonly massAfter: number
  readonly explanation: string
}
function matchesBoard(rule: RangeUpdateRule, board: readonly Card[]): boolean {
  switch (rule.boardPredicate.kind) {
    case 'any':
      return true
    case 'paired':
      return (
        new Set(board.map((card) => card.rank)).size < board.length ===
        rule.boardPredicate.value
      )
    case 'maxSuitCount':
      return (
        Math.max(
          0,
          ...board.map(
            (card) => board.filter((other) => other.suit === card.suit).length,
          ),
        ) === rule.boardPredicate.count
      )
  }
}
export function applyRangeUpdates(input: {
  readonly combos: readonly WeightedCombo[]
  readonly actions: readonly DecisionAnalysisPublicAction[]
  readonly board: readonly Card[]
  readonly context: RangeMatchContext
  readonly rules: readonly RangeUpdateRule[]
}): {
  combos: WeightedCombo[]
  updateTrace: RangeUpdateTrace[]
  unmodeledActions: number[]
} {
  let combos = [...input.combos]
  const updateTrace: RangeUpdateTrace[] = []
  const unmodeledActions: number[] = []
  let previous = -1
  for (const action of input.actions) {
    if (action.eventSeq <= previous)
      throw new TypeError('range_unordered_actions')
    previous = action.eventSeq
    const board = input.board.slice(
      0,
      ({ preflop: 0, flop: 3, turn: 4, river: 5 } as const)[
        action.streetBefore
      ],
    )
    const rules = input.rules.filter(
      (rule) =>
        matchesRangeApplicability(rule.rangeNodeApplicability, input.context) &&
        rule.street === action.streetBefore &&
        rule.observedAction === action.action.type &&
        matchesBoard(rule, board) &&
        (rule.betSizeInterval === null ||
          (action.potBefore > 0 &&
            action.contributionDelta / action.potBefore >=
              rule.betSizeInterval.min &&
            action.contributionDelta / action.potBefore <=
              rule.betSizeInterval.max)),
    )
    if (!rules.length) unmodeledActions.push(action.eventSeq)
    const applied = new Set<number>()
    for (const rule of rules) {
      const affected = combos
        .map((combo, index) =>
          rule.handPredicate.kind === 'any' ||
          rule.handPredicate.handClasses.includes(combo.handClass)
            ? index
            : -1,
        )
        .filter((index) => index >= 0)
      if (affected.some((index) => applied.has(index)))
        throw new TypeError('range_ambiguous_update')
      for (const index of affected) applied.add(index)
    }
    for (const rule of rules) {
      const applies = (combo: WeightedCombo) =>
        rule.handPredicate.kind === 'any' ||
        rule.handPredicate.handClasses.includes(combo.handClass)
      const affected = combos.filter(applies)
      const massBefore = affected.reduce((sum, combo) => sum + combo.weight, 0)
      combos = normalizeComboWeights(
        combos.map((combo) =>
          applies(combo)
            ? {
                ...combo,
                weight:
                  (combo.weight * rule.weightMultiplierBasisPoints) / 10000,
              }
            : combo,
        ),
      )
      updateTrace.push({
        eventSeq: action.eventSeq,
        ruleId: rule.ruleId,
        sourceRefs: rule.sourceRefs,
        weightMultiplierBasisPoints: rule.weightMultiplierBasisPoints,
        affectedComboCount: affected.length,
        massBefore,
        massAfter: combos
          .filter(applies)
          .reduce((sum, combo) => sum + combo.weight, 0),
        explanation: rule.explanation,
      })
    }
  }
  return { combos, updateTrace, unmodeledActions }
}
