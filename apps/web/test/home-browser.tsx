// 仅测试入口替换 HTTP，挂载生产 Shell、首页与全部路由。
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import type { PublicSessionSnapshot } from '@tx-holdem-coach/contracts'
import { BrowserRouter, useRoutes } from 'react-router'
import { Page } from '../src/Pages.js'
import { Shell } from '../src/Shell.js'
import { routes } from '../src/navigation.js'
import { createQueryClient } from '../src/query/client.js'
import { keys } from '../src/query/keys.js'
import { createSessionRuntime } from '../src/session-sync/runtime.js'
import { SessionRuntimeProvider } from '../src/session-sync/react.js'
import { OverlayUiProvider } from '../src/ui/react.js'
import { ids } from './fixtures.js'
import '../src/styles.css'
import { homeTransport } from './home-transport.js'
import { checkSessionHook } from './session-hook-browser.js'
const search = new URLSearchParams(location.search)
if (search.has('touch')) {
  const original = window.matchMedia.bind(window)
  window.matchMedia = (query) =>
    original(query.replace('(pointer: coarse)', '(pointer: fine)'))
}

const scenario =
  search.get('scenario') ?? sessionStorage.getItem('home-scenario') ?? 'empty'
sessionStorage.setItem('home-scenario', scenario)
const transport = homeTransport(scenario)
transport.fail(search.get('failure') ?? '')
window.fetch = transport.fetcher
const target = search.get('target') ?? location.pathname
if (target === '/test/home.html') history.replaceState(null, '', '/')
else if (search.has('target')) history.replaceState(null, '', target)
const client = createQueryClient()
const runtime = createSessionRuntime(client)
function ApplicationRoutes() {
  return useRoutes([
    {
      element: <Shell />,
      children: routes.map((route) => ({
        ...route,
        element: <Page id={route.id} />,
      })),
    },
  ])
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <SessionRuntimeProvider runtime={runtime}>
      <OverlayUiProvider>
        <BrowserRouter>
          <ApplicationRoutes />
        </BrowserRouter>
      </OverlayUiProvider>
    </SessionRuntimeProvider>
  </QueryClientProvider>,
)
// 控件位于手机画布外，用于手动触发真实请求恢复。
const controls = document.createElement('aside')
controls.style.cssText =
  'position:fixed;right:4px;bottom:4px;z-index:100;background:#131d19;max-width:140px;font-size:12px'
const button = document.createElement('button')
button.textContent = '夹具：恢复请求'
button.onclick = () => transport.fail('')
controls.append(button)
const hookCheck = document.createElement('button')
hookCheck.textContent = '夹具：验证 Session hook'
const hookResult = document.createElement('output')
hookCheck.onclick = () => {
  hookCheck.disabled = true
  void checkSessionHook()
    .then((result) => {
      hookResult.textContent = `通过：${result}`
    })
    .catch((error: unknown) => {
      hookResult.textContent = `失败：${String(error)}`
    })
    .finally(() => {
      hookCheck.disabled = false
    })
}
controls.append(hookCheck, hookResult)
const requestLog = document.createElement('pre')
requestLog.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere'
for (const [label, action] of [
  [
    '夹具：查看请求',
    () => {
      requestLog.textContent = transport.requests.join('\n')
    },
  ],
  [
    '夹具：更新缓存筹码',
    () => {
      client.setQueryData<PublicSessionSnapshot>(
        keys.session(ids.session),
        (data) =>
          data && {
            ...data,
            seats: data.seats.map((seat) =>
              seat.isUser ? { ...seat, stack: 3210 } : seat,
            ),
          },
      )
    },
  ],
  [
    '夹具：后台定位失败',
    () => {
      transport.fail('active')
      void client.refetchQueries({ queryKey: keys.active(), exact: true })
    },
  ],
  [
    '夹具：移除活动缓存',
    () => {
      transport.scenario('empty')
      client.removeQueries({ queryKey: keys.session(ids.session), exact: true })
    },
  ],
  [
    '夹具：摘要不匹配',
    () => {
      transport.fail('mismatch')
      void client.refetchQueries({ queryKey: ['sessions'] })
    },
  ],
] as const) {
  const control = document.createElement('button')
  control.textContent = label
  control.onclick = action
  controls.append(control)
}
controls.append(requestLog)
if (search.has('controls')) document.body.append(controls)
Object.assign(window, { homeFixture: transport })
