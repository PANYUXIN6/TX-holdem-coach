// 独立夹具：消费生产 Shell / Provider / hooks，控件和计数不进入产品入口。
import { StrictMode, useLayoutEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider, useQuery } from '@tanstack/react-query'
import { BrowserRouter, useRoutes } from 'react-router'
import { Shell } from '../src/Shell.js'
import { Page } from '../src/Pages.js'
import { routes, resourcePath, sessionHistoryPath } from '../src/navigation.js'
import { createQueryClient } from '../src/query/client.js'
import { keys } from '../src/query/keys.js'
import { createSessionRuntime } from '../src/session-sync/runtime.js'
import { SessionRuntimeProvider } from '../src/session-sync/react.js'
import {
  OverlayUiProvider,
  useTableScope,
  useTableUi,
  useTableAnimation,
  useDebugUi,
  useDebugStore,
  useOverlayStore,
  useOverlayUi,
  usePageScope,
} from '../src/ui/react.js'
import type { TableScope } from '../src/ui/table-adapter.js'
import type { PublicSessionSnapshot } from '@tx-holdem-coach/contracts'
import type {
  createDebugUiStore,
  createOverlayUiStore,
} from '../src/ui/stores.js'
import { ids } from './fixtures.js'
import '../src/styles.css'
const client = createQueryClient()
const runtime = createSessionRuntime(client)
const counts = { draft: 0, tools: 0, animation: 0, seat: 0, debug: 0, shell: 0 }
let table: TableScope | undefined
let footer: TableScope | undefined
let debug: ReturnType<typeof createDebugUiStore> | undefined
let overlay: ReturnType<typeof createOverlayUiStore>
let owner = ''
let fail: (() => void) | undefined
function Draft() {
  const draft = useTableUi((s) => s.betDraft)
  useLayoutEffect(() => {
    counts.draft++
  })
  return <output data-testid="draft">{draft?.input ?? '空草稿'}</output>
}
function Tools() {
  const open = useTableUi((s) => s.toolsOpen)
  useLayoutEffect(() => {
    counts.tools++
  })
  return <output>工具 {String(open)}</output>
}
function Animation() {
  const batch = useTableAnimation((s) => s.batch)
  useLayoutEffect(() => {
    counts.animation++
  })
  return <output>动画 {batch?.stateVersion ?? '空'}</output>
}
function Seat() {
  const { data } = useQuery({
    ...runtime.sessionOptions(ids.session),
    enabled: false,
    select: (s) => s.seats[0]?.stack,
  })
  useLayoutEffect(() => {
    counts.seat++
  })
  return <output>公开筹码 {data}</output>
}
function TableProbe() {
  const scope = useTableScope()
  useLayoutEffect(() => {
    table = scope
    return () => {
      table = undefined
    }
  }, [scope])
  return (
    <div>
      <Draft />
      <Tools />
      <Animation />
      <Seat />
    </div>
  )
}
function FooterProbe() {
  const scope = useTableScope()
  useLayoutEffect(() => {
    footer = scope
    return () => {
      footer = undefined
    }
  }, [scope])
  return (
    <span>
      共享操作区 <Draft />
    </span>
  )
}
function DebugProbe() {
  const store = useDebugStore()
  const tab = useDebugUi((s) => s.tab)
  useLayoutEffect(() => {
    debug = store
    return () => {
      debug = undefined
    }
  }, [store])
  useLayoutEffect(() => {
    counts.debug++
  })
  return <output>调试 {tab}</output>
}
function Source() {
  const scope = usePageScope()
  useLayoutEffect(() => {
    owner = scope
  }, [scope])
  const [broken, setBroken] = useState(false)
  fail = () => setBroken(true)
  if (broken) throw new Error('验收页面错误')
  return null
}
function OverlayProbe() {
  overlay = useOverlayStore()
  const active = useOverlayUi((s) => s.active)
  return active ? (
    <div
      role="dialog"
      style={{ position: 'fixed', top: 150, background: '#123', zIndex: 10 }}
    >
      确认 {active.kind}
    </div>
  ) : null
}
function TestShell() {
  useLayoutEffect(() => {
    counts.shell++
  })
  return <Shell tableActions={<FooterProbe />} />
}
function TestRoutes() {
  return useRoutes([
    {
      element: <TestShell />,
      children: routes.map((route) => ({
        ...route,
        element: (
          <>
            <Source />
            <Page id={route.id} />
            {route.id === 'table' ? (
              <TableProbe />
            ) : route.id === 'run' ? (
              <DebugProbe />
            ) : null}
          </>
        ),
      })),
    },
  ])
}
const root = createRoot(document.getElementById('root')!)
root.render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <SessionRuntimeProvider runtime={runtime}>
        <OverlayUiProvider>
          <BrowserRouter>
            <TestRoutes />
            <OverlayProbe />
          </BrowserRouter>
        </OverlayUiProvider>
      </SessionRuntimeProvider>
    </QueryClientProvider>
  </StrictMode>,
)
const panel = document.getElementById('checks')!
panel.replaceChildren()
const button = document.createElement('button')
button.textContent = '运行 M6.4 验收'
panel.append(button)
const output = document.createElement('pre')
output.style.whiteSpace = 'pre-wrap'
panel.append(output)
const wait = () => new Promise((resolve) => setTimeout(resolve, 80))
const until = async (predicate: () => boolean) => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await wait()
  }
  throw new Error('等待超时')
}
const navigate = async (path: string) => {
  history.pushState(null, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
  await wait()
}
const fixture = async (action: string) => {
  await fetch(`/api/__fixture/${action}`, { method: 'POST' })
}
button.onclick = () => {
  button.disabled = true
  output.textContent = ''
  const check = (value: unknown, message: string) => {
    if (!value) throw new Error(message)
    output.textContent += `✓ ${message}\n`
  }
  void (async () => {
    await navigate('/')
    await fixture('reset')
    client.removeQueries({ queryKey: ['session'] })
    await navigate(resourcePath('table', ids.session))
    await until(() => runtime.getStatus(ids.session) === 'ready' && !!table)
    check(table === footer, '牌桌与 footer 共用生产 Store')
    check(
      table!.currentDraft() === null && !overlay.getState().active,
      '初次挂载草稿和弹窗为空',
    )
    await wait()
    const before = { ...counts }
    table!.begin('raise')
    table!.suggest(90)
    await wait()
    check(
      counts.draft > before.draft &&
        counts.tools === before.tools &&
        counts.animation === before.animation &&
        counts.seat === before.seat &&
        counts.debug === before.debug &&
        counts.shell === before.shell,
      '真实 React 编辑仅增加草稿消费者渲染',
    )
    for (const path of [
      resourcePath('currentHand', ids.session),
      resourcePath('agents', ids.session),
      sessionHistoryPath(ids.session),
    ]) {
      const previous = table!
      overlay.getState().open(owner, { kind: 'clearData' })
      await fixture('advance')
      await wait()
      await navigate(path)
      check(
        !table &&
          !previous.table.getState().betDraft &&
          !previous.animation.getState().batch &&
          !overlay.getState().active,
        '离桌清理草稿、动画与来源弹窗',
      )
      await navigate(resourcePath('table', ids.session))
      await until(() => runtime.getStatus(ids.session) === 'ready' && !!table)
      check(
        table !== previous && !table!.currentDraft(),
        '返回牌桌创建默认新实例',
      )
      table!.begin('raise')
    }
    const old = table!
    await navigate(resourcePath('table', ids.hand))
    check(table !== old && !old.currentDraft(), '切换场次隔离实例')
    await navigate(resourcePath('table', ids.session))
    await until(() => runtime.getStatus(ids.session) === 'ready')
    table!.begin('raise')
    overlay.getState().open(owner, { kind: 'clearData' })
    const errored = table!
    fail!()
    await wait()
    check(
      !table &&
        !footer &&
        !errored.currentDraft() &&
        !overlay.getState().active &&
        !!document.querySelector('[role="alert"]'),
      '页面错误卸载内容、footer 和来源状态',
    )
    await navigate(resourcePath('run', ids.hand))
    debug!.getState().setTab('attempts')
    debug!.getState().select({ kind: 'attempt', id: 'row' })
    const oldDebug = debug
    await navigate(resourcePath('run', ids.player))
    check(
      debug !== oldDebug &&
        debug!.getState().tab === 'summary' &&
        !debug!.getState().selection,
      '切换 Run 重置调试选择',
    )
    client.setQueryData(keys.run(ids.player), { id: ids.player })
    debug!.getState().setTab('invocations')
    client.removeQueries({ queryKey: keys.run(ids.player) })
    check(debug!.getState().tab === 'summary', '移除父 Run 清理调试状态')
    await navigate(resourcePath('table', ids.session))
    await until(() => runtime.getStatus(ids.session) === 'ready')
    table!.begin('raise')
    client.removeQueries({ queryKey: keys.session(ids.session) })
    check(!table!.currentDraft(), '移除目标 Query 立即使草稿不可用')
    await runtime.refresh(ids.session)
    await fixture('pause')
    await wait()
    const snapshot = client.getQueryData<PublicSessionSnapshot>(
      keys.session(ids.session),
    )!
    overlay.getState().open(owner, {
      kind: 'abortHandAndEndSession',
      sessionId: ids.session,
      handId: snapshot.hand!.handId,
      stateVersion: snapshot.stateVersion,
    })
    check(!!overlay.getState().active, '暂停手允许打开绑定版本确认')
    await fixture('advance')
    await wait()
    check(!overlay.getState().active, '版本变化关闭过期中止确认')
    await navigate('/')
    await fixture('reset')
    client.removeQueries({ queryKey: ['session'] })
    await navigate(resourcePath('table', ids.session))
    await until(() => runtime.getStatus(ids.session) === 'ready')
    check(
      document.documentElement.scrollWidth <= window.innerWidth &&
        !!document.querySelector('.table-actions'),
      '窄屏无横向溢出，操作区保持装配',
    )
    output.textContent += 'M6.4 PASS\n'
  })()
    .catch((error) => {
      output.textContent += `FAIL ${String(error)}\n`
    })
    .finally(() => {
      button.disabled = false
    })
}

const prepareReload = document.createElement('button')
prepareReload.textContent = '准备刷新验收'
panel.append(prepareReload)
prepareReload.onclick = () => {
  if (!table?.begin('raise')) return
  table.suggest(90)
  overlay.getState().open(owner, { kind: 'clearData' })
  output.textContent =
    '刷新前：草稿 90、确认弹窗已打开。刷新后运行验收，应得到全新默认实例。'
  // 只改变重载入口，不 dispatch 路由事件，确保旧页面状态一直存活到浏览器 reload。
  history.replaceState(null, '', '/test/browser.html?ui')
}
