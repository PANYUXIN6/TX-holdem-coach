import { createParser } from 'eventsource-parser'
import {
  ErrorResponseSchema,
  SseEventSchema,
  type SseEvent,
} from '@tx-holdem-coach/contracts'
import { sessionId } from './client.js'
import { ApiError, safeFieldPaths } from './errors.js'
export type StreamOptions = {
  sessionId: string
  cursor?: number | undefined
  signal: AbortSignal
  onOpen: () => void
  onBytes: () => void
  onEvent: (event: SseEvent) => void
}
export type SessionStream = (options: StreamOptions) => Promise<void>
export function createSessionStream(
  fetcher: typeof fetch = (...args) => fetch(...args),
): SessionStream {
  return async ({
    sessionId: input,
    cursor,
    signal,
    onOpen,
    onBytes,
    onEvent,
  }) => {
    const id = sessionId(input)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const abort = () => {
      void reader?.cancel().catch(() => {})
    }
    try {
      if (signal.aborted) throw new ApiError('cancelled')
      const response = await fetcher(
        `/api/sessions/${encodeURIComponent(id)}/events`,
        {
          headers: {
            Accept: 'text/event-stream',
            ...(cursor === undefined
              ? {}
              : { 'Last-Event-ID': String(cursor) }),
          },
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
          signal,
        },
      )
      if (signal.aborted) throw new ApiError('cancelled')
      const mime = response.headers.get('content-type') ?? ''
      if (!response.ok) {
        if (!/^application\/json(?:\s*;.*)?$/i.test(mime))
          throw new ApiError('protocol', response.status)
        let raw: unknown
        try {
          raw = await response.json()
        } catch {
          throw new ApiError('protocol', response.status)
        }
        const parsed = ErrorResponseSchema.safeParse(raw)
        if (
          !parsed.success ||
          (parsed.data.latestSnapshot &&
            parsed.data.latestSnapshot.sessionId.toLowerCase() !== id)
        )
          throw new ApiError('protocol', response.status)
        const error = parsed.data
        throw new ApiError(
          'http',
          response.status,
          /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code)
            ? error.code
            : 'UNKNOWN_ERROR',
          safeFieldPaths((error.fieldErrors ?? []).map((field) => field.path)),
          error.latestSnapshot,
        )
      }
      if (
        response.status !== 200 ||
        !/^text\/event-stream(?:\s*;.*)?$/i.test(mime) ||
        !response.body
      )
        throw new ApiError('protocol', response.status)
      reader = response.body.getReader()
      signal.addEventListener('abort', abort, { once: true })
      const decoder = new TextDecoder('utf-8', { fatal: true })
      const parser = createParser({
        onEvent(frame) {
          if (signal.aborted) return
          if (
            (frame.event && frame.event !== 'message') ||
            !/^(0|[1-9]\d*)$/.test(frame.id ?? '') ||
            !Number.isSafeInteger(Number(frame.id))
          )
            throw new ApiError('protocol')
          let raw: unknown
          try {
            raw = JSON.parse(frame.data)
          } catch {
            throw new ApiError('protocol')
          }
          const parsed = SseEventSchema.safeParse(raw)
          if (
            !parsed.success ||
            parsed.data.sessionId.toLowerCase() !== id ||
            parsed.data.eventSeq !== Number(frame.id)
          )
            throw new ApiError('protocol')
          onEvent(parsed.data)
        },
      })
      onOpen()
      while (!signal.aborted) {
        const chunk = await reader.read()
        if (signal.aborted || chunk.done) break
        if (chunk.value.byteLength) onBytes()
        let decoded: string
        try {
          decoded = decoder.decode(chunk.value, { stream: true })
        } catch {
          throw new ApiError('protocol')
        }
        parser.feed(decoded)
      }
      // 不 flush EOF 半帧；下一连接拥有全新的 decoder/parser。
      parser.reset()
    } catch (error) {
      if (signal.aborted) throw new ApiError('cancelled')
      if (error instanceof ApiError) throw error
      throw new ApiError('network')
    } finally {
      signal.removeEventListener('abort', abort)
      await reader?.cancel().catch(() => {})
      reader?.releaseLock()
    }
  }
}
