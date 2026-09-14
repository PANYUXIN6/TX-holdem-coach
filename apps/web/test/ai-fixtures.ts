import {
  SessionAiStatusResponseSchema,
  type PublicSessionSnapshot,
} from '@tx-holdem-coach/contracts'
import { agentPersonaSummary } from './fixtures.js'
export const pausedRunId = '40000000-0000-4000-8000-000000000001'
export function aiStatusFixture(
  snapshot: PublicSessionSnapshot,
  runId = pausedRunId,
) {
  const actor = snapshot.seats.find(
    (s) => s.seatNumber === snapshot.hand?.currentActorSeatNumber,
  )!
  return SessionAiStatusResponseSchema.parse({
    sessionId: snapshot.sessionId,
    stateVersion: snapshot.stateVersion,
    eventSeq: snapshot.eventSeq,
    handId: snapshot.hand?.handId ?? null,
    lifecycleStatus: snapshot.lifecycleStatus,
    personas: snapshot.seats
      .filter((s) => !s.isUser)
      .map((s) => ({
        participantId: s.playerId,
        seatNumber: s.seatNumber,
        personaId: `historical-${s.seatNumber}`,
        personaVersion: 1,
        configSnapshotKey: 'a'.repeat(64),
        displayName: s.displayName,
        avatarColor: s.avatarColor,
        backgroundDescription: agentPersonaSummary.backgroundDescription,
        teachingSummary: agentPersonaSummary.teachingSummary,
        style: agentPersonaSummary.style,
      })),
    coordination:
      snapshot.agentRunState === 'idle'
        ? { state: 'idle' }
        : {
            state: snapshot.agentRunState,
            run: {
              runId,
              decisionRequestId:
                snapshot.activeDecision?.decisionRequestId ??
                '50000000-0000-4000-8000-000000000001',
              participantId: actor.playerId,
              actorSeatNumber: actor.seatNumber,
              sourceStateVersion: snapshot.stateVersion,
              trigger: 'initial',
              parentRunId: null,
            },
            ...(snapshot.agentRunState === 'paused'
              ? { reasonCode: 'provider_timeout' }
              : {}),
          },
  })
}
export function uniquePlayers(
  snapshot: PublicSessionSnapshot,
): PublicSessionSnapshot {
  return {
    ...snapshot,
    seats: snapshot.seats.map((s) => ({
      ...s,
      playerId: `00000000-0000-4000-8000-${String(s.seatNumber + 1).padStart(12, '0')}`,
    })),
  }
}
