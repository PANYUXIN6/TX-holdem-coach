import type { ResolvedOwnerScope } from '../../persistence/owner-scope.js'
import type { PlayerDecisionIdentity } from '../../sessions/authoritative-state/decision-identity.js'
import type { PlayerVisibleState } from '../../sessions/authoritative-state/player-visible-state.js'

export interface PlayerObservationAuthorityPort<TProjection> {
  load(input: {
    readonly owner: ResolvedOwnerScope
    readonly identity: PlayerDecisionIdentity
  }): Promise<TProjection>
}

export type PlayerObservationLoadResult =
  | {
      readonly kind: 'ready'
      readonly observation: PlayerVisibleState
    }
  | { readonly kind: 'stale' }
  | { readonly kind: 'authorityLost' }
  | { readonly kind: 'resourceMissing' }

export type PlayerObservationPort =
  PlayerObservationAuthorityPort<PlayerObservationLoadResult>
