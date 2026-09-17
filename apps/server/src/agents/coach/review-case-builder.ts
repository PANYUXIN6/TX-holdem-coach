import { isDeepStrictEqual } from 'node:util'
import {
  createInitialBettingProjection,
  createCommittedActionProof,
  getProjectedLegalActions,
  projectBettingTransition,
  projectActionContinuation,
  type BettingProjectionState,
} from '../../poker/betting-projection.js'
import { DecisionAnalysisInputSchema } from '../../poker/decision-analysis-input-schema.js'
import type { DecisionAnalysisPublicAction } from '../../poker/decision-analysis-input.js'
import { assignLogicalPositions } from '../../poker/positioning.js'
import type {
  ReviewDecisionPrefix,
  ReviewActionBefore,
} from '../../sessions/hand-history/completed-hand-review-source.js'
import {
  assertAuthenticatedRunRead,
  type AuthenticatedRunRead,
} from '../foundation/run-read-authentication.js'
import {
  readCoachPolicyVersions,
  type CoachPolicyVersions,
} from './policy-versions.js'
import { CoachDecisionInputSchema, freezeCoachData } from './review-case.js'
import {
  projectCoachLegalActions,
  projectCoachVisibleState,
  type CoachStreetStartState,
} from './analysis-input.js'

function requireSame(actual: unknown, expected: unknown): void {
  if (!isDeepStrictEqual(actual, expected))
    throw new TypeError('coach_replay_mismatch')
}
function assertBefore(
  state: BettingProjectionState,
  board: ReviewDecisionPrefix['board'],
  action: ReviewActionBefore,
): void {
  requireSame(action.before, {
    street: state.street,
    board,
    currentActorSeatNumber: state.currentActorSeatNumber,
    pot: state.pot,
    seats: state.seats,
  })
  requireSame(action.actorSeatNumber, state.currentActorSeatNumber)
  requireSame(action.legalActionsBefore, getProjectedLegalActions(state))
  projectBettingTransition(
    state,
    createCommittedActionProof(action.command, action.legalActionsBefore),
  )
}
/** One prefix only: no result, opponent cards, future actions, or audit access capability. */
export function buildCoachReviewDecision(
  prefix: ReviewDecisionPrefix,
  execution: AuthenticatedRunRead,
  supported: CoachPolicyVersions,
) {
  assertAuthenticatedRunRead(execution)
  const run = execution.run
  if (
    prefix.ownerId !== run.ownerId ||
    prefix.sessionId !== run.sessionId ||
    prefix.handId !== run.handId ||
    prefix.heroSeatNumber !== 0
  )
    throw new TypeError('coach_source_run_mismatch')
  const versions = readCoachPolicyVersions(
    run.runConfiguration.dataDependencies,
    supported,
  )
  requireSame(
    [...prefix.startedHand.positions].sort(
      (a, b) => a.seatNumber - b.seatNumber,
    ),
    [
      ...assignLogicalPositions(
        prefix.startedHand.buttonSeatNumber,
        prefix.startedHand.participantSeatNumbers,
      ),
    ].sort((a, b) => a.seatNumber - b.seatNumber),
  )
  let state = createInitialBettingProjection(prefix.startedHand)
  let board: ReviewDecisionPrefix['board'] = []
  let streetStartState: CoachStreetStartState = {
    status: 'notApplicable',
    reasonCode: 'preflop',
  }
  const publicActions: DecisionAnalysisPublicAction[] = []
  let lastSeq: number | undefined
  for (const event of prefix.events) {
    if (
      event.eventSeq >= prefix.target.eventSeq ||
      (lastSeq !== undefined && event.eventSeq !== lastSeq + 1)
    )
      throw new TypeError('coach_invalid_prefix_sequence')
    lastSeq = event.eventSeq
    if (event.type === 'handStarted') {
      if (event !== prefix.events[0])
        throw new TypeError('coach_duplicate_start')
      continue
    }
    if (event.type === 'coordination') continue
    if (event.type !== 'actionCommitted')
      throw new TypeError('coach_decision_after_completion')
    assertBefore(state, board, event.action)
    const transition = projectBettingTransition(
      state,
      createCommittedActionProof(
        event.action.command,
        event.action.legalActionsBefore,
      ),
    )
    const { state: _state, ...evidence } = transition
    publicActions.push({
      eventSeq: event.eventSeq,
      streetBefore: state.street,
      ...evidence,
    })
    const continuation = projectActionContinuation(
      transition.state,
      transition.actorSeatNumber,
    )
    if (
      continuation.kind !== 'sameStreet' &&
      continuation.kind !== 'nextStreet'
    )
      throw new TypeError('coach_decision_after_completion')
    state = continuation.state
    const count = { preflop: 0, flop: 3, turn: 4, river: 5 }[state.street]
    const nextBoard = prefix.board.slice(0, count)
    requireSame(
      event.action.progression.boardCardsAdded,
      nextBoard.slice(board.length),
    )
    requireSame(
      event.action.progression.streetTransitions,
      continuation.kind === 'nextStreet' ? [state.street] : [],
    )
    requireSame(event.action.progression.terminationReason, null)
    requireSame(event.action.after, {
      street: state.street,
      board: nextBoard,
      currentActorSeatNumber: state.currentActorSeatNumber,
      pot: state.pot,
      seats: state.seats,
    })
    board = nextBoard
    if (continuation.kind === 'nextStreet') {
      if (state.street === 'preflop')
        throw new TypeError('coach_invalid_street_transition')
      streetStartState = {
        status: 'available',
        street: state.street,
        eventSeq: event.eventSeq,
        pot: state.pot,
        seats: state.seats.map((seat) => ({ ...seat })),
      }
    }
  }
  if (
    prefix.events[0]?.type !== 'handStarted' ||
    lastSeq !== prefix.target.eventSeq - 1 ||
    state.currentActorSeatNumber !== prefix.heroSeatNumber
  )
    throw new TypeError('coach_invalid_decision_prefix')
  assertBefore(state, board, prefix.target)
  const analysisInput = DecisionAnalysisInputSchema.parse({
    pokerRuleSetVersion: prefix.pokerRuleSetVersion,
    buttonSeatNumber: prefix.startedHand.buttonSeatNumber,
    participantSeatNumbers: prefix.startedHand.participantSeatNumbers,
    heroSeatNumber: prefix.heroSeatNumber,
    street: state.street,
    positions: prefix.startedHand.positions,
    startingStacks: prefix.startedHand.startingStacks,
    smallBlindSeatNumber: prefix.startedHand.smallBlindSeatNumber,
    bigBlindSeatNumber: prefix.startedHand.bigBlindSeatNumber,
    heroHoleCards: prefix.heroHoleCards,
    board,
    pot: state.pot,
    seats: state.seats,
    bettingRound: state.bettingRound,
    legalActions: getProjectedLegalActions(state),
    publicActions,
  })
  const visibleState = projectCoachVisibleState(analysisInput)
  return freezeCoachData(
    CoachDecisionInputSchema.parse({
      reviewContextVersion: 1,
      binding: {
        ownerId: run.ownerId,
        sessionId: run.sessionId,
        handId: run.handId,
        runId: run.runId,
        pokerRuleSetVersion: prefix.pokerRuleSetVersion,
        versions,
      },
      tableSize: prefix.startedHand.participantSeatNumbers.length,
      decision: {
        decisionId: `${run.handId}:${state.street}:${prefix.target.eventSeq}`,
        eventSeq: prefix.target.eventSeq,
        stateVersion: prefix.target.stateVersionBefore,
        street: state.street,
        logicalPosition: prefix.startedHand.positions.find(
          (position) => position.seatNumber === prefix.heroSeatNumber,
        )!.position,
        visibleState,
        analysisInput,
        streetStartState,
        legalActions: projectCoachLegalActions(analysisInput),
        actualAction: prefix.target.command.action,
        stacksAndContributions: visibleState.seats,
        opponentEvidenceSubjects: prefix.personas
          .filter((persona) =>
            state.seats.some(
              (seat) =>
                seat.seatNumber === persona.seatNumber &&
                (seat.status === 'active' || seat.status === 'allIn'),
            ),
          )
          .map((persona) => ({
            seatNumber: persona.seatNumber,
            personaSnapshotId: `${persona.participantId}:${persona.configSnapshotKey}`,
          })),
        opponentEvidenceCutoff: {
          sessionId: run.sessionId,
          asOfEventSeq: prefix.target.eventSeq - 1,
        },
      },
    }),
  )
}
