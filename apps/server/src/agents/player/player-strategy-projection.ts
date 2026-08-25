import type { StrategyPack } from '../../poker-strategy/strategy-pack.js'
import {
  projectStrategy,
  type StrategyProjection,
} from '../../poker-strategy/strategy-projection.js'
import type { BoundAnalysis } from './player-decision-analysis-input.js'
import {
  isPlayerDecisionAnalysisCore,
  type PlayerDecisionAnalysisCore,
} from './player-decision-analysis-core.js'

declare const playerStrategyProjectionBrand: unique symbol

export type PlayerStrategyProjection = BoundAnalysis<StrategyProjection> & {
  readonly [playerStrategyProjectionBrand]: never
}

const certifiedStrategyProjections = new WeakSet<object>()

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

export function buildPlayerStrategyProjection(input: {
  readonly analysisCore: PlayerDecisionAnalysisCore
  readonly strategyPack: StrategyPack
}): PlayerStrategyProjection {
  if (!isPlayerDecisionAnalysisCore(input.analysisCore)) {
    throw new RangeError('策略投影只接受认证分析核心。')
  }
  const hand = input.analysisCore.data.handFeatures
  const exactHandAbstractionKey =
    hand.kind === 'preflop'
      ? `preflop:v1:${hand.startingHandClass}`
      : `postflop:v1:visible:${hand.visibleCardsSha256}`
  const referenceHandAbstractionKey =
    hand.kind === 'preflop'
      ? exactHandAbstractionKey
      : `postflop:v1:${hand.handCategory}:${hand.pairRelation}`
  const callTarget =
    input.analysisCore.data.currentMetrics.amounts.currentStreetContribution +
    input.analysisCore.data.currentMetrics.amounts.amountToCall
  const aggressiveCandidateIds = input.analysisCore.data.legalCandidates
    .filter(
      (candidate) =>
        candidate.action.type === 'bet' ||
        candidate.action.type === 'raise' ||
        (candidate.action.type === 'allIn' &&
          candidate.targetStreetCommitment !== null &&
          candidate.targetStreetCommitment > callTarget),
    )
    .map((candidate) => candidate.candidateId)
  const result = deepFreeze({
    binding: input.analysisCore.binding,
    data: projectStrategy({
      pack: input.strategyPack,
      spotKey: input.analysisCore.data.normalizedSpot.spotKey,
      exactHandAbstractionKey,
      referenceHandAbstractionKey,
      assumptionCodes: [],
      legalCandidateIds: input.analysisCore.data.legalCandidates.map(
        (candidate) => candidate.candidateId,
      ),
      aggressiveCandidateIds,
    }),
  } as unknown as PlayerStrategyProjection)
  certifiedStrategyProjections.add(result)
  return result
}

export function isPlayerStrategyProjection(
  value: unknown,
): value is PlayerStrategyProjection {
  return (
    typeof value === 'object' &&
    value !== null &&
    certifiedStrategyProjections.has(value)
  )
}
