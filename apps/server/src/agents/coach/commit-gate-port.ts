import type { RuntimeCommitAuthority } from '../foundation/runtime-ports.js'
import type { RuntimeComponentReference } from '../foundation/runtime-definition.js'
import type { ResolvedOwnerScope } from '../../persistence/owner-scope.js'

declare const coachRuntimeReportResultBrand: unique symbol
declare const coachValidatedReportBrand: unique symbol

export interface CoachRuntimeReportResultShape {
  readonly runtimeType: 'coach'
  readonly runtimeDefinitionVersion: number
  readonly outputSchema: RuntimeComponentReference
  readonly validator: RuntimeComponentReference
  readonly [coachRuntimeReportResultBrand]: never
}

export interface CoachRuntimeResultPort {
  accept(result: CoachRuntimeReportResultShape): Promise<void>
}

export interface CoachValidatedReportShape {
  readonly runtimeType: 'coach'
  readonly runtimeDefinitionVersion: number
  readonly outputSchema: RuntimeComponentReference
  readonly validator: RuntimeComponentReference
  readonly [coachValidatedReportBrand]: never
}

export type CoachCommitGateResult =
  | { readonly kind: 'committed'; readonly coachReviewId: string }
  | { readonly kind: 'replayed'; readonly coachReviewId: string }
  | { readonly kind: 'stale' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'resourceMissing' }
  | { readonly kind: 'rejected' }

export interface CoachCommitGatePort {
  commit(input: {
    readonly owner: ResolvedOwnerScope
    readonly authority: RuntimeCommitAuthority<'coach'>
    readonly sessionId: string
    readonly handId: string
    readonly coachReviewId: string
    readonly report: CoachValidatedReportShape
  }): Promise<CoachCommitGateResult>
}
