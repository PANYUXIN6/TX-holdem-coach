import { StrictMode, useState, useLayoutEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider, useQuery } from '@tanstack/react-query'
import {
  MemoryRouter,
  Link,
  useLocation,
  useNavigate,
  useRoutes,
} from 'react-router'
import { Shell } from '../src/Shell.js'
import { routes, resourcePath } from '../src/navigation.js'
import { createQueryClient } from '../src/query/client.js'
import { createApi } from '../src/api/client.js'
import { createSessionStream } from '../src/api/sse.js'
import { createSessionRuntime } from '../src/session-sync/runtime.js'
import {
  SessionRuntimeProvider,
  useSession,
} from '../src/session-sync/react.js'
import {
  OverlayUiProvider,
  useOverlayStore,
  usePageScope,
} from '../src/ui/react.js'
import { DeleteSessionTrigger } from '../src/ui/confirmation-host.js'
import { Button, Field, EmptyState } from '../src/components/controls.js'
import { FilterDrawer } from '../src/components/modal.js'
import {
  Feedback,
  LoadingFeedback,
  RequestError,
  focusFirstInvalid,
} from '../src/components/feedback.js'
import { ApiError, fieldMessages } from '../src/api/errors.js'
import { historySearch } from '../src/api/search.js'
import { feedbackTransport } from './feedback-transport.js'
import { ids } from './fixtures.js'
import '../src/styles.css'
// 仅在独立夹具显式模拟桌面触屏方向；生产 Shell 仍使用原 orientation query。
const scenario = new URLSearchParams(window.location.search)
if (scenario.has('large-text')) document.documentElement.style.fontSize = '200%'
if (scenario.has('touch')) {
  const original = window.matchMedia.bind(window)
  window.matchMedia = (query) =>
    original(query.replace('(pointer: coarse)', '(pointer: fine)'))
}
const transport = feedbackTransport()
if (scenario.has('readonly-empty')) transport.fail('readonly')
const client = createQueryClient()
const runtime = createSessionRuntime(
  client,
  createApi(transport.fetcher),
  createSessionStream(transport.fetcher),
)
let report = ''
const wait = () => new Promise((resolve) => setTimeout(resolve, 30))
async function until(predicate: () => boolean) {
  for (let n = 0; n < 150; n++) {
    if (predicate()) return
    await wait()
  }
  throw new Error('等待界面超时')
}
function click(label: string) {
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>('button'),
  ].find((b) => b.textContent === label)
  if (!button) throw new Error(`找不到按钮 ${label}`)
  button.click()
}
function type(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
function formSubmit() {
  document
    .querySelector<HTMLButtonElement>('dialog[open] button[type=submit]')!
    .click()
}
function Probe() {
  const scope = usePageScope()
  const overlay = useOverlayStore()
  const navigate = useNavigate()
  const location = useLocation()
  const [drawer, setDrawer] = useState(false)
  const [draft, setDraft] = useState('20')
  const [fieldError, setFieldError] = useState<string>()
  const [output, setOutput] = useState(report)
  const [running, setRunning] = useState(false)
  useLayoutEffect(() => {
    if (drawer && fieldError) document.getElementById('fixture-limit')?.focus()
  }, [drawer, fieldError])
  const [readMode, setReadMode] = useState('success')
  const failRead = useRef(false)
  const ordinary = useQuery({
    queryKey: ['feedback-example', readMode],
    retry: false,
    queryFn: async () => {
      await wait()
      if (readMode === 'error' || failRead.current)
        throw new ApiError('network')
      return readMode === 'empty' ? [] : ['已读取记录']
    },
  })
  const verify = (condition: unknown, message: string) => {
    if (!condition) throw new Error(message)
    report += `✓ ${message}\n`
    setOutput(report)
  }
  const start = async () => {
    setRunning(true)
    report = ''
    setOutput('')
    try {
      transport.reset()
      overlay.getState().open(scope, { kind: 'clearData' })
      await until(() => !!document.querySelector('dialog[open]'))
      verify(
        document.activeElement?.textContent === '取消',
        '危险确认默认聚焦取消，原生模态打开',
      )
      formSubmit()
      await wait()
      verify(transport.writes.length === 0, '未匹配短语零请求')
      type('clear-confirmation', '永久清空全部数据 ')
      await wait()
      formSubmit()
      await wait()
      verify(transport.writes.length === 0, '不接受带空格短语')
      click('取消')
      await until(() => !document.querySelector('dialog[open]'))
      verify(transport.writes.length === 0, '取消零请求')
      overlay.getState().open(scope, { kind: 'clearData' })
      await wait()
      type('clear-confirmation', '永久清空全部数据')
      await wait()
      const input = document.getElementById('clear-confirmation')!
      input.dispatchEvent(
        new CompositionEvent('compositionstart', { bubbles: true }),
      )
      formSubmit()
      await wait()
      verify(transport.writes.length === 0, '输入法合成期间不提交')
      input.dispatchEvent(
        new CompositionEvent('compositionend', { bubbles: true }),
      )
      transport.hold()
      formSubmit()
      formSubmit()
      await until(() => transport.writes.length === 1)
      verify(transport.writes.length === 1, '同步连点闸门只发一次清空')
      click('取消')
      await wait()
      overlay.getState().open(scope, { kind: 'clearData' })
      await wait()
      verify(
        document.querySelector<HTMLButtonElement>(
          'dialog[open] button[type=submit]',
        )!.disabled,
        '关闭后打开新确认仍阻止并发提交',
      )
      const newer = overlay.getState().active!.instanceId
      transport.release()
      await until(() => !!document.querySelector('.host-result'))
      verify(
        overlay.getState().active?.instanceId === newer,
        '迟到成功不关闭新弹窗',
      )
      verify(
        JSON.stringify(transport.writes[0]?.body) ===
          JSON.stringify({ confirmation: '永久清空全部数据' }),
        '清空使用原 confirmation body',
      )
      click('取消')
      await wait()
      transport.reset()
      transport.set({
        lifecycleStatus: 'ended',
        pokerPhase: 'betweenHands',
        agentRunState: 'idle',
        hand: null,
      })
      await runtime.refresh(ids.session)
      await wait()
      click('删除本场')
      await until(() => !!document.querySelector('dialog[open]'))
      await until(
        () =>
          !document.querySelector<HTMLButtonElement>(
            'dialog[open] button[type=submit]',
          )!.disabled,
      )
      formSubmit()
      await until(
        () =>
          transport.writes.length === 1 &&
          !document.querySelector('dialog[open]'),
      )
      await until(() =>
        document.body.textContent!.includes('永久删除本场已完成'),
      )
      verify(
        JSON.stringify(transport.writes[0]?.body) ===
          JSON.stringify({ confirmation: '永久删除本场' }),
        '单场删除成功并执行缓存移除',
      )
      transport.reset()
      transport.set({
        lifecycleStatus: 'ended',
        pokerPhase: 'betweenHands',
        agentRunState: 'idle',
        hand: null,
      })
      await runtime.refresh(ids.session)
      await wait()
      click('删除本场')
      await until(() => !!document.querySelector('dialog[open]'))
      await until(
        () =>
          !document.querySelector<HTMLButtonElement>(
            'dialog[open] button[type=submit]',
          )!.disabled,
      )
      transport.fail('write')
      formSubmit()
      await until(
        () =>
          !!document
            .querySelector('dialog[open]')
            ?.textContent?.includes('操作结果尚未确认'),
      )
      verify(
        document
          .querySelector('dialog[open]')!
          .textContent!.includes('尚未确认'),
        'DELETE 网络失败显示结果未知',
      )
      verify(
        document.querySelector<HTMLButtonElement>(
          'dialog[open] button[type=submit]',
        )!.disabled,
        '结果未知不能直接重试删除',
      )
      transport.fail('none')
      click('重新读取状态')
      await until(() => !document.querySelector('dialog[open]'))
      verify(
        document.body.textContent!.includes('重新打开并确认'),
        '恢复读取后必须重新确认',
      )
      verify(transport.writes.length === 1, '重新读取没有补发 DELETE')
      report += '自动主链通过；键盘、触屏与版式另行验收。\n'
      setOutput(report)
    } catch (error) {
      report += `失败：${String(error)}\n`
      setOutput(report)
    } finally {
      setRunning(false)
    }
  }
  const regression = async () => {
    setRunning(true)
    report = ''
    setOutput('')
    const backdrop = () => {
      const dialog = document.querySelector('dialog[open]')!
      dialog.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      dialog.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    }
    try {
      transport.reset()
      click('打开筛选')
      await until(() => !!document.querySelector('dialog[open]'))
      backdrop()
      await wait()
      verify(!document.querySelector('dialog[open]'), '筛选仍允许遮罩关闭')
      click('打开清空确认')
      await until(() => !!document.querySelector('dialog[open]'))
      type('clear-confirmation', '永久清空全部数据')
      await wait()
      backdrop()
      await wait()
      verify(
        document.querySelector<HTMLInputElement>('#clear-confirmation')
          ?.value === '永久清空全部数据' &&
          !!document.querySelector('dialog[open]'),
        '清空确认遮罩不关闭且保留输入',
      )
      transport.hold()
      formSubmit()
      await until(() => transport.writes.length === 1)
      await wait()
      verify(
        document.querySelector<HTMLInputElement>('#clear-confirmation')
          ?.disabled,
        '清空请求挂起时短语输入禁用',
      )
      backdrop()
      await wait()
      verify(!!document.querySelector('dialog[open]'), '提交中遮罩不关闭')
      click('取消')
      await until(() => !document.querySelector('dialog[open]'))
      transport.release()
      await until(() =>
        document.body.textContent!.includes('永久清空全部数据已完成'),
      )
      transport.reset()
      transport.set({
        lifecycleStatus: 'ended',
        pokerPhase: 'betweenHands',
        agentRunState: 'idle',
        hand: null,
      })
      await runtime.refresh(ids.session)
      await wait()
      click('删除本场')
      await until(() => !!document.querySelector('dialog[open]'))
      backdrop()
      await wait()
      verify(!!document.querySelector('dialog[open]'), '删除确认遮罩不关闭')
      click('取消')
      await until(() => !document.querySelector('dialog[open]'))
      click('进入测试牌桌')
      await until(() =>
        [...document.querySelectorAll('button')].some(
          (b) => b.textContent === '暂停本手',
        ),
      )
      click('暂停本手')
      await until(() =>
        [...document.querySelectorAll('button')].some(
          (b) => b.textContent === '打开中止确认' && !b.disabled,
        ),
      )
      click('打开中止确认')
      await until(() => !!document.querySelector('dialog[open]'))
      document
        .querySelector<HTMLInputElement>('dialog[open] input[type=checkbox]')!
        .click()
      await wait()
      backdrop()
      await wait()
      verify(
        document.querySelector<HTMLInputElement>(
          'dialog[open] input[type=checkbox]',
        )?.checked,
        '中止确认遮罩不关闭且保留勾选',
      )
      transport.hold()
      formSubmit()
      await until(() => transport.writes.length === 1)
      await wait()
      verify(
        document.querySelector<HTMLInputElement>(
          'dialog[open] input[type=checkbox]',
        )?.disabled,
        '中止请求挂起时复选框禁用',
      )
      click('取消')
      await until(() => !document.querySelector('dialog[open]'))
      transport.release()
      await until(() =>
        document.body.textContent!.includes('中止本手并结束场次已完成'),
      )
      report += '回归验收通过。\n'
    } catch (error) {
      report += `失败：${String(error)}\n`
    } finally {
      transport.release()
      navigate('/')
      setOutput(report)
      setRunning(false)
    }
  }
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <p>独立假传输验收：不会连接后端或数据库。</p>
      <Button disabled={running} onClick={() => void start()}>
        运行确认主链验收
      </Button>
      <Button disabled={running} onClick={() => void regression()}>
        运行确认修复回归
      </Button>
      <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{output}</pre>
      <Button
        onClick={() => overlay.getState().open(scope, { kind: 'clearData' })}
      >
        打开清空确认
      </Button>
      <DeleteSessionTrigger sessionId={ids.session} />
      <Button
        onClick={() => {
          transport.reset()
          navigate(resourcePath('table', ids.session))
        }}
      >
        进入测试牌桌
      </Button>
      <Button
        onClick={() => {
          setDraft(String(historySearch.decode(location.search).query.limit))
          setFieldError(undefined)
          setDrawer(true)
        }}
      >
        打开筛选
      </Button>
      <output>
        当前 URL：{location.pathname}
        {location.search}
      </output>
      <FilterDrawer
        open={drawer}
        onClose={() => setDrawer(false)}
        searchKey={location.search}
        onReset={() => setDraft('20')}
        onApply={() => {
          try {
            const next = historySearch.normalize({
              query: {
                ...historySearch.decode(location.search).query,
                limit: Number(draft),
              },
              cursor: null,
            })
            navigate({ search: historySearch.encode(next) })
            return true
          } catch {
            setFieldError('请输入 1–100 的记录数。')
            return false
          }
        }}
      >
        <form onSubmit={(event) => event.preventDefault()}>
          <Field
            id="fixture-limit"
            label="每页条数"
            error={fieldError}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </form>
        <p>修改草稿不读取数据；应用才更新 URL。</p>
      </FilterDrawer>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          const messages = fieldMessages(
            new ApiError('input', undefined, undefined, [
              'confirmation',
              'unknown',
            ]),
            ['confirmation'],
          )
          setFieldError(messages.confirmation)
          const form = event.currentTarget
          requestAnimationFrame(() => focusFirstInvalid(form))
        }}
      >
        <Field id="example-field" label="已知字段错误示例" error={fieldError} />
        <Button type="submit">验证字段</Button>
      </form>
      <div className="page-links">
        {['success', 'empty', 'error'].map((mode) => (
          <Button
            key={mode}
            onClick={() => {
              failRead.current = false
              setReadMode(mode)
            }}
          >
            {mode}
          </Button>
        ))}
      </div>
      <Button
        onClick={() => {
          failRead.current = true
          void ordinary.refetch()
        }}
      >
        后台读取失败
      </Button>
      {ordinary.isFetching ? (
        <LoadingFeedback refreshing={!!ordinary.data} />
      ) : null}
      {ordinary.error ? (
        <RequestError
          error={ordinary.error}
          hasData={!!ordinary.data}
          retry={() => {
            failRead.current = false
            void ordinary.refetch()
          }}
        />
      ) : null}
      {ordinary.data?.length ? (
        <Feedback title="已读取记录" />
      ) : ordinary.data ? (
        <EmptyState title="还没有记录" description="开始练习后可在此回看。" />
      ) : null}
    </div>
  )
}
function TableProbe() {
  const session = useSession(ids.session)
  const scope = usePageScope()
  const overlay = useOverlayStore()
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <output>
        同步状态：{session.status}；可提交：{String(session.canSubmit)}
      </output>
      <Button
        disabled={
          !session.canSubmit ||
          session.data?.agentRunState !== 'paused' ||
          !session.data.hand
        }
        onClick={() =>
          overlay.getState().open(scope, {
            kind: 'abortHandAndEndSession',
            sessionId: ids.session,
            handId: session.data!.hand!.handId,
            stateVersion: session.data!.stateVersion,
          })
        }
      >
        打开中止确认
      </Button>
      <Button
        onClick={() =>
          transport.set({
            agentRunState: 'paused',
            hand: { ...transport.get().hand!, legalActions: [] },
            eventSeq: transport.get().eventSeq + 1,
          })
        }
      >
        暂停本手
      </Button>
      <Button
        onClick={() => {
          transport.fail('read')
          transport.disconnect()
        }}
      >
        断开传输
      </Button>
      <Button
        onClick={() => {
          transport.fail('none')
          void runtime.refresh(ids.session).catch(() => {})
        }}
      >
        恢复传输
      </Button>
      <Button
        onClick={() =>
          transport.set({
            stateVersion: 0,
            eventSeq: transport.get().eventSeq + 1,
          })
        }
      >
        注入版本倒退
      </Button>
      <Button onClick={() => transport.fail('write')}>模拟命令断网</Button>
      <Button onClick={() => transport.fail('none')}>恢复命令响应</Button>
      <Button onClick={() => transport.fail('sync-after-write')}>
        模拟成功后同步失败
      </Button>
      <Button
        onClick={() =>
          transport.set({
            stateVersion: transport.get().stateVersion + 1,
            eventSeq: transport.get().eventSeq + 1,
          })
        }
      >
        推进版本
      </Button>
      <Button
        onClick={() =>
          transport.set({
            lifecycleStatus: 'readonlyDiagnostic',
            agentRunState: 'paused',
            hand: { ...transport.get().hand!, legalActions: [] },
            stateVersion: transport.get().stateVersion + 1,
            eventSeq: transport.get().eventSeq + 1,
          })
        }
      >
        进入服务只读
      </Button>
      <output>写请求：{JSON.stringify(transport.writes)}</output>
      <Link to={resourcePath('currentHand', ids.session)}>打开本手详情</Link>
    </div>
  )
}
function TestRoutes() {
  return useRoutes([
    {
      element: <Shell />,
      children: routes.map((route) => ({
        ...route,
        element:
          route.id === 'table' ? (
            <TableProbe />
          ) : route.id === 'currentHand' ? (
            <p>本手详情验收内容</p>
          ) : (
            <Probe />
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
          <MemoryRouter
            initialEntries={
              scenario.has('readonly-empty')
                ? [resourcePath('table', ids.session)]
                : ['/']
            }
          >
            <TestRoutes />
          </MemoryRouter>
        </OverlayUiProvider>
      </SessionRuntimeProvider>
    </QueryClientProvider>
  </StrictMode>,
)

if (import.meta.hot)
  import.meta.hot.dispose(() => {
    root.unmount()
    client.clear()
  })
