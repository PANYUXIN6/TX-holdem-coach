import { DrawerSurface } from '../src/components/surfaces.js'
import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useRoutes } from 'react-router'
import { Shell } from '../src/Shell.js'
import { Page } from '../src/Pages.js'
import { routes } from '../src/navigation.js'
import { createQueryClient } from '../src/query/client.js'
import { createSessionRuntime } from '../src/session-sync/runtime.js'
import { SessionRuntimeProvider } from '../src/session-sync/react.js'
import { OverlayUiProvider } from '../src/ui/react.js'
import { CARD_RANKS, CARD_SUITS } from '@tx-holdem-coach/contracts'
import { Avatar, PlayingCard, ChipAmount } from '../src/components/identity.js'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Button,
  Field,
  StatusBadge,
  EmptyState,
  DangerSection,
} from '../src/components/controls.js'
import '../src/styles.css'
import './visual.css'

// Checks inspect production DOM; test controls stay outside the product build.
function checkViewport() {
  const problems: string[] = []
  if (document.documentElement.scrollWidth > innerWidth)
    problems.push('页面横向溢出')
  for (const element of document.querySelectorAll<HTMLElement>(
    '.page-content, .drawer-content, .visual-stack',
  )) {
    if (element.scrollWidth > element.clientWidth + 1)
      problems.push(`内容横向溢出 ${element.className}`)
  }
  for (const element of document.querySelectorAll<HTMLElement>(
    'button, .field-control',
  )) {
    if (!element.getClientRects().length) continue
    const bounds = element.getBoundingClientRect()
    const minimum = element.closest('.drawer-close')
      ? 44
      : element.tagName === 'BUTTON'
        ? 48
        : 48
    if (bounds.height < minimum || bounds.width < 44)
      problems.push(`触控尺寸 ${element.textContent || element.id}`)
  }
  const images = [
    ...document.querySelectorAll<HTMLImageElement>('.playing-card img'),
  ]
  if (
    images.some(
      (image) =>
        !image.complete ||
        image.naturalWidth !== 153 ||
        image.naturalHeight !== 216,
    )
  )
    problems.push('牌图加载或尺寸异常')
  const field = document.getElementById('amount')!
  if (
    field.getAttribute('aria-describedby') !== 'amount-hint amount-error' ||
    field.getAttribute('aria-invalid') !== 'true'
  )
    problems.push('字段错误关联')
  if (
    document.querySelector('.card-back img')?.getAttribute('src') !==
      '/poker/card_back.png' ||
    document.querySelector('.card-empty img')
  )
    problems.push('三态资源边界')
  return problems.length
    ? `FAIL ${problems.join('；')}`
    : `PASS ${innerWidth}×${innerHeight} · 内容无横向溢出 · 触控尺寸 · ${images.length} 张图片 · 字段语义 · 三态边界`
}
const motionRules: CSSMediaRule[] = []
function setMotionMedia(reduced: boolean) {
  if (!motionRules.length)
    for (const sheet of document.styleSheets)
      for (const rule of sheet.cssRules) {
        if (
          rule instanceof CSSMediaRule &&
          rule.conditionText === '(prefers-reduced-motion: reduce)'
        )
          motionRules.push(rule)
      }
  // Activate the production media rule for deterministic desktop simulation, not an OS preference claim.
  for (const rule of motionRules)
    rule.media.mediaText = reduced ? 'all' : '(prefers-reduced-motion: reduce)'
}

