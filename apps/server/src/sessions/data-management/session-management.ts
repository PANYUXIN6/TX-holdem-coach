import type { SessionManagementRosterEntry } from '@tx-holdem-coach/contracts'
import type { PrivateTableState } from '../authoritative-state/private-table-state.js'
import type { NormalizedSessionManagementQuery } from './session-management-query.js'

export interface SessionManagementFact {
  readonly sessionId: string
  readonly lifecycle: 'active' | 'ended' | 'readonlyDiagnostic'
  readonly createdAt: string
  readonly endedAt: string | null
  readonly stateVersion: number
  readonly currentHandId: string | null
  readonly completedHandCount: number
  readonly roster: readonly SessionManagementRosterEntry[]
  readonly initialStacks:
    | readonly {
        readonly participantId: string
        readonly seatNumber: number
        readonly stack: number
      }[]
    | null
  readonly state: PrivateTableState | null
}

export interface SessionManagementFactsPage {
  readonly items: readonly SessionManagementFact[]
  readonly hasMore: boolean
}

export interface SessionManagementFactsReader {
  listSessionManagementFacts(
    query: NormalizedSessionManagementQuery,
  ): Promise<SessionManagementFactsPage>
}
