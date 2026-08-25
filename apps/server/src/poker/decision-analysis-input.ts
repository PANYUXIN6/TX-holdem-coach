import type { Card, LegalActions } from '@tx-holdem-coach/contracts'
import type { PokerCommand } from './commands.js'
import type { LogicalPosition } from './positioning.js'
import type { PokerRuleSetVersion } from './poker-rule-set.js'
import type { BettingProjectionState } from './betting-projection.js'

export interface DecisionAnalysisSeat {
  readonly seatNumber: number
  readonly stack: number
  readonly status: 'active' | 'folded' | 'allIn' | 'out'
  readonly streetContribution: number
  readonly totalContribution: number
}

export interface DecisionAnalysisPublicAction {
  readonly eventSeq: number
  readonly streetBefore: 'preflop' | 'flop' | 'turn' | 'river'
  readonly actorSeatNumber: number
  readonly action: PokerCommand['action']
  readonly amountToCallBefore: number
  readonly contributionDelta: number
  readonly targetStreetCommitmentAfter: number
  readonly totalContributionAfter: number
  readonly potBefore: number
  readonly currentBetBefore: number
  readonly currentBetAfter: number
  readonly minimumFullRaiseIncrementBefore: number
  readonly minimumFullRaiseIncrementAfter: number
  readonly isVoluntaryPreflopContribution: boolean
  readonly isFullRaise: boolean
}

export interface DecisionAnalysisInput {
  readonly pokerRuleSetVersion: PokerRuleSetVersion
  readonly buttonSeatNumber: number
  readonly participantSeatNumbers: readonly number[]
  readonly heroSeatNumber: number
  readonly street: 'preflop' | 'flop' | 'turn' | 'river'
  readonly positions: readonly {
    readonly seatNumber: number
    readonly position: LogicalPosition
  }[]
  readonly startingStacks: readonly {
    readonly seatNumber: number
    readonly stack: number
  }[]
  readonly smallBlindSeatNumber: number
  readonly bigBlindSeatNumber: number
  readonly heroHoleCards: readonly [Card, Card]
  readonly board: readonly Card[]
  readonly pot: number
  readonly seats: readonly DecisionAnalysisSeat[]
  readonly bettingRound: {
    readonly currentBet: number
    readonly minimumFullRaiseIncrement: number
    readonly seatStates: readonly {
      readonly seatNumber: number
      readonly betLevelAfterLastAction: number | null
    }[]
  }
  readonly legalActions: LegalActions
  readonly publicActions: readonly DecisionAnalysisPublicAction[]
}

export function toBettingProjectionState(
  input: DecisionAnalysisInput,
): BettingProjectionState {
  return {
    buttonSeatNumber: input.buttonSeatNumber,
    participantSeatNumbers: [...input.participantSeatNumbers],
    street: input.street,
    currentActorSeatNumber: input.heroSeatNumber,
    pot: input.pot,
    seats: input.seats.map((seat) => ({ ...seat })),
    bettingRound: {
      currentBet: input.bettingRound.currentBet,
      minimumFullRaiseIncrement: input.bettingRound.minimumFullRaiseIncrement,
      seatStates: input.bettingRound.seatStates.map((seat) => ({ ...seat })),
    },
  }
}
