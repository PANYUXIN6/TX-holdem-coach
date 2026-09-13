import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, useRoutes } from 'react-router'
import {
  PublicSessionSnapshotSchema,
  type PublicSessionSnapshot,
} from '@tx-holdem-coach/contracts'
import { Page } from '../src/Pages.js'
import { Shell } from '../src/Shell.js'
import { routes } from '../src/navigation.js'
import { createQueryClient } from '../src/query/client.js'
import { createSessionRuntime } from '../src/session-sync/runtime.js'
import { SessionRuntimeProvider } from '../src/session-sync/react.js'
import { OverlayUiProvider } from '../src/ui/react.js'
import { tableSnapshot, completeTable } from './table-fixtures.js'
import { ids } from './fixtures.js'
import '../src/styles.css'
const search = new URLSearchParams(location.search)
let reduced = false
let hidden = false
const mediaQueries = new Set<MediaQueryList>()
const nativeMatchMedia = window.matchMedia.bind(window)
window.matchMedia = (query) => {
  const media = nativeMatchMedia(query)
  if (query === '(prefers-reduced-motion: reduce)') {
    const original = media.matches
    Object.defineProperty(media, 'matches', { get: () => reduced || original })
    mediaQueries.add(media)
  }
  return media
}
const nativeHidden = Object.getOwnPropertyDescriptor(
  Document.prototype,
  'hidden',
)!.get!
Object.defineProperty(document, 'hidden', {
  get: () => hidden || nativeHidden.call(document),
})
const setReduced = (value: boolean) => {
  reduced = value
  mediaQueries.forEach((media) =>
    media.dispatchEvent(
      new MediaQueryListEvent('change', {
        matches: media.matches,
        media: media.media,
      }),
    ),
  )
}
const setHidden = (value: boolean) => {
  hidden = value
  document.dispatchEvent(new Event('visibilitychange'))
}
const count = Number(search.get('count') ?? 9)
if (search.has('zoom')) document.documentElement.style.fontSize = '32px'
if (search.has('touch')) {
  const original = window.matchMedia.bind(window)
  window.matchMedia = (query) =>
    original(query.replace('(pointer: coarse)', '(pointer: fine)'))
}
let snapshot = tableSnapshot(count, search.has('sparse'))
if (search.has('statuses')) {
  snapshot = PublicSessionSnapshotSchema.parse({
    ...snapshot,
    seats: snapshot.seats.map((seat) => ({
      ...seat,
      status:
        seat.seatNumber === 0
          ? 'folded'
          : seat.seatNumber === 1
            ? 'allIn'
            : seat.seatNumber === 8
              ? 'out'
              : 'active',
      stack: seat.seatNumber === 1 ? 0 : seat.stack,
    })),
    tableDisplay: {
      ...snapshot.tableDisplay!,
      hand: {
        ...snapshot.tableDisplay!.hand!,
        seats: snapshot
          .tableDisplay!.hand!.seats.filter((seat) => seat.seatNumber !== 8)
          .map((seat, index) => ({
            ...seat,
            position: ['BTN', 'SB', 'BB', 'UTG', 'MP', 'LJ', 'HJ', 'CO'][index],
          })),
      },
    },
  })
}
if (search.has('complete')) snapshot = completeTable(snapshot)
if (search.has('long'))
  snapshot.seats = snapshot.seats.map((seat) => ({
    ...seat,
    displayName: seat.isUser ? '你' : '善于思考的超长姓名对手',
    stack: 1234567890123,
  }))
let failure = ''
const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
const requests: string[] = []
const errors: string[] = []
window.addEventListener('unhandledrejection', (event) =>
  errors.push(String(event.reason)),
)
const frame = (
  stream: ReadableStreamDefaultController<Uint8Array>,
  type: string,
) =>
  stream.enqueue(
    new TextEncoder().encode(
      `id: ${snapshot.eventSeq}\ndata: ${JSON.stringify({ eventId: ids.event, sessionId: ids.session, stateVersion: snapshot.stateVersion, eventSeq: snapshot.eventSeq, type, payload: { snapshot } })}\n\n`,
    ),
  )
