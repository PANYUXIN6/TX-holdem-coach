import { expect, it, vi } from 'vitest'
import { createApp, type ApiRuntime } from '../../src/http/create-app.js'
import { loadAndValidatePersonaCatalog } from '../../src/personas/catalog.js'

it('AI 状态 HTTP 严格校验路径/query，支持 HEAD/no-store 和不存在', async () => {
  const id = '10000000-0000-4000-8000-000000000001'
  const catalog = loadAndValidatePersonaCatalog()
  const getById = vi.fn(async () => null)
  const app = createApp(
    {
      sessionAiStatus: { getById },
      personaCatalog: catalog,
    } as unknown as ApiRuntime,
    { port: 3100, allowedOrigins: new Set(['http://localhost:3000']) },
  )
  const request = (path: string, method = 'GET') =>
    app.request(`http://127.0.0.1:3100${path}`, { method })
  expect(
    (await request(`/api/sessions/${id}/ai-status?unexpected=1`)).status,
  ).toBe(400)
  expect((await request('/api/sessions/invalid/ai-status')).status).toBe(400)
  expect(getById).not.toHaveBeenCalled()
  const missing = await request(`/api/sessions/${id}/ai-status`)
  expect(missing.status).toBe(404)
  expect(await missing.json()).toMatchObject({ code: 'SESSION_NOT_FOUND' })
  const head = await request(`/api/sessions/${id}/ai-status`, 'HEAD')
  expect(head.status).toBe(404)
  expect(await head.text()).toBe('')
  expect(head.headers.get('cache-control')).toContain('no-store')
})
