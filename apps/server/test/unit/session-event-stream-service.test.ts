import type { SseEvent } from '@tx-holdem-coach/contracts'
import { describe, expect, test, vi } from 'vitest'
import { createCommittedSessionEventHub } from '../../src/sessions/public-projection/committed-session-event-hub.js'
import type { PublicEventReplayRepository } from '../../src/sessions/public-projection/public-event-replay.js'
import {
  createSessionEventStreamService,
  createSnapshotCalibrationEvent,
  parseLastEventId,
} from '../../src/sessions/public-projection/session-event-stream-service.js'
import { createPrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'
import { createTestPokerState } from '../poker/create-test-poker-state.js'

const sessionId = '22222222-2222-4222-8222-222222222222'

function snapshot(eventSeq: number, stateVersion = 1) {
  return {
    protocolVersion: 1 as const,
    sessionId,
    stateVersion,
    eventSeq,
    pokerPhase: 'betweenHands' as const,
    lifecycleStatus: 'active' as const,
    agentRunState: 'idle' as const,
    activeDecision: null,
    seats: Array.from({ length: 6 }, (_, seatNumber) => ({
      seatNumber,
      playerId: `66666666-6666-4666-8666-${seatNumber.toString().padStart(12, '0')}`,
      displayName: seatNumber === 0 ? '玩家' : `AI ${seatNumber}`,
      avatarColor: '#0f766e',
      isUser: seatNumber === 0,
      stack: 2_000,
      status: 'active' as const,
    })),
    hand: null,
    lastCompletedHandSummary: null,
  }
}

function storedEvent(eventSeq: number): SseEvent {
  return {
    ...createSnapshotCalibrationEvent({
      snapshot: snapshot(eventSeq),
      eventId: `33333333-3333-4333-8333-${eventSeq.toString().padStart(12, '0')}`,
    }),
    type: 'handStarted',
  }
}

function repository(highWatermark = 2) {
  const poker = createTestPokerState()
  const state = createPrivateTableState({
    stateVersion: 1,
    poker,
    completedHandCount: 0,
    seatAccounting: poker.seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      cumulativeBuyIn: 2_000,
    })),
    lastCompletedHandSummary: null,
  })
  const events = Array.from({ length: highWatermark + 1 }, (_, eventSeq) =>
    storedEvent(eventSeq),
  )
  const readReplayPage = vi.fn(async ({ fromEventSeq, throughEventSeq }) =>
    events.slice(fromEventSeq, throughEventSeq + 1).map((event) => ({
      eventId: event.eventId,
      sessionId: event.sessionId,
      eventSeq: event.eventSeq,
      stateVersionAfter: event.stateVersion,
      protocolVersion: event.protocolVersion,
      publicEventPayload: event,
    })),
  )
  return {
    value: {
      readHead: async () => ({
        sessionId,
        lifecycleStatus: 'active' as const,
        highWatermark,
      }),
      readBootstrap: async () => ({
        kind: 'ready' as const,
        facts: {
          state,
          session: {
            sessionId,
            lifecycleStatus: 'active' as const,
            endedAt: null,
            stateVersion: 1,
            nextEventSeq: highWatermark + 1,
            currentHandId: null,
            diagnosticCode: null,
            diagnosedAt: null,
            agentRunState: 'idle' as const,
            activePlayerRunId: null,
            activeDecisionRequestId: null,
          },
          eventSeq: highWatermark,
          newPrivateEvents: [],
          roster: poker.seats.map((seat) =>
            seat.isUser
              ? {
                  seatNumber: 0 as const,
                  playerId: seat.playerId,
                  isUser: true as const,
                }
              : {
                  seatNumber: seat.seatNumber,
                  playerId: seat.playerId,
                  isUser: false as const,
                  displayName: `AI ${seat.seatNumber}`,
                  avatarColor: '#0F766E',
                },
          ),
          committedCurrentHandEvents: [],
        },
        highWatermark,
        totalEventCount: highWatermark + 1,
        minimumEventSeq: 0,
        maximumEventSeq: highWatermark,
      }),
      readReplayPage,
    } satisfies PublicEventReplayRepository,
    readReplayPage,
  }
}

