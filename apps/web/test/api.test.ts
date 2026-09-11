import { expect, it, vi } from 'vitest'
import { createApi } from '../src/api/client.js'
import { ApiError, errorMessage } from '../src/api/errors.js'
import {
  callsSearch,
  historySearch,
  statisticsSearch,
} from '../src/api/search.js'

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const json = (value: unknown, status = 200) => Response.json(value, { status })
it('先拒绝非法输入，合法读取使用同源 JSON 边界', async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    json({ status: 'ok', database: 'available' }),
  )
  const api = createApi(fetcher)
  expect(() => api.session('bad')).toThrow(ApiError)
  expect(fetcher).not.toHaveBeenCalled()
  expect(await api.health()).toEqual({ status: 'ok', database: 'available' })
  expect(fetcher.mock.calls[0]).toMatchObject([
    '/api/health',
    {
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      method: 'GET',
    },
  ])
})
it.each([
  () => new Response('<secret>', { headers: { 'Content-Type': 'text/html' } }),
  () =>
    new Response('{secret', {
      headers: { 'Content-Type': 'application/json' },
    }),
  () => json({ secret: 'private' }),
  () => json({ status: 'ok', database: 'available' }, 201),
  () => json({ message: 'private' }, 500),
])('非法响应只暴露协议错误', async (response) => {
  const result = await createApi(async () => response())
    .health()
    .catch((error: unknown) => error)
  expect(result).toMatchObject({ kind: 'protocol' })
  expect(JSON.stringify(result)).not.toMatch(/secret|private/)
  expect(errorMessage(result)).toContain('前后端版本')
})
it('响应身份与回显必须匹配请求', async () => {
  const api = createApi(async () =>
    json({
      runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      query: { limit: 20 },
      items: [],
      nextCursor: null,
    }),
  )
  await expect(api.attempts(id, callsSearch.decode(''))).rejects.toMatchObject({
    kind: 'protocol',
  })
})
it('active 404 保持认证错误，传输不将其或详情 404 变成空成功', async () => {
  const api = createApi(async () =>
    json({ code: 'SESSION_NOT_FOUND', message: 'private' }, 404),
  )
  await expect(api.activeSession()).rejects.toMatchObject({
    kind: 'http',
    status: 404,
    code: 'SESSION_NOT_FOUND',
  })
  await expect(api.session(id)).rejects.toMatchObject({
    kind: 'http',
    status: 404,
  })
})
it('中止覆盖 body 读取后的结果', async () => {
  const controller = new AbortController()
  const api = createApi(async () => {
    controller.abort()
    return json({ status: 'ok', database: 'available' })
  })
  await expect(api.health({ signal: controller.signal })).rejects.toMatchObject(
    { kind: 'cancelled' },
  )
})
it('URL 单值规范化、微秒与 opaque cursor 往返', () => {
  const page = historySearch.decode(
    `?sessionId=${id.toUpperCase()}&limit=20&from=2026-09-10T00%3A00%3A00.123456Z&cursor=Ab_-1`,
  )
  expect(page.query.sessionId).toBe(id)
  expect(historySearch.decode(historySearch.encode(page))).toEqual(page)
  expect(page.query.from).toBe('2026-09-10T00:00:00.123456Z')
  for (const search of [
    '?limit=',
    '?limit=1&limit=2',
    '?wat=1',
    '?__proto__=x',
    '?limit=1e1',
    '?limit=020',
    '?personaName=%20',
  ])
    expect(() => historySearch.decode(search)).toThrow(ApiError)
  expect(() => statisticsSearch.decode('?scope=sessions&position=BTN')).toThrow(
    ApiError,
  )
})

it('创建 201、命令 200 与 409 校准候选保持不同语义，载荷原样传递', async () => {
  const { publicSnapshot, ids } = await import('./fixtures.js')
  const bodies: unknown[] = []
  let status = 201
  const api = createApi(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return json(
      status === 409
        ? {
            code: 'ACTIVE_SESSION_EXISTS',
            message: 'secret',
            latestSnapshot: publicSnapshot,
          }
        : { snapshot: publicSnapshot },
      status,
    )
  })
  const creation = { rosterSource: { type: 'latestEnded' as const } }
  expect((await api.createSession(creation)).snapshot).toEqual(publicSnapshot)
  status = 200
  const command = {
    command: {
      type: 'endSession' as const,
      sessionId: ids.session,
      commandId: ids.command,
      expectedStateVersion: 4,
      payload: {},
    },
  }
  expect((await api.command(ids.session, command)).snapshot).toEqual(
    publicSnapshot,
  )
  expect(bodies).toEqual([creation, command])
  status = 409
  await expect(api.createSession(creation)).rejects.toMatchObject({
    kind: 'http',
    status: 409,
    latestSnapshot: publicSnapshot,
  })
  expect(() => api.command(id, command)).toThrow(ApiError)
  await expect(
    createApi(async () => json({ snapshot: publicSnapshot })).session(id),
  ).rejects.toMatchObject({ kind: 'protocol' })
})
