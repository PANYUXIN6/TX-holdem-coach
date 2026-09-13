import { useEffect, useRef, useSyncExternalStore } from 'react'
import {
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query'
import { Link } from 'react-router'
import {
  ApiError,
  providerErrorMessages,
  providerStatusMessages,
} from '../api/errors.js'
import { Button, StatusBadge } from '../components/controls.js'
import { Avatar, ChipAmount } from '../components/identity.js'
import {
  Feedback,
  LoadingFeedback,
  RequestError,
} from '../components/feedback.js'
import {
  newSessionPath,
  paths,
  resourcePath,
  sessionHistoryPath,
} from '../navigation.js'
import { keys } from '../query/keys.js'
import { queries } from '../query/options.js'
import { useSession, useSessionRuntime } from '../session-sync/react.js'
import {
  homeSessions,
  localTime,
  preparationAllowed,
  settlementText,
  userAccounting,
} from './model.js'

// disabled Query 观察者不会对删除事件重算；直接订阅原键的有效性，不保存实体副本。
function useActiveCacheValid(id: string | null | undefined) {
  const client = useQueryClient()
  return useSyncExternalStore(
    (listener) => client.getQueryCache().subscribe(listener),
    () => {
      if (!id) return false
      const state = client.getQueryState<
        import('@tx-holdem-coach/contracts').PublicSessionSnapshot
      >(keys.session(id))
      return state?.data?.lifecycleStatus === 'active' && !state.isInvalidated
    },
  )
}
function ReadFeedback({ query }: { query: UseQueryResult<unknown> }) {
  return (
    <>
      {query.isFetching || query.isPending ? (
        <LoadingFeedback refreshing={query.data !== undefined} />
      ) : null}
      {query.isError ? (
        <RequestError
          error={query.error}
          hasData={query.data !== undefined}
          busy={query.isFetching}
          retry={() => void query.refetch()}
        />
      ) : null}
    </>
  )
}
function ActiveCard({
  id,
  current,
  relocate,
}: {
  id: string
  current: boolean
  relocate: () => void
}) {
  const snapshot = useSession(id, { enabled: false })
  const summary = useQuery(queries.sessions(homeSessions('active')))
  const valid = useActiveCacheValid(id)
  const attempted = useRef(false)
  useEffect(() => {
    if (valid) attempted.current = false
    else if (!attempted.current) {
      attempted.current = true
      relocate()
    }
  }, [valid, relocate])
  if (!valid || !snapshot.data)
    return (
      <Feedback
        title="场次摘要已失效，请重新定位"
        action={
          <Button variant="secondary" onClick={relocate}>
            重新读取活动场次
          </Button>
        }
      />
    )
  const data = snapshot.data
  const count = summary.data?.items.find(
    (item) => item.sessionId === id,
  )?.completedHandCount
  const user = data.seats.find((seat) => seat.isUser)
  return (
    <div className="home-active">
      <div className="home-heading">
        <StatusBadge tone="active">
          {data.pokerPhase === 'inHand' ? '本手进行中' : '等待下一手'}
        </StatusBadge>
        <span className="home-muted">
          {count !== undefined ? `已完成 ${count} 手` : '已完成手数暂不可用'}
        </span>
      </div>
      <ReadFeedback query={summary} />
      {count === undefined && !summary.isFetching ? (
        <Button
          variant="secondary"
          onClick={() => {
            relocate()
            void summary.refetch()
          }}
        >
          重新读取完成手数
        </Button>
      ) : null}
      <p className="home-stack">
        你的筹码 {user ? <ChipAmount amount={user.stack} /> : '暂不可用'}
      </p>
      <Link className="primary-link" to={resourcePath('table', id)}>
        {current ? '继续训练' : '查看上次场次'}{' '}
        <span aria-hidden="true">↗</span>
      </Link>
      <ul className="home-roster">
        {data.seats
          .filter((seat) => !seat.isUser)
          .map((seat) => (
            <li key={seat.seatNumber}>
              <Avatar
                displayName={seat.displayName}
                avatarColor={seat.avatarColor}
                size={32}
                decorative
              />
              <span>{seat.displayName}</span>
            </li>
          ))}
      </ul>
      {data.agentRunState === 'paused' ? <p>AI 已暂停，进入牌桌处理</p> : null}
    </div>
  )
}
export function Home() {
  const runtime = useSessionRuntime()
  const active = useQuery(runtime.activeOptions())
  const recent = useQuery(queries.sessions(homeSessions('all')))
  const ended = useQuery(queries.sessions(homeSessions('ended')))
  const providers = useQuery(queries.providers())
  const canPrepare = preparationAllowed(active)
  const cacheValid = useActiveCacheValid(active.data)
  const current =
    active.isSuccess && active.fetchStatus === 'idle' && cacheValid
  const canReuse =
    canPrepare &&
    ended.isSuccess &&
    ended.fetchStatus === 'idle' &&
    ended.data.items.length > 0
  const diagnostic =
    active.error instanceof ApiError &&
    active.error.code === 'SESSION_READONLY_DIAGNOSTIC'
  const provider = providers.data?.deepSeek
  const preparationReason = canPrepare
    ? null
    : active.data
      ? '请先完成当前训练场'
      : '确认未完成场次后即可组桌'
  const reuseReason =
    ended.isFetching || ended.isPending
      ? '正在查找历史阵容'
      : ended.isError
        ? '历史阵容读取失败，可重新读取'
        : ended.data?.items.length === 0
          ? '还没有已结束的训练场'
          : null
  return (
    <div className="training-home">
      <section className="home-hero" aria-labelledby="home-title">
        <p className="eyebrow">德州扑克 · AI 对练</p>
        <h2 id="home-title">
          {active.data && current ? '继续你的训练' : '开始下一次练习'}
        </h2>
        {active.isPending ? (
          <Feedback title="正在查找未完成场次" busy />
        ) : (
          <ReadFeedback query={active} />
        )}
        {diagnostic ? (
          <Feedback
            title="只读诊断：暂不能继续操作"
            description={
              <>
                安全错误标识：<code>SESSION_READONLY_DIAGNOSTIC</code>
                。请重新读取；若仍无法恢复，请保留此标识检查服务。
              </>
            }
            action={<Link to={paths.settings}>查看设置</Link>}
          />
        ) : active.data ? (
          <ActiveCard
            key={active.data}
            id={active.data}
            current={current}
            relocate={active.refetch}
          />
        ) : null}
        <div className="home-preparation">
          {canPrepare ? (
            <Link className="primary-link" to={newSessionPath()}>
              新建训练场 <span aria-hidden="true">↗</span>
            </Link>
          ) : (
            <Button disabled>新建训练场</Button>
          )}
          {preparationReason ? (
            <p className="home-muted">{preparationReason}</p>
          ) : null}
          {canReuse ? (
            <Link
              className="button button-secondary"
              to={newSessionPath('latestEnded')}
            >
              沿用上一场阵容
            </Link>
          ) : (
            <Button variant="secondary" disabled>
              沿用上一场阵容
            </Button>
          )}
          <p className="home-muted">
            沿用最近结束场次的人物配置与座位，不继承记忆
          </p>
          {reuseReason ? <p className="home-muted">{reuseReason}</p> : null}
          {ended.isError ? (
            <RequestError
              error={ended.error}
              hasData={ended.data !== undefined}
              retry={() => void ended.refetch()}
              busy={ended.isFetching}
            />
          ) : null}
        </div>
      </section>
      <section className="home-section" aria-labelledby="recent-title">
        <div className="home-heading">
          <h2 id="recent-title">最近场次</h2>
          <Link to={paths.history}>查看历史 ↗</Link>
        </div>
        <p className="home-muted">按创建时间排序</p>
        <ReadFeedback query={recent} />
        {recent.data?.items.length === 0 ? (
          <p className="home-empty">还没有训练记录，从新建训练场开始</p>
        ) : null}
        <ul className="home-recent">
          {recent.data?.items.map((item) => {
            const accounting = userAccounting(item)
            return (
              <li key={item.sessionId}>
                <div className="home-heading">
                  <time dateTime={item.createdAt}>
                    {localTime(item.createdAt)}
                  </time>
                  <StatusBadge
                    tone={
                      item.lifecycle === 'readonlyDiagnostic'
                        ? 'danger'
                        : 'neutral'
                    }
                  >
                    {item.lifecycle === 'ended'
                      ? '已结束'
                      : item.lifecycle === 'active'
                        ? '进行中'
                        : '只读诊断 · 账务不可用'}
                  </StatusBadge>
                </div>
                <div className="home-heading">
                  <span className="home-muted">
                    已完成 {item.completedHandCount} 手
                  </span>
                  <strong className="home-net">{settlementText(item)}</strong>
                </div>
                {item.lifecycle === 'active' && accounting ? (
                  <p>
                    当前 <ChipAmount amount={accounting.currentChips} />
                  </p>
                ) : null}
                <div className="home-heading">
                  <Link
                    to={
                      item.lifecycle === 'active'
                        ? resourcePath('table', item.sessionId)
                        : sessionHistoryPath(item.sessionId)
                    }
                  >
                    {item.lifecycle === 'active'
                      ? current && active.data === item.sessionId
                        ? '继续训练'
                        : '查看场次'
                      : '本场历史'}{' '}
                    ↗
                  </Link>
                  {item.lifecycle === 'readonlyDiagnostic' ? (
                    <Link to={paths.settings}>查看设置</Link>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      </section>
      <section className="home-section" aria-labelledby="provider-title">
        <div className="home-heading">
          <h2 id="provider-title">DeepSeek</h2>
          <Link to={paths.settings}>查看设置 ↗</Link>
        </div>
        <ReadFeedback query={providers} />
        {provider ? (
          <>
            <StatusBadge
              tone={provider.checkStatus === 'available' ? 'active' : 'neutral'}
            >
              {providerStatusMessages[provider.checkStatus]}
            </StatusBadge>
            {provider.errorCode ? (
              <p>{providerErrorMessages[provider.errorCode]}</p>
            ) : null}
            {provider.lastCheckedAt ? (
              <p className="home-muted">
                上次检测：
                <time dateTime={provider.lastCheckedAt}>
                  {localTime(provider.lastCheckedAt)}
                </time>{' '}
                · 仅代表上次检测结果
              </p>
            ) : null}
          </>
        ) : null}
      </section>
    </div>
  )
}
