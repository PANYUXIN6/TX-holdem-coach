import type { ResolvedOwnerScope } from '../../persistence/owner-scope.js'
import type { PlayerDecisionIdentity } from './decision-identity.js'

export interface PlayerObservationAuthorityPort<TProjection> {
  load(input: {
    readonly owner: ResolvedOwnerScope
    readonly identity: PlayerDecisionIdentity
  }): Promise<TProjection>
}

export interface CoachReviewAuthorityPort<TProjection> {
  load(input: {
    readonly owner: ResolvedOwnerScope
    readonly sessionId: string
    readonly handId: string
  }): Promise<TProjection>
}
