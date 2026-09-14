// 可复位的内存 HTTP/SSE 服务；全部响应经过生产 API 与 SSE Codec。
import {
  PublicSessionSnapshotSchema,
  type PublicSessionSnapshot,
} from '@tx-holdem-coach/contracts'
import { ids, publicSnapshot } from './fixtures.js'
import { aiStatusFixture, uniquePlayers } from './ai-fixtures.js'
export function feedbackTransport() {
  let snapshot = uniquePlayers(
    PublicSessionSnapshotSchema.parse(publicSnapshot),
  )
  let exists = true
  let failure:
    'none' | 'read' | 'write' | 'conflict' | 'sync-after-write' | 'readonly' =
    'none'
  let held: (() => void) | null = null
  let holdNext = false
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const writes: { path: string; body: unknown }[] = []
  const frame = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    type = 'snapshot',
  ) =>
    controller.enqueue(
      new TextEncoder().encode(
        `id: ${snapshot.eventSeq}\ndata: ${JSON.stringify({ eventId: ids.event, sessionId: ids.session, stateVersion: snapshot.stateVersion, eventSeq: snapshot.eventSeq, type, payload: { snapshot } })}\n\n`,
      ),
    )
  const broadcast = () => {
    for (const stream of streams) frame(stream)
  }
  const missing = () =>
    Response.json(
      { code: 'SESSION_NOT_FOUND', message: '不存在' },
      { status: 404 },
    )
  const fetcher: typeof fetch = async (input, init) => {
    const path = String(input)
    if (init?.method === 'POST' || init?.method === 'DELETE') {
      writes.push({ path, body: JSON.parse(String(init.body)) })
      if (holdNext) {
        holdNext = false
        await new Promise<void>((resolve) => {
          held = resolve
        })
      }
      if (failure === 'write') throw new TypeError('测试网络断开')
      if (failure === 'conflict') {
        snapshot = {
          ...snapshot,
          stateVersion: snapshot.stateVersion + 1,
          eventSeq: snapshot.eventSeq + 1,
        }
        return Response.json(
          {
            code: 'STATE_VERSION_CONFLICT',
            message: '变化',
            latestSnapshot: snapshot,
          },
          { status: 409 },
        )
      }
      if (init.method === 'DELETE') {
        exists = false
        return Response.json(
          path === '/api/data'
            ? { deletedSessionCount: 1, invalidatedRunCount: 0 }
            : { deletedSessionId: ids.session, invalidatedRunCount: 0 },
        )
      }
      if (failure === 'sync-after-write') {
        failure = 'read'
        return Response.json({
          snapshot: {
            ...snapshot,
            stateVersion: 0,
            eventSeq: snapshot.eventSeq + 1,
          },
        })
      }
      snapshot = {
        ...snapshot,
        lifecycleStatus: 'ended',
        pokerPhase: 'betweenHands',
        hand: null,
        agentRunState: 'idle',
        stateVersion: snapshot.stateVersion + 1,
        eventSeq: snapshot.eventSeq + 1,
      }
      broadcast()
      return Response.json({ snapshot })
    }
    if (path.endsWith('/active')) return missing()
    if (failure === 'readonly')
      return Response.json(
        { code: 'SESSION_READONLY_DIAGNOSTIC', message: '只读诊断' },
        { status: 409 },
      )
    if (!exists) return missing()
    if (failure === 'read')
      return Response.json(
        { code: 'SERVICE_UNAVAILABLE', message: '服务暂不可用' },
        { status: 503 },
      )
    if (path.endsWith('/ai-status'))
      return Response.json(aiStatusFixture(snapshot))
    if (path.endsWith('/events')) {
      let controller!: ReadableStreamDefaultController<Uint8Array>
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c
          streams.add(c)
          frame(c)
        },
        cancel() {
          streams.delete(controller)
        },
      })
      return new Response(stream, {
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    return Response.json({ snapshot })
  }
  return {
    fetcher,
    writes,
    reset() {
      exists = true
      failure = 'none'
      snapshot = uniquePlayers(
        PublicSessionSnapshotSchema.parse(publicSnapshot),
      )
      writes.length = 0
    },
    set(next: Partial<PublicSessionSnapshot>) {
      snapshot = PublicSessionSnapshotSchema.parse({ ...snapshot, ...next })
      broadcast()
    },
    get: () => snapshot,
    fail(next: typeof failure) {
      failure = next
    },
    disconnect() {
      for (const stream of streams) stream.close()
      streams.clear()
    },
    hold() {
      holdNext = true
    },
    release() {
      held?.()
      held = null
    },
  }
}
