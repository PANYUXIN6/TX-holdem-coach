import {
  buildDecisionAnalysisCore,
  type DecisionAnalysisCoreData,
} from '../../poker/decision-analysis-core.js'
import type { PlayerVisibleState } from '../../sessions/authoritative-state/player-visible-state.js'
import type { BoundAnalysis } from './player-decision-analysis-input.js'
import { createPlayerDecisionAnalysisInput } from './player-decision-analysis-input.js'
import type { PlayerDecisionReference } from './player-decision-reference.js'
import {
  mapCoreFactSourcesToPlayer,
  type PlayerSourced,
} from './player-fact-sources.js'

export type PlayerDecisionAnalysisCoreData =
  PlayerSourced<DecisionAnalysisCoreData>

declare const playerDecisionAnalysisCoreBrand: unique symbol

export type PlayerDecisionAnalysisCore =
  BoundAnalysis<PlayerDecisionAnalysisCoreData> & {
    readonly [playerDecisionAnalysisCoreBrand]: never
  }

const certifiedCores = new WeakSet<object>()

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

export function buildPlayerDecisionAnalysisCore(input: {
  readonly observation: PlayerVisibleState
  readonly reference: PlayerDecisionReference
}): PlayerDecisionAnalysisCore {
  const prepared = createPlayerDecisionAnalysisInput(input)
  const core = buildDecisionAnalysisCore(prepared.analysisInput)
  const result = deepFreeze({
    binding: prepared.binding,
    data: mapCoreFactSourcesToPlayer(core, prepared.binding),
  } as unknown as PlayerDecisionAnalysisCore)
  certifiedCores.add(result)
  return result
}

export function isPlayerDecisionAnalysisCore(
  value: unknown,
): value is PlayerDecisionAnalysisCore {
  return (
    typeof value === 'object' && value !== null && certifiedCores.has(value)
  )
}
