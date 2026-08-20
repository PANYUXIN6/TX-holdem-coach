import type { LockedSessionView } from '../../persistence/session-mutation-repository.js'
import type { PrivateEvent } from '../authoritative-state/private-event.js'
import type { PrivateTableState } from '../authoritative-state/private-table-state.js'

export type ProjectionRosterSeat =
  | {
      readonly seatNumber: 0
      readonly playerId: string
      readonly isUser: true
    }
  | {
      readonly seatNumber: number
      readonly playerId: string
      readonly isUser: false
      readonly displayName: string
      readonly avatarColor: string
    }

export interface CommittedPrivateEventFact {
  readonly eventSeq: number
  readonly handId: string
  readonly event: PrivateEvent
}

export interface PublicSessionProjectionFacts {
  readonly state: PrivateTableState
  readonly session: LockedSessionView
  readonly eventSeq: number
  readonly newPrivateEvents: readonly PrivateEvent[]
  readonly roster: readonly ProjectionRosterSeat[]
  readonly committedCurrentHandEvents: readonly CommittedPrivateEventFact[]
}

export interface PublicProjectionReadPort {
  readRoster(sessionId: string): Promise<readonly ProjectionRosterSeat[]>
  readCurrentHandEvents(input: {
    readonly sessionId: string
    readonly handId: string
    readonly beforeEventSeq: number
  }): Promise<readonly CommittedPrivateEventFact[]>
}

export interface ActivePublicProjectionReadPort extends PublicProjectionReadPort {
  readFacts(sessionId: string): Promise<PublicSessionProjectionFacts | null>
}

export interface ReadonlyDiagnosticProjectionFacts {
  readonly kind: 'readonlyDiagnostic'
}

export type PublicProjectionFactsLookup =
  PublicSessionProjectionFacts | ReadonlyDiagnosticProjectionFacts | null

export interface PublicProjectionFactsRepository {
  findActive(): Promise<PublicProjectionFactsLookup>
  getById(sessionId: string): Promise<PublicProjectionFactsLookup>
}