describe('session event stream service', () => {
  test.each([
    [undefined, { kind: 'absent' }],
    ['0', { kind: 'candidate', eventSeq: 0 }],
    ['01', { kind: 'invalid', reason: 'invalidFormat' }],
    ['-1', { kind: 'invalid', reason: 'negative' }],
    ['9007199254740992', { kind: 'invalid', reason: 'unsafeInteger' }],
  ])('parses Last-Event-ID %j', (value, expected) => {
    expect(parseLastEventId(value)).toEqual(expected)
  })

  test('replays the fixed window, calibrates, then consumes live events', async () => {
    const fixture = repository()
    const hub = createCommittedSessionEventHub()
    const service = createSessionEventStreamService({
      repository: fixture.value,
      hub,
      nextEventId: () => '99999999-9999-4999-8999-999999999999',
    })
    const connection = await service.open({
      sessionId,
      lastEventId: { kind: 'candidate', eventSeq: 0 },
    })
    const next = () =>
      connection.waitForOutboundOrHeartbeat({
        heartbeatDeadlineAt: Date.now() + 1_000,
      })
    await expect(next()).resolves.toMatchObject({
      kind: 'event',
      event: { eventSeq: 1 },
    })
    await expect(next()).resolves.toMatchObject({
      kind: 'event',
      event: { eventSeq: 2 },
    })
    await expect(next()).resolves.toMatchObject({
      kind: 'event',
      event: { type: 'snapshot', eventSeq: 2 },
    })
    hub.publish([storedEvent(3)])
    await expect(next()).resolves.toMatchObject({
      kind: 'event',
      event: { eventSeq: 3 },
    })
    expect(fixture.readReplayPage).toHaveBeenCalledTimes(2)
    connection.close()
  })

  test('uses only calibration for absent and invalid cursors', async () => {
    for (const lastEventId of [
      parseLastEventId(undefined),
      parseLastEventId('invalid'),
    ]) {
      const fixture = repository()
      const service = createSessionEventStreamService({
        repository: fixture.value,
        hub: createCommittedSessionEventHub(),
      })
      const connection = await service.open({ sessionId, lastEventId })
      await expect(
        connection.waitForOutboundOrHeartbeat({
          heartbeatDeadlineAt: Date.now() + 1_000,
        }),
      ).resolves.toMatchObject({
        kind: 'event',
        event: { type: 'snapshot', eventSeq: 2 },
      })
      expect(fixture.readReplayPage).not.toHaveBeenCalled()
      connection.close()
    }
  })

  test('prevalidates and rereads every page without truncating the replay window', async () => {
    const fixture = repository(129)
    const service = createSessionEventStreamService({
      repository: fixture.value,
      hub: createCommittedSessionEventHub(),
    })
    const connection = await service.open({
      sessionId,
      lastEventId: { kind: 'candidate', eventSeq: 0 },
    })
    const received: Array<{ eventSeq: number; type: string }> = []
    for (let index = 0; index < 130; index += 1) {
      const outbound = await connection.waitForOutboundOrHeartbeat({
        heartbeatDeadlineAt: Date.now() + 1_000,
      })
      if (outbound.kind !== 'event') throw new Error('expected event')
      received.push({
        eventSeq: outbound.event.eventSeq,
        type: outbound.event.type,
      })
    }
    expect(received.at(0)).toEqual({ eventSeq: 1, type: 'handStarted' })
    expect(received.at(-2)).toEqual({ eventSeq: 129, type: 'handStarted' })
    expect(received.at(-1)).toEqual({ eventSeq: 129, type: 'snapshot' })
    expect(fixture.readReplayPage).toHaveBeenCalledTimes(4)
    expect(fixture.readReplayPage.mock.calls.map(([range]) => range)).toEqual([
      { sessionId, fromEventSeq: 1, throughEventSeq: 128 },
      { sessionId, fromEventSeq: 129, throughEventSeq: 129 },
      { sessionId, fromEventSeq: 1, throughEventSeq: 128 },
      { sessionId, fromEventSeq: 129, throughEventSeq: 129 },
    ])
    connection.close()
  })

  test('stops replay prevalidation and unsubscribes when initialization is aborted', async () => {
    const fixture = repository(129)
    const firstPage = await fixture.value.readReplayPage({
      sessionId,
      fromEventSeq: 1,
      throughEventSeq: 128,
    })
    let releaseFirstPage!: () => void
    fixture.readReplayPage.mockReset()
    fixture.readReplayPage.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseFirstPage = () => resolve(firstPage)
        }),
    )
    const unsubscribe = vi.fn()
    const service = createSessionEventStreamService({
      repository: fixture.value,
      hub: {
        publish: vi.fn(),
        subscribe: vi.fn(() => unsubscribe),
      },
    })
    const controller = new AbortController()
    const opened = service.open({
      sessionId,
      lastEventId: { kind: 'candidate', eventSeq: 0 },
      signal: controller.signal,
    })
    await vi.waitFor(() =>
      expect(fixture.readReplayPage).toHaveBeenCalledOnce(),
    )

    controller.abort()
    expect(unsubscribe).toHaveBeenCalledOnce()
    releaseFirstPage()

    await expect(opened).rejects.toMatchObject({ name: 'AbortError' })
    expect(fixture.readReplayPage).toHaveBeenCalledOnce()
  })
})
