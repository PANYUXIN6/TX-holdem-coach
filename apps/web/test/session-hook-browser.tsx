import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import type { PublicSessionSnapshot } from '@tx-holdem-coach/contracts'
import { createApi } from '../src/api/client.js'
import { createQueryClient } from '../src/query/client.js'
import { keys } from '../src/query/keys.js'
import { createSessionRuntime } from '../src/session-sync/runtime.js'
import {
  SessionRuntimeProvider,
  useSession,
} from '../src/session-sync/react.js'
import { ids } from './fixtures.js'
import { homeTransport } from './home-transport.js'

// 真实 React hook + Query/runtime；沿用独立浏览器验收，不模拟 hook。
export async function checkSessionHook() {
  const passed: string[] = []
  for (const enabled of [false, undefined]) {
    const transport = homeTransport('active')
    const client = createQueryClient()
    const runtime = createSessionRuntime(client, createApi(transport.fetcher))
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const assert = (condition: boolean, message: string) => {
      if (!condition) throw new Error(message)
      passed.push(message)
    }
    const until = async (predicate: () => boolean) => {
      const start = Date.now()
      while (!predicate()) {
        if (Date.now() - start > 3000) throw new Error('等待 hook 更新超时')
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    function DisabledProbe() {
      const session = useSession(ids.session, { enabled: false })
      return <output>{session.data?.seats[0]?.stack ?? '无快照'}</output>
    }
    function DefaultProbe() {
      const session = useSession(ids.session)
      return <output>{session.data?.seats[0]?.stack ?? '无快照'}</output>
    }
    try {
      flushSync(() =>
        root.render(
          <QueryClientProvider client={client}>
            <SessionRuntimeProvider runtime={runtime}>
              {enabled === false ? <DisabledProbe /> : <DefaultProbe />}
            </SessionRuntimeProvider>
          </QueryClientProvider>,
        ),
      )
      if (enabled === false) {
        assert(
          container.textContent === '无快照' && transport.requests.length === 0,
          '禁用读取时空缓存不发 GET',
        )
        await client.fetchQuery(runtime.activeOptions())
      }
      await until(() => container.textContent !== '无快照')
      assert(
        transport.requests.join() ===
          (enabled === false
            ? 'GET /api/sessions/active'
            : `GET /api/sessions/${ids.session}`),
        enabled === false
          ? '禁用读取接收 active 快照，不额外 GET/SSE'
          : '默认调用自动 GET，hook 本身不租用 SSE',
      )
      client.setQueryData<PublicSessionSnapshot>(
        keys.session(ids.session),
        (data) => ({
          ...data!,
          seats: data!.seats.map((seat, index) =>
            index === 0 ? { ...seat, stack: 3210 } : seat,
          ),
        }),
      )
      await until(() => container.textContent === '3210')
      passed.push(`${enabled === false ? '禁用' : '默认'}模式订阅唯一缓存更新`)
    } finally {
      flushSync(() => root.unmount())
      client.clear()
      container.remove()
    }
  }
  return passed.join('\n')
}
