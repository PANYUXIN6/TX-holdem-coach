import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  initializePokerTable,
  startPokerHand,
} from '../../poker/poker-engine.js'
import type { RandomSource } from '../../poker/random-source.js'
import type { StartedHandFacts } from '../../poker/hand-result.js'
import {
  createPrivateEventV2,
  type PrivateEventV2,
} from '../authoritative-state/private-event-v2.js'
import {
  createPrivateTableState,
  type PrivateTableState,
} from '../authoritative-state/private-table-state.js'
import {
  createHandStartCheckpointV1,
  type HandStartCheckpointV1,
} from '../hand-audit/hand-start-checkpoint.js'

const IdentityGraphSchema = z.strictObject({
  sessionId: z.uuid().transform((value) => value.toLowerCase()),
  userParticipantId: z.uuid().transform((value) => value.toLowerCase()),
  handId: z.uuid().transform((value) => value.toLowerCase()),
  agentParticipants: z
    .array(
      z.strictObject({
        seatNumber: z.number().int().min(1).max(8),
        participantId: z.uuid().transform((value) => value.toLowerCase()),
      }),
    )
    .min(5)
    .max(8),
  eventIds: z.tuple([
    z.uuid().transform((value) => value.toLowerCase()),
    z.uuid().transform((value) => value.toLowerCase()),
  ]),
})

export class SessionCreationInvariantError extends Error {
  public constructor() {
    super('场次创建事实不一致。')
    this.name = 'SessionCreationInvariantError'
  }
}

export interface SessionCreationIdentityGraph {
  readonly sessionId: string
  readonly userParticipantId: string
  readonly handId: string
  readonly agentParticipants: readonly {
    readonly seatNumber: number
    readonly participantId: string
  }[]
  readonly eventIds: readonly [string, string]
}

export interface SessionCreationPlanInput {
  readonly identityGraph: SessionCreationIdentityGraph
  readonly randomSource: RandomSource
}

export interface SessionCreationPlan {
  readonly identityGraph: SessionCreationIdentityGraph
  readonly stateBeforeStart: PrivateTableState
  readonly checkpoint: HandStartCheckpointV1
  readonly startedHand: StartedHandFacts
  readonly finalState: PrivateTableState
  readonly privateEventDrafts: readonly [PrivateEventV2, PrivateEventV2]
}

export function createSessionCreationIdentityGraph(
  aiSeatNumbers: readonly number[],
  nextUuid: () => string = randomUUID,
): SessionCreationIdentityGraph {
  const parsedSeats = z
    .array(z.number().int().min(1).max(8))
    .min(5)
    .max(8)
    .safeParse(aiSeatNumbers)
  if (
    !parsedSeats.success ||
    new Set(parsedSeats.data).size !== parsedSeats.data.length ||
    typeof nextUuid !== 'function'
  ) {
    throw new SessionCreationInvariantError()
  }
  const normalizedSeats = [...parsedSeats.data].sort(
    (left, right) => left - right,
  )
  const candidate = {
    sessionId: nextUuid(),
    userParticipantId: nextUuid(),
    handId: nextUuid(),
    agentParticipants: normalizedSeats.map((seatNumber) => ({
      seatNumber,
      participantId: nextUuid(),
    })),
    eventIds: [nextUuid(), nextUuid()] as const,
  }
  const parsed = IdentityGraphSchema.safeParse(candidate)
  if (!parsed.success) {
    throw new SessionCreationInvariantError()
  }
  const identifiers = [
    parsed.data.sessionId,
    parsed.data.userParticipantId,
    parsed.data.handId,
    ...parsed.data.agentParticipants.map(
      (participant) => participant.participantId,
    ),
    ...parsed.data.eventIds,
  ]
  if (new Set(identifiers).size !== identifiers.length) {
    throw new SessionCreationInvariantError()
  }
  return Object.freeze({
    ...parsed.data,
    agentParticipants: Object.freeze(
      parsed.data.agentParticipants.map((participant) =>
        Object.freeze(participant),
      ),
    ),
    eventIds: Object.freeze(parsed.data.eventIds) as readonly [string, string],
  })
}

