import { describe, expect, test } from 'vitest'
import {
  createSessionCreationIdentityGraph,
  createSessionCreationPlan,
  type SessionCreationIdentityGraph,
} from '../../src/sessions/session-creation/session-creation-consistency.js'

const fixedRandomSource = Object.freeze({ nextInt: () => 0 })

function uuid(group: number, value: number): string {
  return `${group.toString().padStart(8, '0')}-0000-4000-8000-${value
    .toString()
    .padStart(12, '0')}`
}

function identityGraph(aiCount: number): SessionCreationIdentityGraph {
  return {
    sessionId: uuid(1, 1),
    userParticipantId: uuid(2, 1),
    handId: uuid(3, 1),
    agentParticipants: Array.from({ length: aiCount }, (_, index) => ({
      seatNumber: index + 1,
      participantId: uuid(4, index + 1),
    })),
    eventIds: [uuid(5, 1), uuid(5, 2)],
  }
}

describe('session creation consistency', () => {
  test.each([5, 6, 7, 8])(
    'creates an immediately playable %s-agent first-hand plan',
    (aiCount) => {
      const plan = createSessionCreationPlan({
        identityGraph: identityGraph(aiCount),
        randomSource: fixedRandomSource,
      })

      expect(plan.stateBeforeStart).toMatchObject({
        stateVersion: 0,
        completedHandCount: 0,
        lastCompletedHandSummary: null,
        poker: { pokerPhase: 'betweenHands', hand: null },
      })
      expect(plan.finalState).toMatchObject({
        stateVersion: 1,
        completedHandCount: 0,
        lastCompletedHandSummary: null,
        poker: {
          pokerPhase: 'inHand',
          hand: { handId: identityGraph(aiCount).handId, street: 'preflop' },
        },
      })
      expect(plan.startedHand.handNumber).toBe(1)
      expect(plan.startedHand.buttonSeatNumber).toBe(
        plan.stateBeforeStart.poker.buttonSeatNumber,
      )
      expect(plan.startedHand.startingStacks).toEqual(
        Array.from({ length: aiCount + 1 }, (_, seatNumber) => ({
          seatNumber,
          stack: 2_000,
        })),
      )
      expect(plan.stateBeforeStart.seatAccounting).toEqual(
        Array.from({ length: aiCount + 1 }, (_, seatNumber) => ({
          seatNumber,
          cumulativeBuyIn: 2_000,
        })),
      )
      expect(plan.privateEventDrafts.map((event) => event.type)).toEqual([
        'sessionCreated',
        'handStarted',
      ])
    },
  )

  test('normalizes agent order before button selection and dealing', () => {
    const ordered = identityGraph(5)
    const reversed = {
      ...ordered,
      agentParticipants: [...ordered.agentParticipants].reverse(),
    }

    const left = createSessionCreationPlan({
      identityGraph: ordered,
      randomSource: fixedRandomSource,
    })
    const right = createSessionCreationPlan({
      identityGraph: reversed,
      randomSource: fixedRandomSource,
    })

    expect(right).toEqual(left)
  })

  test('rejects duplicate identities before using randomness', () => {
    let randomCalls = 0
    const graph = identityGraph(5)
    const duplicate = {
      ...graph,
      eventIds: [graph.handId, graph.eventIds[1]] as const,
    }

    expect(() =>
      createSessionCreationPlan({
        identityGraph: duplicate,
        randomSource: {
          nextInt() {
            randomCalls += 1
            return 0
          },
        },
      }),
    ).toThrow()
    expect(randomCalls).toBe(0)
  })

  test('generates a complete identity graph from normalized AI seats', () => {
    const generated = Array.from({ length: 10 }, (_, index) =>
      uuid(9, index + 1),
    )
    let calls = 0
    const graph = createSessionCreationIdentityGraph([5, 1, 3, 2, 4], () => {
      const value = generated[calls]
      calls += 1
      if (value === undefined) throw new Error('unexpected UUID request')
      return value
    })

    expect(calls).toBe(10)
    expect(graph.agentParticipants.map((agent) => agent.seatNumber)).toEqual([
      1, 2, 3, 4, 5,
    ])
    expect(
      new Set([
        graph.sessionId,
        graph.userParticipantId,
        graph.handId,
        ...graph.agentParticipants.map((agent) => agent.participantId),
        ...graph.eventIds,
      ]).size,
    ).toBe(10)
  })
})
