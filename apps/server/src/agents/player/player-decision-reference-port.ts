import type { ResolvedOwnerScope } from '../../persistence/owner-scope.js'
import type { PlayerVisibleState } from '../../sessions/authoritative-state/player-visible-state.js'
import type { PlayerDecisionReference } from './player-decision-reference.js'

export type PlayerDecisionReferenceLoadResult =
  | {
      readonly kind: 'ready'
      readonly reference: PlayerDecisionReference
    }
  | { readonly kind: 'stale' }
  | { readonly kind: 'resourceMissing' }

export interface PlayerDecisionReferencePort {
  load(input: {
    readonly owner: ResolvedOwnerScope
    readonly observation: PlayerVisibleState
  }): Promise<PlayerDecisionReferenceLoadResult>
}
