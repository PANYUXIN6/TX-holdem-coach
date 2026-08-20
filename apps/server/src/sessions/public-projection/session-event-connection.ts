import { SseEventSchema, type SseEvent } from '@tx-holdem-coach/contracts'
import type {
  PublicEventReplayRepository,
  ReplayPageProof,
} from './public-event-replay.js'
import {
  decodeStoredPublicEvent,
  hashStoredPublicEventPage,
} from './public-event-protocol.js'

const LIVE_QUEUE_CAPACITY = 64

export type OutboundOrHeartbeatResult =
  | { readonly kind: 'event'; readonly event: SseEvent }
  | { readonly kind: 'heartbeat' }
  | { readonly kind: 'closed' }

export interface OpenSessionEventStream {
  readonly closed: boolean
  waitForOutboundOrHeartbeat(input: {
    readonly heartbeatDeadlineAt: number
  }): Promise<OutboundOrHeartbeatResult>
  close(): void
}

export type SessionEventStreamDiagnostic =
  | {
      readonly category: 'sse_live_gap' | 'sse_queue_overflow'
    }
  | {
      readonly category: 'sse_stream_failed'
      readonly reason?: 'replayPageChanged'
    }

interface SessionEventConnectionInput {
  readonly sessionId: string
  readonly repository: PublicEventReplayRepository
  readonly subscribe: (listener: (event: SseEvent) => void) => () => void
  readonly signal?: AbortSignal
  readonly now?: () => number
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
  readonly diagnose?: (diagnostic: SessionEventStreamDiagnostic) => void
}

export interface PendingSessionEventConnection {
  readonly overflowed: boolean
  readonly failed: boolean
  activate(input: {
    readonly lifecycleStatus: 'active' | 'ended'
    readonly highWatermark: number
    readonly replayProofs: readonly ReplayPageProof[]
    readonly calibrationEvent: SseEvent
  }): OpenSessionEventStream
  close(): void
}

function decodeReplayPage(input: {
  readonly rows: Awaited<
    ReturnType<PublicEventReplayRepository['readReplayPage']>
  >
  readonly proof: ReplayPageProof
  readonly sessionId: string
}): readonly SseEvent[] | null {
  if (input.rows === null || input.rows.length !== input.proof.eventCount) {
    return null
  }
  const events: SseEvent[] = []
  let previousStateVersion = -1
  for (const [index, row] of input.rows.entries()) {
    const decoded = decodeStoredPublicEvent(row)
    const expectedEventSeq = input.proof.fromEventSeq + index
    if (
      decoded.kind !== 'decoded' ||
      decoded.event.sessionId.toLowerCase() !== input.sessionId.toLowerCase() ||
      decoded.event.eventSeq !== expectedEventSeq ||
      decoded.event.stateVersion < previousStateVersion
    ) {
      return null
    }
    previousStateVersion = decoded.event.stateVersion
    events.push(decoded.event)
  }
  if (
    events.at(-1)?.eventSeq !== input.proof.throughEventSeq ||
    hashStoredPublicEventPage(events) !== input.proof.canonicalSha256
  ) {
    return null
  }
  return Object.freeze(events)
}

