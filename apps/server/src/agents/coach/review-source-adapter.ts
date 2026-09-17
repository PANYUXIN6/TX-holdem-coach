import {
  assertAuthenticatedRunRead,
  type AuthenticatedRunRead,
} from '../foundation/run-read-authentication.js'
import type { CompletedHandReviewFacts } from '../../sessions/hand-history/completed-hand-review-source.js'
import { projectReviewDecisionPrefix } from '../../sessions/hand-history/completed-hand-review-source.js'
import { buildCoachReviewDecision } from './review-case-builder.js'
import {
  readCoachPolicyVersions,
  type CoachPolicyVersions,
} from './policy-versions.js'
import {
  CoachDecisionSourceSchema,
  HandReviewCaseSchema,
  freezeCoachData,
} from './review-case.js'

/** Trusted composition only. Process producers receive source decisions, never this adapter. */
export function createCoachReviewSourceAdapter(input: {
  readonly facts: CompletedHandReviewFacts
  readonly execution: AuthenticatedRunRead
  readonly supported: CoachPolicyVersions
  readonly signal: AbortSignal
}) {
  assertAuthenticatedRunRead(input.execution)
  const run = input.execution.run
  let facts: CompletedHandReviewFacts | undefined = input.facts
  const { signal } = input
  const assertActive = () => {
    signal.throwIfAborted()
    if (!facts || Date.now() >= Date.parse(run.deadlineAt))
      throw new TypeError('coach_review_source_released')
  }
  const release = () => {
    facts = undefined
    signal.removeEventListener('abort', release)
  }
  signal.addEventListener('abort', release, { once: true })
  try {
    assertActive()
    if (
      facts!.ownerId !== run.ownerId ||
      facts!.sessionId !== run.sessionId ||
      facts!.handId !== run.handId
    )
      throw new TypeError('coach_source_run_mismatch')
    const versions = readCoachPolicyVersions(
      run.runConfiguration.dataDependencies,
      input.supported,
    )
    const decisions = facts!.events
      .filter(
        (event) =>
          event.type === 'actionCommitted' &&
          event.action.actorSeatNumber === facts!.heroSeatNumber,
      )
      .map(
        (event) =>
          buildCoachReviewDecision(
            projectReviewDecisionPrefix(facts!, event.eventSeq),
            input.execution,
            input.supported,
          ).decision,
      )
    const source = freezeCoachData(
      CoachDecisionSourceSchema.parse({
        reviewContextVersion: 1,
        binding: {
          ownerId: run.ownerId,
          sessionId: run.sessionId,
          handId: run.handId,
          runId: run.runId,
          pokerRuleSetVersion: facts!.pokerRuleSetVersion,
          versions,
        },
        tableSize: facts!.startedHand.participantSeatNumbers.length,
        completedEventSeq: facts!.completedEventSeq,
        heroDecisions: decisions,
      }),
    )
    return Object.freeze({
      source,
      release,
      readHindsightSource() {
        assertActive()
        const snapshot = facts!
        const result = snapshot.result
        const ranks = result.participantHands
          .filter((hand) => hand.handEvaluation !== null)
          .map((hand) => ({
            factId: `rank:${hand.seatNumber}`,
            seatNumber: hand.seatNumber,
            holeCards: hand.holeCards,
            category: hand.handEvaluation!.category,
            comparisonTuple: hand.handEvaluation!.comparisonGrade,
            asOfEventSeq: snapshot.completedEventSeq,
          }))
        const actions = snapshot.events.filter(
          (event) => event.type === 'actionCommitted',
        )
        const returnSeq = snapshot.events.find(
          (event) => event.type === 'uncalledBetReturned',
        )?.eventSeq
        return freezeCoachData(
          HandReviewCaseSchema.parse({
            ...source,
            auditTruth: {
              actualHoleCards: result.participantHands.map((hand) => ({
                seatNumber: hand.seatNumber,
                cards: hand.holeCards,
              })),
              actualBoard: result.board,
              revealedHandRanks: ranks,
              runoutTransitions: actions.flatMap((event) =>
                event.action.progression.streetTransitions
                  .filter((street): street is 'flop' | 'turn' | 'river' =>
                    ['flop', 'turn', 'river'].includes(street),
                  )
                  .map((street) => ({
                    factId: `runout:${event.eventSeq}:${street}`,
                    eventSeq: event.eventSeq,
                    street,
                    board: result.board.slice(
                      0,
                      { flop: 3, turn: 4, river: 5 }[street],
                    ),
                  })),
              ),
              actualContinuation: actions.map((event) => ({
                eventSeq: event.eventSeq,
                street: event.action.before.street,
                seatNumber: event.action.actorSeatNumber,
                action: event.action.command.action,
              })),
              potAwards: result.pots.map((pot) => ({
                factId: `award:${pot.potIndex}`,
                potId: `pot:${pot.potIndex}`,
                eligibleSeats: pot.eligibleSeatNumbers,
                winnerSeats: pot.winningSeatNumbers,
                awards: pot.awards.map((award) => ({
                  seatNumber: award.seatNumber,
                  chips: award.amount,
                })),
              })),
              uncalledReturns: result.uncalledBetReturns.map((value) => ({
                factId: `return:${returnSeq}:${value.seatNumber}`,
                seatNumber: value.seatNumber,
                chips: value.amount,
              })),
              heroNetChips: result.seats.find(
                (seat) => seat.seatNumber === snapshot.heroSeatNumber,
              )!.netChange,
              showdownComparisonsByPot: result.pots
                .filter(
                  (pot) =>
                    pot.eligibleSeatNumbers.length >= 2 &&
                    pot.eligibleSeatNumbers.every((seat) =>
                      ranks.some((rank) => rank.seatNumber === seat),
                    ),
                )
                .map((pot) => ({
                  factId: `comparison:${pot.potIndex}`,
                  potId: `pot:${pot.potIndex}`,
                  eligibleSeats: pot.eligibleSeatNumbers,
                  winnerSeats: pot.winningSeatNumbers,
                  handRankRefs: pot.eligibleSeatNumbers.map(
                    (seat) => `rank:${seat}`,
                  ),
                })),
            },
          }),
        )
      },
    })
  } catch (error) {
    release()
    throw error
  }
}
