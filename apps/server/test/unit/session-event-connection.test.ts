import { describe, expect, test, vi } from 'vitest'
import { createCommittedSessionEventHub } from '../../src/sessions/public-projection/committed-session-event-hub.js'
import { hashStoredPublicEventPage } from '../../src/sessions/public-projection/public-event-protocol.js'
import { createPendingSessionEventConnection } from '../../src/sessions/public-projection/session-event-connection.js'
import { createSnapshotCalibrationEvent } from '../../src/sessions/public-projection/session-event-stream-service.js'

const sessionId = '22222222-2222-4222-8222-222222222222'

function snapshot(eventSeq: number, stateVersion = 1) {
  return {
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

function event(eventSeq: number, stateVersion = 1) {
  return {
    ...createSnapshotCalibrationEvent({
      snapshot: snapshot(eventSeq, stateVersion),
      eventId: `33333333-3333-4333-8333-${eventSeq.toString().padStart(12, '0')}`,
    }),
    type: 'handStarted' as const,
  }
}

function row(value: ReturnType<typeof event>) {
  return {
    eventId: value.eventId,
    sessionId: value.sessionId,
    eventSeq: value.eventSeq,
    stateVersionAfter: value.stateVersion,
    publicEventPayload: value,
  }
}

describe('session event connection', () => {
  test('heartbeats while the next replay page remains in one pending read', async () => {
    vi.useFakeTimers()
    try {
      const hub = createCommittedSessionEventHub()
      let release!: (rows: readonly ReturnType<typeof row>[]) => void
      const readReplayPage = vi.fn(
        () =>
          new Promise<readonly ReturnType<typeof row>[]>((resolve) => {
            release = resolve
          }),
      )
      const pending = createPendingSessionEventConnection({
        sessionId,
        repository: {
          readHead: async () => null,
          readBootstrap: async () => null,
          readReplayPage,
        },
        subscribe: (listener) => hub.subscribe(sessionId, listener),
      })
      const replayEvent = event(1)
      const connection = pending.activate({
        lifecycleStatus: 'active',
        highWatermark: 1,
        replayProofs: [
          {
            fromEventSeq: 1,
            throughEventSeq: 1,
            eventCount: 1,
            canonicalSha256: hashStoredPublicEventPage([replayEvent]),
          },
        ],
        calibrationEvent: createSnapshotCalibrationEvent({
          snapshot: snapshot(1),
        }),
      })

      const heartbeat = connection.waitForOutboundOrHeartbeat({
        heartbeatDeadlineAt: Date.now() + 15_000,
      })
      await vi.advanceTimersByTimeAsync(15_000)
      await expect(heartbeat).resolves.toEqual({ kind: 'heartbeat' })
      expect(readReplayPage).toHaveBeenCalledOnce()

      release([row(replayEvent)])
      await expect(
        connection.waitForOutboundOrHeartbeat({
          heartbeatDeadlineAt: Date.now() + 15_000,
        }),
      ).resolves.toMatchObject({ kind: 'event', event: { eventSeq: 1 } })
      expect(readReplayPage).toHaveBeenCalledOnce()
      connection.close()
    } finally {
      vi.useRealTimers()
    }
  })

  test('closes on the 65th queued live event without blocking publishers', () => {
    const hub = createCommittedSessionEventHub()
    const diagnostics = vi.fn()
    const pending = createPendingSessionEventConnection({
      sessionId,
      repository: {
        readHead: async () => null,
        readBootstrap: async () => null,
        readReplayPage: async () => null,
      },
      subscribe: (listener) => hub.subscribe(sessionId, listener),
      diagnose: diagnostics,
    })
    for (let eventSeq = 1; eventSeq <= 65; eventSeq += 1) {
      hub.publish([event(eventSeq)])
    }
    expect(pending.overflowed).toBe(true)
    expect(diagnostics).toHaveBeenCalledWith({ category: 'sse_queue_overflow' })
  })

  test('does not start the next page read until the current page is drained', async () => {
    const hub = createCommittedSessionEventHub()
    const events = [event(1), event(2)]
    const readReplayPage = vi.fn(
      async ({ fromEventSeq }: { fromEventSeq: number }) => [
        row(events[fromEventSeq - 1]!),
      ],
    )
    const pending = createPendingSessionEventConnection({
      sessionId,
      repository: {
        readHead: async () => null,
        readBootstrap: async () => null,
        readReplayPage,
      },
      subscribe: (listener) => hub.subscribe(sessionId, listener),
    })
    const connection = pending.activate({
      lifecycleStatus: 'active',
      highWatermark: 2,
      replayProofs: events.map((value) => ({
        fromEventSeq: value.eventSeq,
        throughEventSeq: value.eventSeq,
        eventCount: 1,
        canonicalSha256: hashStoredPublicEventPage([value]),
      })),
      calibrationEvent: createSnapshotCalibrationEvent({
        snapshot: snapshot(2),
      }),
    })

    await Promise.resolve()
    expect(readReplayPage).toHaveBeenCalledTimes(1)
    await expect(
      connection.waitForOutboundOrHeartbeat({
        heartbeatDeadlineAt: Date.now() + 1_000,
      }),
    ).resolves.toMatchObject({ kind: 'event', event: { eventSeq: 1 } })
    expect(readReplayPage).toHaveBeenCalledTimes(1)
    const second = connection.waitForOutboundOrHeartbeat({
      heartbeatDeadlineAt: Date.now() + 1_000,
    })
    await expect(second).resolves.toMatchObject({
      kind: 'event',
      event: { eventSeq: 2 },
    })
    expect(readReplayPage).toHaveBeenCalledTimes(2)
    connection.close()
  })

  test('closes when stateVersion regresses across separate live publish batches', async () => {
    const hub = createCommittedSessionEventHub()
    const diagnostics = vi.fn()
    const pending = createPendingSessionEventConnection({
      sessionId,
      repository: {
        readHead: async () => null,
        readBootstrap: async () => null,
        readReplayPage: async () => null,
      },
      subscribe: (listener) => hub.subscribe(sessionId, listener),
      diagnose: diagnostics,
    })
    const connection = pending.activate({
      lifecycleStatus: 'active',
      highWatermark: 2,
      replayProofs: [],
      calibrationEvent: createSnapshotCalibrationEvent({
        snapshot: snapshot(2, 5),
      }),
    })
    const next = () =>
      connection.waitForOutboundOrHeartbeat({
        heartbeatDeadlineAt: Date.now() + 1_000,
      })

    await expect(next()).resolves.toMatchObject({
      kind: 'event',
      event: { eventSeq: 2, stateVersion: 5 },
    })
    hub.publish([event(3, 5)])
    await expect(next()).resolves.toMatchObject({
      kind: 'event',
      event: { eventSeq: 3, stateVersion: 5 },
    })
    hub.publish([event(4, 4)])

    await expect(next()).resolves.toEqual({ kind: 'closed' })
    expect(connection.closed).toBe(true)
    expect(diagnostics).toHaveBeenCalledWith({ category: 'sse_live_gap' })
  })
})
