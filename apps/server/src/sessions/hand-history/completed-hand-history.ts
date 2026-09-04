import type { Card, PokerAction } from '@tx-holdem-coach/contracts'
import type { HandEvaluation } from '../../poker/hand-evaluator.js'
import type {
  CompletedHandResult,
  StartingHandCategory,
} from '../../poker/hand-result.js'
import type { LogicalPosition } from '../../poker/positioning.js'
import type { PokerRuleSetVersion } from '../../poker/poker-rule-set.js'
import type { SettledPot } from '../../poker/settlement.js'
import type { PrivateEvent } from '../authoritative-state/private-event.js'
import type { HandStartCheckpoint } from '../hand-audit/hand-start-checkpoint.js'

export type HistoryBettingStreet = 'preflop' | 'flop' | 'turn' | 'river'

export interface CompletedHandHistoryRosterEntry {
  readonly seatNumber: number
  readonly playerId: string
  readonly isUser: boolean
  readonly displayName: string
  readonly avatarColor: string
}

export interface CommittedPrivateHandEventFact {
  readonly eventSeq: number
  readonly event: PrivateEvent
}

export interface CompletedHandHistoryFacts {
  readonly ownerId: string
  readonly sessionId: string
  readonly handId: string
  readonly handNumber: number
  readonly startedAt: string
  readonly completedAt: string
  readonly checkpoint: HandStartCheckpoint
  readonly result: CompletedHandResult
  readonly roster: readonly CompletedHandHistoryRosterEntry[]
  readonly events: readonly CommittedPrivateHandEventFact[]
}

export interface CompletedHandHistoryFactsReader {
  readCompletedHandHistoryFacts(
    handId: string,
  ): Promise<CompletedHandHistoryFacts | null>
}

export interface HistoryParticipant {
  readonly seatNumber: number
  readonly playerId: string
  readonly isUser: boolean
  readonly displayName: string
  readonly avatarColor: string
  readonly position: LogicalPosition
  readonly startingStack: number
  readonly endingStack: number
  readonly totalContribution: number
  readonly netChange: number
  readonly startingHandCategory: StartingHandCategory
}

export interface HistoryAction {
  readonly actionNumber: number
  readonly eventSeq: number
  readonly actorSeatNumber: number
  readonly playerId: string
  readonly position: LogicalPosition
  readonly action: PokerAction
  readonly committedAmount: number
  readonly streetContributionAfterAction: number
  readonly stackAfterAction: number
  readonly potBeforeAction: number
  readonly potAfterAction: number
}

export interface HistoryBettingStreetPhase {
  readonly phase: HistoryBettingStreet
  readonly communityCards: readonly Card[]
  readonly actions: readonly HistoryAction[]
}

export interface HistoryUncalledBetReturn {
  readonly eventSeq: number
  readonly seatNumber: number
  readonly amount: number
}

export interface HistoryPrivateHand {
  readonly seatNumber: number
  readonly holeCards: readonly [Card, Card]
  readonly handEvaluation: HandEvaluation | null
}

export interface HistoryShowdownPhase {
  readonly phase: 'showdown'
  readonly terminationReason: 'showdown' | 'complete'
  readonly handCompletedEventSeq: number
  readonly communityCards: readonly Card[]
  readonly uncalledBetReturns: readonly HistoryUncalledBetReturn[]
  readonly privateHands: readonly HistoryPrivateHand[]
  readonly pots: readonly SettledPot[]
}

export interface AuthoritativeCompletedHandHistory {
  readonly sessionId: string
  readonly handId: string
  readonly handNumber: number
  readonly pokerRuleSetVersion: PokerRuleSetVersion
  readonly startedAt: string
  readonly completedAt: string
  readonly participantSeatNumbers: readonly number[]
  readonly buttonSeatNumber: number
  readonly smallBlindSeatNumber: number
  readonly bigBlindSeatNumber: number
  readonly participants: readonly HistoryParticipant[]
  readonly phases: readonly [
    HistoryBettingStreetPhase,
    ...HistoryBettingStreetPhase[],
    HistoryShowdownPhase,
  ]
}

export interface AuthoritativeCompletedHandHistoryReader {
  read(input: {
    readonly handId: string
  }): Promise<AuthoritativeCompletedHandHistory | null>
}