window.fetch = async (input, init) => {
  const path = String(input)
  requests.push(`${init?.method ?? 'GET'} ${path}`)
  if (init?.method === 'POST') throw new Error('牌桌展示不得发送扑克命令')
  if (failure)
    return Response.json(
      {
        code:
          failure === 'missing'
            ? 'SESSION_NOT_FOUND'
            : failure === 'readonly'
              ? 'SESSION_READONLY_DIAGNOSTIC'
              : 'SERVICE_UNAVAILABLE',
        message: '受控读取失败',
      },
      {
        status:
          failure === 'missing' ? 404 : failure === 'readonly' ? 409 : 503,
      },
    )
  if (path.includes('/events')) {
    let controller: ReadableStreamDefaultController<Uint8Array>
    return new Response(
      new ReadableStream({
        start(stream) {
          controller = stream
          streams.add(stream)
          frame(stream, 'snapshot')
          init?.signal?.addEventListener(
            'abort',
            () => {
              streams.delete(stream)
              try {
                stream.close()
              } catch {}
            },
            { once: true },
          )
        },
        cancel() {
          streams.delete(controller)
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    )
  }
  return Response.json({ snapshot })
}
const client = createQueryClient()
const runtime = createSessionRuntime(client)
history.replaceState(null, '', `/sessions/${ids.session}`)
function Application() {
  return useRoutes([
    {
      element: (
        <Shell
          tableActions={
            search.has('footer') ? (
              <div style={{ height: 160 }}>夹具底部容器 160px</div>
            ) : undefined
          }
        />
      ),
      children: routes.map((route) => ({
        ...route,
        element: <Page id={route.id} />,
      })),
    },
  ])
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <SessionRuntimeProvider runtime={runtime}>
        <OverlayUiProvider>
          <BrowserRouter>
            <Application />
          </BrowserRouter>
        </OverlayUiProvider>
      </SessionRuntimeProvider>
    </QueryClientProvider>
  </StrictMode>,
)
const update = (next: PublicSessionSnapshot, type = 'actionCommitted') => {
  snapshot = PublicSessionSnapshotSchema.parse({
    ...next,
    stateVersion: snapshot.stateVersion + 1,
    eventSeq: snapshot.eventSeq + 1,
  })
  streams.forEach((stream) => frame(stream, type))
}
const actions: Record<string, () => void> = {
  thinking: () =>
    update(
      {
        ...snapshot,
        agentRunState: 'thinking',
        activeDecision: {
          decisionRequestId: ids.command,
          actorSeatNumber: snapshot.hand!.currentActorSeatNumber!,
        },
      },
      'agentStarted',
    ),
  hero: () =>
    update({
      ...snapshot,
      agentRunState: 'idle',
      activeDecision: null,
      hand: {
        ...snapshot.hand!,
        currentActorSeatNumber: 0,
        legalActions: [{ type: 'fold' }, { type: 'call', amount: 20 }],
      },
    }),
  flop: () =>
    update({
      ...snapshot,
      hand: {
        ...snapshot.hand!,
        street: 'flop',
        board: [
          { rank: '2', suit: 'clubs' },
          { rank: '4', suit: 'diamonds' },
          { rank: '6', suit: 'hearts' },
        ],
      },
      tableDisplay: {
        ...snapshot.tableDisplay!,
        hand: {
          ...snapshot.tableDisplay!.hand!,
          seats: snapshot.tableDisplay!.hand!.seats.map((seat) => ({
            ...seat,
            streetContribution: 0,
          })),
        },
      },
    }),
  paused: () =>
    update({
      ...snapshot,
      agentRunState: 'paused',
      activeDecision: null,
      hand: {
        ...snapshot.hand!,
        currentActorSeatNumber: snapshot.seats[3]!.seatNumber,
        legalActions: [],
      },
    }),
  complete: () => update(completeTable(snapshot), 'handCompleted'),
  next: () => {
    const handId = crypto.randomUUID()
    const next = tableSnapshot(count)
    update(
      {
        ...next,
        hand: { ...next.hand!, handId },
        tableDisplay: {
          ...next.tableDisplay!,
          completedHandCount: 1,
          hand: { ...next.tableDisplay!.hand!, handId },
        },
      },
      'handStarted',
    )
  },
  ended: () =>
    update(
      {
        ...snapshot,
        hand: null,
        pokerPhase: 'betweenHands',
        lifecycleStatus: 'ended',
        agentRunState: 'idle',
        activeDecision: null,
        tableDisplay: { ...snapshot.tableDisplay!, hand: null },
      },
      'sessionEnded',
    ),
  legacy: () => {
    const { tableDisplay: _, ...legacy } = snapshot
    update(legacy)
  },
  calibrate: () => {
    snapshot = {
      ...tableSnapshot(count),
      stateVersion: snapshot.stateVersion,
      eventSeq: snapshot.eventSeq,
    }
    void runtime.refresh(ids.session)
  },
  missing: () => {
    failure = 'missing'
    void runtime.refresh(ids.session).catch(() => {})
  },
  readonly: () => {
    failure = 'readonly'
    void runtime.refresh(ids.session).catch(() => {})
  },
  disconnect: () => {
    failure = 'read'
    streams.forEach((stream) => stream.close())
    streams.clear()
  },
}
Object.assign(window, {
  tableFixture: {
    actions,
    requests,
    errors,
    runtime,
    snapshot: () => snapshot,
  },
})
if (search.has('controls')) {
  const controls = document.createElement('aside')
  for (const [name, action] of Object.entries(actions)) {
    const button = document.createElement('button')
    button.textContent = name
    button.onclick = action
    controls.append(button)
  }
  document.body.append(controls)
}
const check = document.createElement('button')
check.textContent = '运行牌桌生命周期验收'
const result = document.createElement('pre')
result.id = 'table-check-result'
result.style.cssText = 'white-space:pre-wrap;max-width:430px'
const until = async (condition: () => unknown) => {
  const deadline = Date.now() + 4000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('等待可观察结果超时')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
check.onclick = () => {
  check.disabled = true
  const pass = (ok: unknown, label: string) => {
    if (!ok) throw new Error(label)
    result.textContent += `✓ ${label}\n`
  }
  void (async () => {
    await until(() => runtime.getStatus(ids.session) === 'ready')
    pass(document.getAnimations().length === 0, '首次 GET 校准不补播')
    const seatNodes = [...document.querySelectorAll('.table-seat')]
    const positions = seatNodes.map((node) =>
      node.className.replace('is-acting', '').trim(),
    )
    const center = document.querySelector('.table-center')!
    center.scrollIntoView({ block: 'center' })
    const original = Element.prototype.animate
    const created: Animation[] = []
    Element.prototype.animate = function (...args) {
      const animation = original.apply(this, args)
      created.push(animation)
      return animation
    }
    try {
      actions.flop!()
      await until(() =>
        document.querySelector('.table-board')?.textContent?.includes('6'),
      )
      await until(() => created.length > 0)
      pass(created.length > 0, '实时翻牌创建有界效果')
      actions.hero!()
      actions.complete!()
      await until(() =>
        document.querySelector('.table-pot')?.textContent?.includes('已分配'),
      )
      await until(() =>
        created.every(
          (animation) =>
            animation.playState === 'idle' ||
            animation.playState === 'finished',
        ),
      )
      pass(
        document.getAnimations().length === 0,
        '快速替换后旧效果全部结束或取消',
      )
      pass(
        seatNodes.every(
          (node, index) =>
            node === document.querySelectorAll('.table-seat')[index],
        ),
        '完成手后 DOM 座位身份保持',
      )
      pass(
        positions.every(
          (value, index) =>
            value ===
            document
              .querySelectorAll('.table-seat')
              [index]!.className.replace('is-acting', '')
              .trim(),
        ),
        '跨状态视觉锚点保持',
      )
      actions.next!()
      await until(() =>
        document.querySelector('.table-pot')?.textContent?.includes('底池合计'),
      )
      ;(
        document.querySelector('.table-center button') as HTMLButtonElement
      ).click()
      await until(() => !!document.querySelector('dialog[open]'))
      actions.complete!()
      await until(
        () =>
          document.querySelector('dialog[open] h2')?.textContent ===
          '本手已分配',
      )
      pass(true, '同手完成时底池弹窗实时变为最终分配')
      actions.next!()
      await until(() => !document.querySelector('dialog[open]'))
      pass(true, '换手关闭来源失效的底池弹窗')
      actions.legacy!()
      await until(() =>
        document
          .querySelector('.table-summary')
          ?.textContent?.includes('待校准'),
      )
      pass(
        !document.querySelector('.seat-contribution'),
        '旧块缺省不沿用上一版本投入',
      )
      actions.calibrate!()
      await until(() =>
        document
          .querySelector('.table-summary')
          ?.textContent?.includes('盲注 10/20'),
      )
      await until(() => runtime.getStatus(ids.session) === 'ready')
      pass(document.getAnimations().length === 0, '旧格式恢复 GET 不追赶动画')
      pass(errors.length === 0, '无未处理 Promise 拒绝')
      pass(
        requests.every((request) => request.startsWith('GET ')),
        '展示旅程没有新增扑克 POST',
      )
      result.textContent += '全部通过\n'
    } finally {
      Element.prototype.animate = original
    }
  })()
    .catch((error) => {
      result.textContent += `失败：${String(error)}\n`
    })
    .finally(() => {
      check.disabled = false
    })
}
if (search.has('controls')) document.body.append(check, result)

const environmentCheck = document.createElement('button')
environmentCheck.textContent = '运行环境取消验收'
environmentCheck.onclick = () => {
  environmentCheck.disabled = true
  result.textContent = ''
  void (async () => {
    await until(() => runtime.getStatus(ids.session) === 'ready')
    document.querySelector('.table-center')!.scrollIntoView({ block: 'center' })
    actions.next!()
    await until(() => document.getAnimations().length > 0)
    setReduced(true)
    await until(() => document.getAnimations().length === 0)
    result.textContent += '✓ 开启减少动态效果取消原生动画\n'
    actions.next!()
    await new Promise((resolve) => setTimeout(resolve, 50))
    if (document.getAnimations().length)
      throw new Error('减少动态效果期间仍播放')
    result.textContent += '✓ 减少动态效果期间静态牌面仍存在\n'
    setReduced(false)
    actions.next!()
    await until(() => document.getAnimations().length > 0)
    setHidden(true)
    await until(() => document.getAnimations().length === 0)
    result.textContent += '✓ 隐藏取消运行中的动画\n'
    setHidden(false)
    await until(() => runtime.getStatus(ids.session) === 'ready')
    if (document.getAnimations().length || errors.length)
      throw new Error('恢复补播或拒绝泄漏')
    result.textContent += '✓ 可见性恢复校准不补播、无未处理拒绝\n全部通过\n'
  })()
    .catch((error) => {
      result.textContent += `失败：${String(error)}\n`
    })
    .finally(() => {
      setReduced(false)
      setHidden(false)
      environmentCheck.disabled = false
    })
}
if (search.has('controls')) document.body.append(environmentCheck)
