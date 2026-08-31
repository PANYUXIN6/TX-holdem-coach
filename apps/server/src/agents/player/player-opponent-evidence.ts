import type { PlayerVisibleState } from '../../sessions/authoritative-state/player-visible-state.js'
import {
  projectOpponentFeaturesV1,
  type OpponentEvidenceProjectionData,
} from './opponent-feature-projector.js'
import type { BoundAnalysis } from './player-decision-analysis-input.js'
import { createPlayerDecisionAnalysisBinding } from './player-decision-analysis-input.js'
import type { PlayerDecisionReference } from './player-decision-reference.js'
import type { PlayerSessionMemoryEvidenceInputV1 } from './opponent-feature-projector.js'

declare const playerOpponentEvidenceBrand: unique symbol

export type PlayerOpponentEvidence =
  BoundAnalysis<OpponentEvidenceProjectionData> & {
    readonly [playerOpponentEvidenceBrand]: never
  }

const certifiedOpponentEvidence = new WeakSet<object>()

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

export function buildPlayerOpponentEvidence(input: {
  readonly observation: PlayerVisibleState
  readonly reference: PlayerDecisionReference
  readonly sessionMemory: PlayerSessionMemoryEvidenceInputV1
}): PlayerOpponentEvidence {
  const binding = createPlayerDecisionAnalysisBinding(input)
  const result = deepFreeze({
    binding,
    data: projectOpponentFeaturesV1(input.observation, input.sessionMemory),
  } as unknown as PlayerOpponentEvidence)
  certifiedOpponentEvidence.add(result)
  return result
}

export function isPlayerOpponentEvidence(
  value: unknown,
): value is PlayerOpponentEvidence {
  return (
    typeof value === 'object' &&
    value !== null &&
    certifiedOpponentEvidence.has(value)
  )
}
