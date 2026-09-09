import { describe, expect, it, vi } from 'vitest'
import { createApp, type ApiRuntime } from '../../src/http/create-app.js'

const sessionId = '10000000-0000-4000-8000-000000000001'
const handId = '10000000-0000-4000-8000-000000000002'
const runId = '10000000-0000-4000-8000-000000000003'

function runtime() {
  const value = {
    sessionManagement: {
      list: vi.fn(async (query) => ({
        query: {
          lifecycle: query.lifecycle,
          from: query.from,
          to: query.to,
          sort: query.sort,
          limit: query.limit,
        },
        timeBasis: 'sessionCreatedAt',
        items: [],
        nextCursor: null,
      })),
    },
    agentCalls: {
      listRuns: vi.fn(async (_handId, query) => ({
        query: { limit: query.limit },
        hand: { handId, sessionId, handNumber: 1, status: 'completed' },
        items: [],
        nextCursor: null,
      })),
      readRun: vi.fn(),
      listAttempts: vi.fn(),
      listCapabilityInvocations: vi.fn(),
    },
  }
  return value as typeof value & ApiRuntime
}

function request(path: string, method = 'GET') {
  return new Request(`http://127.0.0.1:3100${path}`, {
    method,
    headers: { host: '127.0.0.1:3100' },
  })
}

describe('M5.5 HTTP 查询', () => {
  it('安装 GET|HEAD 场次列表且 query 在端口调用前严格规范化', async () => {
    const ports = runtime()
    const app = createApp(ports, {
      port: 3100,
      allowedOrigins: new Set(['http://localhost:3000']),
    })
    const response = await app.request(request('/api/sessions?limit=1'))
    expect(response.status).toBe(200)
    expect(ports.sessionManagement.list).toHaveBeenCalledWith({
      lifecycle: 'all',
      from: null,
      to: null,
      sort: 'newest',
      limit: 1,
      after: null,
    })
    const head = await app.request(request('/api/sessions?limit=1', 'HEAD'))
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    expect(
      (await app.request(request('/api/sessions?limit=1&limit=2'))).status,
    ).toBe(400)
  })

  it('安装 Hand 调用列表并拒绝错误父资源游标', async () => {
    const ports = runtime()
    const app = createApp(ports, {
      port: 3100,
      allowedOrigins: new Set(['http://localhost:3000']),
    })
    expect(
      (await app.request(request(`/api/hands/${handId}/agent-calls?limit=1`)))
        .status,
    ).toBe(200)
    expect(ports.agentCalls.listRuns).toHaveBeenCalledWith(handId, {
      limit: 1,
      after: null,
    })
    expect(
      (await app.request(request(`/api/agent-runs/${runId}?x=1`))).status,
    ).toBe(400)
  })
})
