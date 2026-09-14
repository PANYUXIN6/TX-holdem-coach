import { mutationOptions, type QueryClient } from '@tanstack/react-query'
import type {
  PublicSessionSnapshot,
  SessionAiStatusResponse,
} from '@tx-holdem-coach/contracts'
import { ApiError } from '../api/errors.js'
import { keys } from '../query/keys.js'
import { writePolicy } from '../query/client.js'
import type { SessionRuntime } from '../session-sync/runtime.js'

export function aiStatusMatches(
  snapshot: PublicSessionSnapshot | undefined,
  ai: SessionAiStatusResponse | undefined,
): boolean {
  if (
    !snapshot ||
    !ai ||
    snapshot.sessionId !== ai.sessionId ||
    snapshot.stateVersion !== ai.stateVersion ||
    snapshot.eventSeq !== ai.eventSeq ||
    (snapshot.hand?.handId ?? null) !== ai.handId ||
    snapshot.lifecycleStatus !== ai.lifecycleStatus ||
    snapshot.agentRunState !== ai.coordination.state
  )
    return false
  if (ai.coordination.state === 'idle') return snapshot.activeDecision === null
  const run = ai.coordination.run
  return (
    snapshot.hand?.currentActorSeatNumber === run.actorSeatNumber &&
    snapshot.seats.some(
      (seat) =>
        seat.playerId === run.participantId &&
        seat.seatNumber === run.actorSeatNumber &&
        !seat.isUser,
    ) &&
    (ai.coordination.state === 'paused'
      ? snapshot.activeDecision === null
      : snapshot.activeDecision?.decisionRequestId === run.decisionRequestId)
  )
}
export type PauseIntent = {
  scope: string
  sessionId: string
  handId: string
  stateVersion: number
  eventSeq: number
  expectedPausedRunId: string
}
export function pauseIntentMatches(intent: PauseIntent, client: QueryClient) {
  const snapshot = client.getQueryData<PublicSessionSnapshot>(
    keys.session(intent.sessionId),
  )
  const ai = client.getQueryState<SessionAiStatusResponse>(
    keys.sessionAiStatus(intent.sessionId),
  )
  return (
    ai?.status === 'success' &&
    !ai.isInvalidated &&
    ai.fetchStatus !== 'fetching' &&
    aiStatusMatches(snapshot, ai.data) &&
    snapshot?.lifecycleStatus === 'active' &&
    snapshot.pokerPhase === 'inHand' &&
    snapshot.hand?.handId === intent.handId &&
    snapshot.stateVersion === intent.stateVersion &&
    snapshot.eventSeq === intent.eventSeq &&
    ai.data?.coordination.state === 'paused' &&
    ai.data.coordination.run.runId === intent.expectedPausedRunId
  )
}
export function pauseCommandOptions(
  client: QueryClient,
  runtime: SessionRuntime,
  current: (intent: PauseIntent) => boolean,
) {
  return mutationOptions({
    ...writePolicy,
    mutationFn: (intent: PauseIntent, context) => {
      if (
        !current(intent) ||
        !pauseIntentMatches(intent, client) ||
        runtime.getStatus(intent.sessionId) !== 'ready' ||
        runtime.isSubmitting(intent.sessionId) ||
        runtime.pendingOperations(intent.sessionId).length !== 0
      )
        throw new ApiError('input', undefined, 'SESSION_NOT_READY')
      return runtime.commandOptions(intent.sessionId).mutationFn!(
        {
          type: 'retryAgent',
          payload: { expectedPausedRunId: intent.expectedPausedRunId },
        },
        context,
      )
    },
  })
}
