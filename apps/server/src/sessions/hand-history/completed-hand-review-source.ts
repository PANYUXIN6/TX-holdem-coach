import type { Card, LegalActions } from '@tx-holdem-coach/contracts'
import type { PokerCommand } from '../../poker/commands.js'
import type {
  ActionTableSnapshot,
  CompletedHandSummary,
  StartedHandFacts,
} from '../../poker/hand-result.js'
import type { PokerRuleSetVersion } from '../../poker/poker-rule-set.js'

export interface ReviewEventIdentity {
  readonly eventSeq: number
  readonly commandLedgerId: string | null
  readonly stateVersionBefore: number
  readonly stateVersionAfter: number
}
export interface ReviewActionBefore {
  readonly actorSeatNumber: number
  readonly command: PokerCommand
  readonly before: ActionTableSnapshot
  readonly legalActionsBefore: LegalActions
}
export interface ReviewPublicAction extends ReviewActionBefore {
  readonly after: ActionTableSnapshot
  readonly progression: {
    readonly streetTransitions: readonly ActionTableSnapshot['street'][]
    readonly boardCardsAdded: readonly Card[]
    readonly terminationReason: 'showdown' | 'complete' | null
  }
}
export interface ReviewPersonaReference {
  readonly seatNumber: number
  readonly participantId: string
  readonly personaId: string
  readonly personaVersion: number
  readonly configSnapshotKey: string
}
export interface CompletedHandReviewFacts {
  readonly ownerId: string
  readonly sessionId: string
  readonly handId: string
  readonly pokerRuleSetVersion: PokerRuleSetVersion
  readonly startedHand: StartedHandFacts
  readonly completedEventSeq: number
  readonly heroSeatNumber: 0
  readonly personas: readonly ReviewPersonaReference[]
  readonly result: CompletedHandSummary
  readonly events: readonly (ReviewEventIdentity &
    (
      | { readonly type: 'handStarted' }
      | {
          readonly type: 'actionCommitted'
          readonly action: ReviewPublicAction
        }
      | { readonly type: 'coordination' }
      | { readonly type: 'uncalledBetReturned' | 'handCompleted' }
    ))[]
}
export interface ReviewDecisionPrefix {
  readonly ownerId: string
  readonly sessionId: string
  readonly handId: string
  readonly pokerRuleSetVersion: PokerRuleSetVersion
  readonly startedHand: StartedHandFacts
  readonly completedEventSeq: number
  readonly heroSeatNumber: 0
  readonly heroHoleCards: readonly [Card, Card]
  readonly board: readonly Card[]
  readonly personas: readonly ReviewPersonaReference[]
  readonly events: readonly CompletedHandReviewFacts['events'][number][]
  readonly target: ReviewEventIdentity & ReviewActionBefore
}
export type CompletedHandReviewReadResult =
  | { readonly kind: 'notFound' }
  | { readonly kind: 'notCompleted' }
  | { readonly kind: 'completed'; readonly facts: CompletedHandReviewFacts }
export interface ReviewReadBudget {
  readonly signal: AbortSignal
  readonly deadlineAt: number
}
export interface CompletedHandReviewSourceReader {
  readCompletedSource(
    handId: string,
    budget: ReviewReadBudget,
  ): Promise<CompletedHandReviewReadResult>
}

/** Only the trusted source adapter holds facts. Each prefix is a detached safe copy. */
export function projectReviewDecisionPrefix(
  facts: CompletedHandReviewFacts,
  eventSeq: number,
): ReviewDecisionPrefix {
  const target = facts.events.find((event) => event.eventSeq === eventSeq)
  const hero = facts.result.participantHands.find(
    (hand) => hand.seatNumber === facts.heroSeatNumber,
  )
  if (
    target?.type !== 'actionCommitted' ||
    target.action.actorSeatNumber !== facts.heroSeatNumber ||
    !hero
  )
    throw new TypeError('invalid_review_decision_source')
  const count = { preflop: 0, flop: 3, turn: 4, river: 5 }[
    target.action.before.street as 'preflop' | 'flop' | 'turn' | 'river'
  ]
  if (count === undefined) throw new TypeError('invalid_review_decision_street')
  return structuredClone({
    ownerId: facts.ownerId,
    sessionId: facts.sessionId,
    handId: facts.handId,
    pokerRuleSetVersion: facts.pokerRuleSetVersion,
    startedHand: facts.startedHand,
    completedEventSeq: facts.completedEventSeq,
    heroSeatNumber: facts.heroSeatNumber,
    heroHoleCards: hero.holeCards,
    board: facts.result.board.slice(0, count),
    personas: facts.personas,
    events: facts.events.filter((event) => event.eventSeq < eventSeq),
    target: {
      eventSeq: target.eventSeq,
      commandLedgerId: target.commandLedgerId,
      stateVersionBefore: target.stateVersionBefore,
      stateVersionAfter: target.stateVersionAfter,
      actorSeatNumber: target.action.actorSeatNumber,
      command: target.action.command,
      before: target.action.before,
      legalActionsBefore: target.action.legalActionsBefore,
    },
  })
}