export function createPendingSessionEventConnection(
  input: SessionEventConnectionInput,
): PendingSessionEventConnection {
  const now = input.now ?? Date.now
  const setTimer =
    input.setTimer ??
    ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs))
  const clearTimer =
    input.clearTimer ?? ((handle: unknown) => clearTimeout(handle as never))
  let closed = false
  let overflowed = false
  let failed = false
  let unsubscribe: (() => void) | undefined
  let waitingResolve: (() => void) | undefined
  let proofIndex = 0
  let page: readonly SseEvent[] | null = null
  let pageIndex = 0
  let pageRead: Promise<void> | null = null
  let startNextPageAfterDelivery = false
  let replayFailed = false
  let activated = false
  let lifecycleStatus: 'active' | 'ended' = 'active'
  let replayProofs: readonly ReplayPageProof[] = []
  let calibrationEvent: SseEvent | null = null
  let calibrationPending = false
  let deliveredThrough = -1
  let deliveredStateVersion = -1
  let closeAfterDelivery = false
  const liveQueue: SseEvent[] = []
  let removeAbortListener: () => void = () => undefined

  const wake = () => waitingResolve?.()
  const close = () => {
    if (closed) return
    closed = true
    removeAbortListener()
    unsubscribe?.()
    unsubscribe = undefined
    page = null
    replayProofs = []
    calibrationEvent = null
    liveQueue.length = 0
    wake()
  }
  const fail = (diagnostic: SessionEventStreamDiagnostic) => {
    if (diagnostic.category === 'sse_queue_overflow') overflowed = true
    else failed = true
    close()
    try {
      input.diagnose?.(diagnostic)
    } catch {
      // Diagnostics must not escape or compromise connection cleanup.
    }
  }
  const listener = (rawEvent: SseEvent) => {
    if (closed) return
    const event = SseEventSchema.safeParse(rawEvent)
    if (!event.success) {
      fail({ category: 'sse_live_gap' })
      return
    }
    if (liveQueue.length >= LIVE_QUEUE_CAPACITY) {
      fail({ category: 'sse_queue_overflow' })
      return
    }
    liveQueue.push(event.data)
    wake()
  }
  unsubscribe = input.subscribe(listener)
  if (input.signal !== undefined) {
    const abort = () => close()
    input.signal.addEventListener('abort', abort, { once: true })
    removeAbortListener = () =>
      input.signal?.removeEventListener('abort', abort)
    if (input.signal.aborted) close()
  }

  const startPageRead = () => {
    const proof = replayProofs[proofIndex]
    if (closed || proof === undefined || pageRead !== null || page !== null) {
      return
    }
    pageRead = input.repository
      .readReplayPage({
        sessionId: input.sessionId,
        fromEventSeq: proof.fromEventSeq,
        throughEventSeq: proof.throughEventSeq,
      })
      .then((rows) => {
        if (closed) return
        const decoded = decodeReplayPage({
          rows,
          proof,
          sessionId: input.sessionId,
        })
        if (decoded === null) {
          replayFailed = true
          return
        }
        page = decoded
        pageIndex = 0
      })
      .catch(() => {
        if (!closed) replayFailed = true
      })
      .finally(() => {
        pageRead = null
        wake()
      })
  }

  const nextEvent = (): SseEvent | null => {
    if (closed) return null
    if (closeAfterDelivery) {
      close()
      return null
    }
    if (startNextPageAfterDelivery) {
      startNextPageAfterDelivery = false
      startPageRead()
    }
    if (replayFailed) {
      fail({ category: 'sse_stream_failed', reason: 'replayPageChanged' })
      return null
    }
    if (page !== null) {
      const event = page[pageIndex]
      if (event !== undefined) {
        pageIndex += 1
        if (pageIndex === page.length) {
          page = null
          pageIndex = 0
          proofIndex += 1
          startNextPageAfterDelivery = true
        }
        deliveredStateVersion = event.stateVersion
        return event
      }
    }
    if (proofIndex < replayProofs.length || pageRead !== null) return null
    if (calibrationPending) {
      calibrationPending = false
      if (lifecycleStatus === 'ended') closeAfterDelivery = true
      deliveredStateVersion = calibrationEvent!.stateVersion
      return calibrationEvent!
    }
    while (liveQueue.length > 0) {
      const event = liveQueue.shift()!
      if (event.eventSeq <= deliveredThrough) continue
      if (
        event.eventSeq !== deliveredThrough + 1 ||
        event.stateVersion < deliveredStateVersion
      ) {
        fail({ category: 'sse_live_gap' })
        return null
      }
      deliveredThrough = event.eventSeq
      deliveredStateVersion = event.stateVersion
      if (
        event.type === 'sessionEnded' ||
        event.payload.snapshot.lifecycleStatus === 'ended'
      ) {
        closeAfterDelivery = true
      }
      return event
    }
    return null
  }

  const connection: OpenSessionEventStream = {
    get closed() {
      return closed
    },
    async waitForOutboundOrHeartbeat({ heartbeatDeadlineAt }) {
      if (now() >= heartbeatDeadlineAt) return { kind: 'heartbeat' }
      const available = nextEvent()
      if (available !== null) return { kind: 'event', event: available }
      if (closed) return { kind: 'closed' }

      return new Promise<OutboundOrHeartbeatResult>((resolve) => {
        let settled = false
        let timer: unknown
        const settle = (result: OutboundOrHeartbeatResult) => {
          if (settled) return
          settled = true
          if (timer !== undefined) clearTimer(timer)
          if (waitingResolve === onWake) waitingResolve = undefined
          resolve(result)
        }
        const onWake = () => {
          if (closed) {
            settle({ kind: 'closed' })
            return
          }
          if (now() >= heartbeatDeadlineAt) {
            settle({ kind: 'heartbeat' })
            return
          }
          const event = nextEvent()
          if (event !== null) settle({ kind: 'event', event })
          else if (closed) settle({ kind: 'closed' })
        }
        waitingResolve = onWake
        timer = setTimer(
          () => settle({ kind: 'heartbeat' }),
          Math.max(0, heartbeatDeadlineAt - now()),
        )
        onWake()
      })
    },
    close,
  }
  return Object.freeze({
    get overflowed() {
      return overflowed
    },
    get failed() {
      return failed
    },
    activate(configuration: {
      readonly lifecycleStatus: 'active' | 'ended'
      readonly highWatermark: number
      readonly replayProofs: readonly ReplayPageProof[]
      readonly calibrationEvent: SseEvent
    }) {
      if (activated || closed) throw new Error('SSE 连接无法激活。')
      activated = true
      lifecycleStatus = configuration.lifecycleStatus
      deliveredThrough = configuration.highWatermark
      replayProofs = configuration.replayProofs
      calibrationEvent = configuration.calibrationEvent
      calibrationPending = true
      startPageRead()
      return Object.freeze(connection)
    },
    close,
  })
}
