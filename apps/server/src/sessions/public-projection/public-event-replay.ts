import type { PublicSessionProjectionFacts } from './public-projection-facts.js'
import type { StoredPublicEventRow } from './public-event-protocol.js'

export const REPLAY_PAGE_SIZE = 128

export interface PublicEventStreamHead {
  readonly sessionId: string
  readonly lifecycleStatus: 'active' | 'ended' | 'readonlyDiagnostic'
  readonly highWatermark: number
}

export type PublicEventStreamBootstrap =
  | {
      readonly kind: 'ready'
      readonly facts: PublicSessionProjectionFacts
      readonly highWatermark: number
      readonly totalEventCount: number
      readonly minimumEventSeq: number
      readonly maximumEventSeq: number
    }
  | { readonly kind: 'readonlyDiagnostic' }

export interface ReplayPageProof {
  readonly fromEventSeq: number
  readonly throughEventSeq: number
  readonly eventCount: number
  readonly canonicalSha256: string
}

export interface PublicEventReplayRepository {
  readHead(sessionId: string): Promise<PublicEventStreamHead | null>
  readBootstrap(sessionId: string): Promise<PublicEventStreamBootstrap | null>
  readReplayPage(input: {
    readonly sessionId: string
    readonly fromEventSeq: number
    readonly throughEventSeq: number
  }): Promise<readonly StoredPublicEventRow[] | null>
}
