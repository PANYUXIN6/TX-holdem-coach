// 仅本地验收：不加载 configured runtime、数据库配置或真实 Provider。
import { createServer } from 'node:http'
const server = createServer(async (request, response) => {
  let body = ''
  for await (const chunk of request) body += chunk
  console.log(
    JSON.stringify({
      method: request.method,
      path: request.url,
      host: request.headers.host,
      origin: request.headers.origin ?? null,
      body,
    }),
  )
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  if (request.url === '/api/health')
    response.end(JSON.stringify({ status: 'ok', database: 'available' }))
  else if (
    request.url === '/api/settings/providers/deepseek/check' &&
    request.method === 'POST' &&
    body === '{}' &&
    request.headers.origin === 'http://127.0.0.1:5173'
  )
    response.end(
      JSON.stringify({
        deepSeek: {
          configured: true,
          checkStatus: 'unavailable',
          lastCheckedAt: '2026-09-10T00:00:00.000Z',
          errorCode: 'provider_timeout',
          canCreateSession: true,
        },
      }),
    )
  else {
    response.statusCode = 404
    response.end(JSON.stringify({ code: 'NOT_FOUND', message: '资源不存在。' }))
  }
})
server.listen(18787, '127.0.0.1', () =>
  console.log('M6.2 fixture: 127.0.0.1:18787'),
)
