// 独立回环传输夹具，不加载 Server、数据库或 Provider。
import { createServer, type ServerResponse } from 'node:http'
import { ids, publicSnapshot, publicCompletedHandSummary } from './fixtures.js'
let snapshot = structuredClone(publicSnapshot) as Record<string, unknown>
let exists = true
let down = false
let hold = false
const held: (() => void)[] = []
const streams = new Set<ServerResponse>()
const metrics = {
  connections: 0,
  maxConnections: 0,
  cursors: [] as (string | undefined)[],
  gets: 0,
  commands: 0,
  creates: 0,
  origins: [] as (string | undefined)[],
  hosts: [] as (string | undefined)[],
}
function event(type = 'snapshot') {
  return {
    eventId: ids.event,
    sessionId: ids.session,
    eventSeq: snapshot.eventSeq,
    stateVersion: snapshot.stateVersion,
    type,
    payload: { snapshot },
  }
}
function frame(response: ServerResponse, type = 'snapshot') {
  response.write(
    `id: ${snapshot.eventSeq}\ndata: ${JSON.stringify(event(type))}\n\n`,
  )
}
function broadcast(type: string) {
  for (const response of streams) frame(response, type)
}
const server = createServer(async (request, response) => {
  let text = ''
  for await (const chunk of request) text += chunk
  const path = request.url ?? ''
  const json = (body: unknown, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }
  if (path.startsWith('/api/__fixture/')) {
    const action = path.split('/').at(-1)
    if (action === 'metrics') {
      json(metrics)
      return
    }
    if (action === 'reset') {
      for (const stream of streams) stream.end()
      streams.clear()
      snapshot = structuredClone(publicSnapshot) as Record<string, unknown>
      exists = true
      down = false
      hold = false
      held.splice(0).forEach((done) => done())
      metrics.commands = 0
      metrics.creates = 0
      metrics.gets = 0
      metrics.cursors = []
      metrics.maxConnections = 0
    }
    if (action === 'disconnect') {
      down = true
      for (const stream of streams) stream.end()
    }
    if (action === 'recover') down = false
    if (action === 'hold') hold = true
    if (action === 'release') {
      hold = false
      held.splice(0).forEach((done) => done())
    }
    if (action === 'advance') {
      snapshot = {
        ...snapshot,
        eventSeq: Number(snapshot.eventSeq) + 1,
        stateVersion: Number(snapshot.stateVersion) + 1,
      }
      broadcast('actionCommitted')
    }
    if (action === 'pause') {
      snapshot = {
        ...snapshot,
        eventSeq: Number(snapshot.eventSeq) + 1,
        agentRunState: 'paused',
        hand: { ...publicSnapshot.hand, legalActions: [] },
      }
      broadcast('agentPaused')
    }
    if (action === 'complete') {
      snapshot = {
        ...snapshot,
        eventSeq: Number(snapshot.eventSeq) + 1,
        stateVersion: Number(snapshot.stateVersion) + 1,
        agentRunState: 'idle',
        pokerPhase: 'betweenHands',
        hand: null,
        lastCompletedHandSummary: publicCompletedHandSummary,
      }
      broadcast('handCompleted')
    }
    if (action === 'bad')
      for (const stream of streams)
        stream.write('id: 999\ndata: secret-invalid-json\n\n')
    if (action === 'rollback') {
      snapshot = {
        ...snapshot,
        eventSeq: Number(snapshot.eventSeq) + 1,
        stateVersion: 0,
      }
      broadcast('actionCommitted')
    }
    json({ ok: true })
    return
  }
  metrics.origins.push(request.headers.origin)
  metrics.hosts.push(request.headers.host)
  if (path === `/api/sessions/${ids.session}/events`) {
    if (!exists) {
      json({ code: 'SESSION_NOT_FOUND', message: '不存在' }, 404)
      return
    }
    if (down) {
      json({ code: 'SERVICE_UNAVAILABLE', message: '暂不可用' }, 503)
      return
    }
    metrics.cursors.push(request.headers['last-event-id'] as string | undefined)
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
    })
    response.flushHeaders()
    streams.add(response)
    metrics.connections++
    metrics.maxConnections = Math.max(metrics.maxConnections, streams.size)
    if (request.headers['last-event-id']) frame(response, 'actionCommitted')
    frame(response)
    const heartbeat = setInterval(
      () => response.write(': heartbeat\n\n'),
      15000,
    )
    response.on('close', () => {
      clearInterval(heartbeat)
      streams.delete(response)
    })
    return
  }
  if (path === '/api/sessions/active') {
    json({ code: 'SESSION_NOT_FOUND', message: '不存在' }, 404)
    return
  }
  if (path === '/api/sessions' && request.method === 'POST') {
    metrics.creates++
    json(
      {
        code: 'ACTIVE_SESSION_EXISTS',
        message: '已有场次',
        latestSnapshot: snapshot,
      },
      409,
    )
    return
  }
  if (path === `/api/sessions/${ids.session}/commands`) {
    metrics.commands++
    json({ snapshot })
    return
  }
  if (path === '/api/data' && request.method === 'DELETE') {
    exists = false
    for (const stream of streams) stream.end()
    json({ deletedSessionCount: 1, invalidatedRunCount: 0 })
    return
  }
  if (path === `/api/sessions/${ids.session}`) {
    metrics.gets++
    const captured = structuredClone(snapshot)
    const done = () =>
      json(
        exists
          ? { snapshot: captured }
          : { code: 'SESSION_NOT_FOUND', message: '不存在' },
        exists ? 200 : 404,
      )
    // 已经开始的 GET 可在删除后交付旧的合法响应，专门验证客户端隔离。
    if (hold) held.push(() => json({ snapshot: captured }))
    else done()
    return
  }
  json({ code: 'NOT_FOUND', message: '不存在' }, 404)
})
server.listen(18787, '127.0.0.1', () =>
  console.log('M6.3 SSE fixture http://127.0.0.1:18787'),
)