export function createSessionCreationPlan(
  input: SessionCreationPlanInput,
): SessionCreationPlan {
  const parsed = IdentityGraphSchema.safeParse(input.identityGraph)
  if (!parsed.success || typeof input.randomSource?.nextInt !== 'function') {
    throw new SessionCreationInvariantError()
  }

  const graph = parsed.data
  const identifiers = [
    graph.sessionId,
    graph.userParticipantId,
    graph.handId,
    ...graph.agentParticipants.map((participant) => participant.participantId),
    ...graph.eventIds,
  ]
  const seatNumbers = graph.agentParticipants.map(
    (participant) => participant.seatNumber,
  )
  if (
    new Set(identifiers).size !== identifiers.length ||
    new Set(seatNumbers).size !== seatNumbers.length
  ) {
    throw new SessionCreationInvariantError()
  }

  try {
    const normalizedAgents = [...graph.agentParticipants]
      .sort((left, right) => left.seatNumber - right.seatNumber)
      .map((participant) => Object.freeze(participant))
    const normalizedIdentityGraph = Object.freeze({
      sessionId: graph.sessionId,
      userParticipantId: graph.userParticipantId,
      handId: graph.handId,
      agentParticipants: Object.freeze(normalizedAgents),
      eventIds: Object.freeze(graph.eventIds) as readonly [string, string],
    })
    const seats = [
      { seatNumber: 0, participantId: graph.userParticipantId },
      ...normalizedAgents,
    ].map((participant) => ({
      seatNumber: participant.seatNumber,
      playerId: participant.participantId,
      isUser: participant.seatNumber === 0,
      stack: 2_000,
      status: 'active' as const,
      streetContribution: 0,
      totalContribution: 0,
    }))
    const initializedPoker = initializePokerTable(seats, input.randomSource)
    const seatAccounting = seats.map(({ seatNumber }) => ({
      seatNumber,
      cumulativeBuyIn: 2_000,
    }))
    const stateBeforeStart = createPrivateTableState({
      stateVersion: 0,
      poker: initializedPoker,
      completedHandCount: 0,
      seatAccounting,
      lastCompletedHandSummary: null,
    })
    const startResult = startPokerHand(initializedPoker, {
      handId: graph.handId,
      completedHandCountBeforeStart: 0,
      randomSource: input.randomSource,
    })
    const checkpoint = createHandStartCheckpointV1({
      stateBeforeStartCommand: stateBeforeStart,
      startedHand: startResult.startedHand,
    })
    const finalState = createPrivateTableState({
      stateVersion: 1,
      poker: startResult.state,
      completedHandCount: 0,
      seatAccounting,
      lastCompletedHandSummary: null,
    })
    const sessionCreated = createPrivateEventV2({
      type: 'sessionCreated',
      initialBuyIns: seats.map(({ seatNumber }) => ({
        seatNumber,
        amount: 2_000,
      })),
    })
    const handStartedDraft = startResult.eventDrafts[0]
    if (
      startResult.eventDrafts.length !== 1 ||
      handStartedDraft?.type !== 'handStarted' ||
      startResult.startedHand.handId !== graph.handId ||
      finalState.poker.hand?.handId !== graph.handId ||
      startResult.startedHand.buttonSeatNumber !==
        stateBeforeStart.poker.buttonSeatNumber
    ) {
      throw new SessionCreationInvariantError()
    }
    const handStarted = createPrivateEventV2(handStartedDraft)
    const privateEventDrafts = Object.freeze([
      sessionCreated,
      handStarted,
    ]) as readonly [PrivateEventV2, PrivateEventV2]

    return Object.freeze({
      identityGraph: normalizedIdentityGraph,
      stateBeforeStart,
      checkpoint,
      startedHand: startResult.startedHand,
      finalState,
      privateEventDrafts,
    })
  } catch (error) {
    if (error instanceof SessionCreationInvariantError) {
      throw error
    }
    throw new SessionCreationInvariantError()
  }
}
