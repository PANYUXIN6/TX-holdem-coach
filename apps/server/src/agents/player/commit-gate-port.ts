import type { RuntimeCommitAuthority } from '../foundation/runtime-ports.js'
import type { RuntimeComponentReference } from '../foundation/runtime-definition.js'
import type { ResolvedOwnerScope } from '../../persistence/owner-scope.js'
import type { PlayerDecisionIdentity } from '../../sessions/authoritative-state/decision-identity.js'

declare const playerRuntimeCandidateResultBrand: unique symbol
declare const playerValidatedDecisionBrand: unique symbol

export interface PlayerRuntimeCandidateResultShape {
  readonly runtimeType: 'player'
  readonly runtimeDefinitionVersion: number
  readonly outputSchema: RuntimeComponentReference
  readonly validator: RuntimeComponentReference
  readonly [playerRuntimeCandidateResultBrand]: never
}

export interface PlayerRuntimeResultPort {
  accept(result: PlayerRuntimeCandidateResultShape): Promise<void>
}

export interface PlayerValidatedDecisionShape {
  readonly runtimeType: 'player'
  readonly runtimeDefinitionVersion: number
  readonly outputSchema: RuntimeComponentReference
  readonly validator: RuntimeComponentReference
  readonly [playerValidatedDecisionBrand]: never
}

export type PlayerCommitGateResult =
  | { readonly kind: 'committed'; readonly commandId: string }
  | { readonly kind: 'replayed'; readonly commandId: string }
  | { readonly kind: 'stale' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'resourceMissing' }
  | { readonly kind: 'rejected' }

export interface PlayerCommitGatePort {
  commit(input: {
    readonly owner: ResolvedOwnerScope
    readonly authority: RuntimeCommitAuthority<'player'>
    readonly identity: PlayerDecisionIdentity
    readonly candidate: PlayerValidatedDecisionShape
  }): Promise<PlayerCommitGateResult>
}
