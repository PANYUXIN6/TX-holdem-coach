import { z } from 'zod'
import type { PokerRuleSetVersion } from './poker-rule-set.js'

export type DecisionAnalysisInputPath =
  | 'table.buttonSeatNumber'
  | 'table.seats'
  | 'hand.street'
  | 'hand.positions'
  | 'hand.startingStacks'
  | 'hand.heroHoleCards'
  | 'hand.board'
  | 'hand.pot'
  | 'hand.bettingRound'
  | 'hand.legalActions'
  | 'hand.publicActions'

export type PokerRuleFactId =
  | 'nominalBlinds'
  | 'standard52CardUnknownUniverse'
  | 'bettingRoundProgression'
  | 'contributionLayering'

export type M45AlgorithmId =
  | 'spotNormalizer'
  | 'handFeatureAnalyzer'
  | 'contestablePotProjector'
  | 'decisionMetricsEngine'
  | 'legalCandidateFactory'
  | 'candidateOutcomeProjector'

export const M45_ASSUMPTION_CODES = [
  'ignoresFutureAction',
  'noVersionedOpponentRange',
  'noJointResponseModel',
  'currentHandEvidenceOnly',
] as const

export const M45AssumptionCodeSchema = z.enum(M45_ASSUMPTION_CODES)
export type M45AssumptionCode = z.infer<typeof M45AssumptionCodeSchema>

export type M45UnavailableReasonCode =
  | 'noVersionedOpponentRange'
  | 'noJointResponseModel'
  | 'crossHandEvidenceUnavailable'
  | 'unsupportedStrategySpot'
  | 'insufficientEvidence'

export type M45NotApplicableReasonCode =
  | 'noCallRequired'
  | 'preflopCurrentSprUndefined'
  | 'forcedRunout'
  | 'noRangeBasedBluffClassification'
  | 'noBetOnStreet'
  | 'noPriorPostflopStreet'
  | 'noFutureDecisionStreet'
  | 'pairHasNoRankGap'

export type CoreFactSourceRef =
  | {
      readonly kind: 'analysisInputField'
      readonly path: DecisionAnalysisInputPath
      readonly eventSeq: number | null
    }
  | {
      readonly kind: 'ruleSet'
      readonly pokerRuleSetVersion: PokerRuleSetVersion
      readonly factId: PokerRuleFactId
    }
  | {
      readonly kind: 'algorithm'
      readonly algorithmId: M45AlgorithmId
      readonly version: 1
    }

export type DerivedFact<T, TSourceRef = CoreFactSourceRef> =
  | {
      readonly status: 'available'
      readonly value: T
      readonly epistemicKind:
        | 'ruleFact'
        | 'formulaFact'
        | 'datasetBaseline'
        | 'statisticalEvidence'
        | 'heuristicJudgment'
      readonly sourceRefs: readonly TSourceRef[]
      readonly assumptionCodes: readonly M45AssumptionCode[]
    }
  | {
      readonly status: 'unavailable'
      readonly reasonCode: M45UnavailableReasonCode
      readonly sourceRefs: readonly TSourceRef[]
      readonly assumptionCodes: readonly M45AssumptionCode[]
    }
  | {
      readonly status: 'notApplicable'
      readonly reasonCode: M45NotApplicableReasonCode
      readonly sourceRefs: readonly TSourceRef[]
      readonly assumptionCodes: readonly M45AssumptionCode[]
    }

export type CoreDerivedFact<T> = DerivedFact<T, CoreFactSourceRef>

export interface ExactRatio {
  readonly numerator: number
  readonly denominator: number
  readonly basisPoints: number
}

export function createExactRatio(
  numerator: number,
  denominator: number,
): ExactRatio {
  if (
    !Number.isSafeInteger(numerator) ||
    numerator < 0 ||
    !Number.isSafeInteger(denominator) ||
    denominator <= 0
  ) {
    throw new RangeError('精确比例必须由非负分子和正分母组成。')
  }
  const gcd = (left: number, right: number): number =>
    right === 0 ? left : gcd(right, left % right)
  const divisor = gcd(numerator, denominator)
  const roundedBasisPoints =
    (BigInt(numerator) * 10_000n + BigInt(Math.floor(denominator / 2))) /
    BigInt(denominator)
  if (roundedBasisPoints > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('精确比例 basis points 超出安全整数范围。')
  }
  return Object.freeze({
    numerator: numerator / divisor,
    denominator: denominator / divisor,
    basisPoints: Number(roundedBasisPoints),
  })
}

export function deepFreezeDecisionValue<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreezeDecisionValue(nested)
    Object.freeze(value)
  }
  return value
}