function Gallery() {
  const [amount, setAmount] = useState('120')
  const [selected, setSelected] = useState(false)
  const [report, setReport] = useState('尚未运行视口检查')
  const [zoom, setZoom] = useState(false)
  const [reduced, setReduced] = useState(false)
  const [drawer, setDrawer] = useState(true)
  const [effect, setEffect] = useState(0)
  const [count, setCount] = useState(0)
  return (
    <div className="visual-stack">
      <p className="eyebrow">M6.5 / 独立视觉验收 · 非产品页面</p>
      <h2>深色牌室 · 视觉基础</h2>
      <div className="visual-row">
        <Button variant="secondary" onClick={() => setReport(checkViewport())}>
          运行当前视口检查
        </Button>
        <Button
          variant="secondary"
          aria-pressed={zoom}
          onClick={() => {
            document.documentElement.style.fontSize = zoom ? '' : '200%'
            setZoom(!zoom)
          }}
        >
          {zoom ? '恢复文字大小' : '模拟 200% 文字'}
        </Button>
        <Button
          variant="secondary"
          aria-pressed={reduced}
          onClick={() => {
            setMotionMedia(!reduced)
            setReduced(!reduced)
          }}
        >
          {reduced ? '恢复系统动效偏好' : '模拟减少动态效果'}
        </Button>
      </div>
      <Button
        variant="secondary"
        onClick={() => {
          setEffect((n) => n + 1)
          // Fixture-only timer observes cancellation during the production 200ms effect.
          window.setTimeout(() => {
            const element = document.querySelector('.effect-deal')!
            const before = getComputedStyle(element).animationName
            setMotionMedia(true)
            setReduced(true)
            setReport(
              `运行中取消：${before} → ${getComputedStyle(element).animationName}；transform=${getComputedStyle(element).transform}`,
            )
          }, 60)
        }}
      >
        检查运行中取消动效
      </Button>
      <output className="visual-report">{report}</output>
      <section className="visual-stack">
        <h2>行动与反馈</h2>
        <div className="visual-row">
          {(
            ['primary', 'secondary', 'fold', 'call', 'raise', 'danger'] as const
          ).map((variant, i) => (
            <Button
              key={variant}
              variant={variant}
              onClick={() => setCount((n) => n + 1)}
            >
              {
                ['开始练习', '返回', '弃牌', '跟注 20', '加到 120', '永久删除'][
                  i
                ]
              }
            </Button>
          ))}
        </div>
        <output>样例点击 {count} 次</output>
        <Button disabled>暂不可用</Button>
        <Button
          variant="secondary"
          aria-pressed={selected}
          onClick={() => setSelected(!selected)}
        >
          {selected ? '✓ 已选中人物' : '选择人物'}
        </Button>
        <div className="visual-row">
          <StatusBadge>等待中</StatusBadge>
          <StatusBadge tone="active">行动中</StatusBadge>
          <StatusBadge tone="paused">已暂停</StatusBadge>
          <StatusBadge tone="danger">输入有误</StatusBadge>
        </div>
      </section>
      <section className="visual-stack">
        <h2>字段与说明</h2>
        <Field
          id="amount"
          label="加到（筹码）"
          inputMode="numeric"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          hint="输入保留为字符串，样例不发送命令。"
          error="请输入允许范围内的筹码金额。"
        />
        <Field as="select" id="style" label="练习节奏" defaultValue="normal">
          <option value="normal">标准节奏</option>
          <option value="slow">慢速思考</option>
        </Field>
        <Field
          as="textarea"
          id="note"
          label="复盘笔记"
          placeholder="记录这一手的思考"
        />
        <Field
          id="disabled-field"
          label="不可用字段"
          disabled
          value="等待下一步"
        />
      </section>
      <section className="visual-stack">
        <h2>人物与公开牌</h2>
        <div className="visual-row">
          {([32, 40, 48] as const).map((size) => (
            <Avatar
              key={size}
              displayName="陈小明"
              avatarColor="#0F766E"
              size={size}
            />
          ))}
          <span>陈小明与一位拥有很长中文名称的练习伙伴</span>
        </div>
        <p>
          历史快照 ·{' '}
          <Avatar displayName="旧时人物" avatarColor="#1E3A8A" decorative />{' '}
          旧时人物
        </p>
        <ChipAmount amount={123456789012345} />
        <div className="card-row" data-testid="board">
          {(['A', 'T', '7', '4', '2'] as const).map((rank) => (
            <PlayingCard
              key={rank}
              state="face"
              card={{ suit: 'hearts', rank }}
            />
          ))}
        </div>
        <div className="visual-row">
          <PlayingCard
            state="face"
            size={36}
            card={{ suit: 'spades', rank: 'A' }}
          />
          <PlayingCard
            state="face"
            size={56}
            card={{ suit: 'clubs', rank: 'K' }}
          />
          <PlayingCard state="back" />
          <PlayingCard state="empty" label="尚未发出的公共牌" />
        </div>
        <Button
          variant="secondary"
          onClick={() =>
            document
              .querySelector('[data-testid="board"] img')
              ?.dispatchEvent(new Event('error'))
          }
        >
          模拟已公开牌图失败
        </Button>
        <details>
          <summary>全部 52 张资源验收</summary>
          <div className="visual-row" data-testid="deck">
            {CARD_SUITS.flatMap((suit) =>
              CARD_RANKS.map((rank) => (
                <PlayingCard
                  key={`${suit}-${rank}`}
                  state="face"
                  card={{ suit, rank }}
                />
              )),
            )}
          </div>
        </details>
      </section>
      <section className="visual-stack">
        <h2>表面与单次动效</h2>
        <p>内联 section 样例；不具有模态或背景锁定行为。</p>
        <Button variant="secondary" onClick={() => setDrawer(!drawer)}>
          {drawer ? '收起抽屉样例' : '展开抽屉样例'}
        </Button>
        {drawer ? (
          <DrawerSurface
            title="本手详情样例"
            closeAction={
              <Button
                variant="secondary"
                aria-label="关闭抽屉样例"
                onClick={() => setDrawer(false)}
              >
                ×
              </Button>
            }
            actions={<Button onClick={() => setDrawer(false)}>完成查看</Button>}
          >
            <div className="visual-stack">
              {Array.from({ length: 8 }, (_, i) => (
                <p key={i}>
                  第 {i + 1}{' '}
                  段：长内容在表面内部滚动，底部操作始终可达。详情路由仍由生产
                  Shell 管理。
                </p>
              ))}
              <Field id="drawer-input" label="末尾输入" />
            </div>
          </DrawerSurface>
        ) : null}
        <Button variant="secondary" onClick={() => setEffect((n) => n + 1)}>
          播放单次效果
        </Button>
        <div className="visual-row" key={effect}>
          <div className="effect-deal">
            <PlayingCard state="face" card={{ suit: 'diamonds', rank: 'T' }} />
          </div>
          <span className="effect-turn">
            <StatusBadge tone="active">行动中</StatusBadge>
          </span>
          <span className="effect-chips">
            <ChipAmount amount={120} />
          </span>
          <span className="effect-settlement">本手已完成</span>
        </div>
      </section>
      <EmptyState
        title="尚无收藏"
        description="这是独立空状态样例，由调用者决定何时显示。"
        action={<Button variant="secondary">浏览样例</Button>}
      />
      <DangerSection
        title="删除样例记录"
        description="永久删除后无法恢复。此处只展示危险区域，不执行删除。"
        action={<Button variant="danger">永久删除样例</Button>}
      />
    </div>
  )
}

// Test-only coarse-pointer emulation leaves production orientation handling intact.
if (new URLSearchParams(location.search).has('coarse')) {
  const native = window.matchMedia.bind(window)
  window.matchMedia = (query) =>
    native(query.replace('(pointer: coarse) and ', ''))
}
const queryClient = createQueryClient()
const runtime = createSessionRuntime(queryClient)
function FixtureRoutes() {
  const params = new URLSearchParams(location.search)
  const gallery = !params.has('shell')
  return useRoutes([
    {
      element: <Shell />,
      children: routes.map((route) => ({
        ...route,
        element: gallery ? <Gallery /> : <Page id={route.id} />,
      })),
    },
  ])
}
const initialPath = new URLSearchParams(location.search).get('path') ?? '/'
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <SessionRuntimeProvider runtime={runtime}>
      <OverlayUiProvider>
        <MemoryRouter initialEntries={[initialPath]}>
          <FixtureRoutes />
        </MemoryRouter>
      </OverlayUiProvider>
    </SessionRuntimeProvider>
  </QueryClientProvider>,
)
