import {
  SseEventSchema,
  SessionPathParamsSchema,
} from '@tx-holdem-coach/contracts'
import { streamSSE, type SSEStreamingApi } from 'hono/streaming'
import type { SessionEventStreamService } from '../sessions/public-projection/session-event-stream-service.js'
import { parseLastEventId } from '../sessions/public-projection/session-event-stream-service.js'
import type { OpenSessionEventStream } from '../sessions/public-projection/session-event-connection.js'
import type { ApiHono } from './api-context.js'
import { parseInput } from './request-boundary.js'

const HEARTBEAT_INTERVAL_MS = 15_000

export async function writeBeforeDeadline(input: {
  readonly stream: SSEStreamingApi
  readonly connection: OpenSessionEventStream
  readonly deadlineAt: number
  readonly write: () => Promise<void>
  readonly now: () => number
  readonly setTimer: (callback: () => void, delayMs: number) => unknown
  readonly clearTimer: (handle: unknown) => void
}): Promise<boolean> {
  let timer: unknown
  const deadline = new Promise<false>((resolve) => {
    timer = input.setTimer(
      () => resolve(false),
      Math.max(0, input.deadlineAt - input.now()),
    )
  })
  const completed = input.write().then(() => true as const)
  const written = await Promise.race([completed, deadline])
  if (timer !== undefined) input.clearTimer(timer)
  if (!written) {
    input.connection.close()
    input.stream.abort()
  }
  return written
}

export function registerSessionEventRoutes(
  app: ApiHono,
  service: SessionEventStreamService,
  input?: {
    readonly now?: () => number
    readonly setTimer?: (callback: () => void, delayMs: number) => unknown
    readonly clearTimer?: (handle: unknown) => void
  },
): void {
  const now = input?.now ?? Date.now
  const setTimer =
    input?.setTimer ??
    ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs))
  const clearTimer =
    input?.clearTimer ?? ((handle: unknown) => clearTimeout(handle as never))
  app.get('/api/sessions/:sessionId/events', async (context) => {
    const { sessionId } = parseInput(
      SessionPathParamsSchema,
      context.req.param(),
    )
    const connection = await service.open({
      sessionId,
      lastEventId: parseLastEventId(context.req.header('last-event-id')),
      signal: context.req.raw.signal,
    })
    return streamSSE(context, async (stream) => {
      const abort = () => connection.close()
      stream.onAbort(abort)
      let deadlineAt = now() + HEARTBEAT_INTERVAL_MS
      try {
        while (!connection.closed && !stream.aborted && !stream.closed) {
          const outbound = await connection.waitForOutboundOrHeartbeat({
            heartbeatDeadlineAt: deadlineAt,
          })
          if (outbound.kind === 'closed') break
          const writeDeadlineAt =
            outbound.kind === 'heartbeat'
              ? now() + HEARTBEAT_INTERVAL_MS
              : deadlineAt
          const written = await writeBeforeDeadline({
            stream,
            connection,
            deadlineAt: writeDeadlineAt,
            now,
            setTimer,
            clearTimer,
            write:
              outbound.kind === 'heartbeat'
                ? () => stream.write(': heartbeat\n\n').then(() => undefined)
                : () => {
                    const event = SseEventSchema.parse(outbound.event)
                    return stream.writeSSE({
                      id: String(event.eventSeq),
                      data: JSON.stringify(event),
                    })
                  },
          })
          if (!written) break
          deadlineAt = now() + HEARTBEAT_INTERVAL_MS
        }
      } finally {
        connection.close()
      }
    })
  })
}
