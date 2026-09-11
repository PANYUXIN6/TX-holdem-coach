import { expect, it } from 'vitest'
import { createSessionStream } from '../src/api/sse.js'
import { ids, publicSnapshot } from './fixtures.js'
const envelope = () => ({
  eventId: ids.event,
  sessionId: ids.session,
  eventSeq: 8,
  stateVersion: 4,
  type: 'snapshot',
  payload: { snapshot: publicSnapshot },
})
function transport(
  text: string,
  headers = { 'content-type': 'text/event-stream' },
) {
  const bytes = new TextEncoder().encode(text)
  return createSessionStream(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (let i = 0; i < bytes.length; i += 7)
              controller.enqueue(bytes.slice(i, i + 7))
            controller.close()
          },
        }),
        { headers },
      ),
  )
}
it('实际 parser 处理 UTF-8 chunk、CRLF、多行 data 和心跳；丢弃 EOF 半帧', async () => {
  const received: unknown[] = []
  const raw = JSON.stringify(envelope()).replace(
    ',"sessionId"',
    ',\r\ndata: "sessionId"',
  )
  await transport(
    `: 心跳\r\n\r\nid: 8\r\ndata: ${raw}\r\n\r\nid: 8\ndata: ${JSON.stringify(envelope())}`,
  )({
    sessionId: ids.session,
    signal: new AbortController().signal,
    onOpen() {},
    onBytes() {},
    onEvent: (event) => received.push(event),
  })
  expect(received).toEqual([envelope()])
})
it.each([
  'id: 09\ndata: {}\n\n',
  'id: 8\ndata: secret-invalid-json\n\n',
  `id: 9\ndata: ${JSON.stringify(envelope())}\n\n`,
  `id: 8\nevent: agentStarted\ndata: ${JSON.stringify(envelope())}\n\n`,
])('坏帧脱敏且不交付 %s', async (text) => {
  const received: unknown[] = []
  await expect(
    transport(text)({
      sessionId: ids.session,
      signal: new AbortController().signal,
      onOpen() {},
      onBytes() {},
      onEvent: (event) => received.push(event),
    }),
  ).rejects.toMatchObject({ kind: 'protocol', message: 'API protocol' })
  expect(received).toEqual([])
})
