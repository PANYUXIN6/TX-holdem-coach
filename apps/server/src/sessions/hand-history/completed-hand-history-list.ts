import type { CompletedHandResult } from '../../poker/hand-result.js'
import type { CompletedHandHistoryListQuery } from './completed-hand-history-list-query.js'

export interface HistoricalPersonaSnapshot {
  readonly seatNumber: number
  readonly personaId: string
  readonly personaVersion: number
  readonly displayName: string
  readonly avatarColor: string
  readonly configSnapshotKey: string
}

export interface CompletedHandHistoryListFact {
  readonly sessionId: string
  readonly handId: string
  readonly handNumber: number
  readonly startedAt: string
  readonly completedAt: string
  readonly result: CompletedHandResult
  readonly aiParticipants: readonly HistoricalPersonaSnapshot[]
}

export interface CompletedHandHistoryListFactsReader {
  listCompletedHandHistoryFacts(
    query: CompletedHandHistoryListQuery,
  ): Promise<readonly CompletedHandHistoryListFact[]>
}
