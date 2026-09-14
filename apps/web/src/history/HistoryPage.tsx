import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import type { HandHistoryPageRequest } from '@tx-holdem-coach/contracts'
import { ApiError } from '../api/errors.js'
import { historySearch } from '../api/search.js'
import { queries } from '../query/options.js'
import { Button, EmptyState } from '../components/controls.js'
import { LoadingFeedback, RequestError } from '../components/feedback.js'
import { paths, resourcePath, sessionHistoryPath } from '../navigation.js'
import { Cards } from './HandFlow.js'
import { HistoryFilters } from './HistoryFilters.js'
import { adjacentSessions, signed } from './presentation.js'
import './history.css'

export function HistoryPage() {
  const location = useLocation()
  let page
  try {
    page = historySearch.decode(location.search)
  } catch {
    return (
      <EmptyState
        title="历史筛选参数无效"
        description="请重置筛选后重新读取。"
        action={<Link to={paths.history}>重置筛选</Link>}
      />
    )
  }
  return <HistoryList page={page} />
}
function HistoryList({ page }: { page: HandHistoryPageRequest }) {
  const location = useLocation()
  const navigate = useNavigate()
  const query = useQuery(queries.hands(page))
  const [drawer, setDrawer] = useState<{ config?: string; key: string } | null>(
    null,
  )
  const heading = useRef<HTMLHeadingElement>(null)
  const focusPage = useRef(false)
  useEffect(() => {
    heading.current?.scrollIntoView({ block: 'start' })
    if (focusPage.current) {
      heading.current?.focus({ preventScroll: true })
      focusPage.current = false
    }
  }, [location.search])
  const goto = (next: HandHistoryPageRequest) => {
    focusPage.current = true
    void navigate({ search: historySearch.encode(next) })
  }
  const change = (next: HandHistoryPageRequest) => {
    if (JSON.stringify(next.query) !== JSON.stringify(page.query)) goto(next)
  }
  return (
    <div className="history-page">
      <section className="history-panel">
        <p className="eyebrow">HAND HISTORY</p>
        <h2 ref={heading} tabIndex={-1}>
          回看每一个决定
        </h2>
        <p>
          {page.query.sort === 'newest' ? '从新到旧' : '从旧到新'} · 每页{' '}
          {page.query.limit} 手
        </p>
        <dl className="history-filter-summary">
          {Object.entries(page.query)
            .filter(
              ([key, value]) =>
                value !== null && !['sort', 'limit'].includes(key),
            )
            .map(([key, value]) => (
              <div key={key}>
                <dt>
                  {
                    {
                      from: '开始时刻',
                      to: '结束时刻（不含）',
                      sessionId: '场次',
                      position: '位置',
                      result: '结果',
                      startingHand: '起手牌',
                      personaId: '人物 ID',
                      personaVersion: '人物版本',
                      personaName: '历史名称',
                      configSnapshotKey: '配置键',
                    }[key]
                  }
                </dt>
                <dd>{String(value)}</dd>
              </div>
            ))}
        </dl>
        <div className="history-links">
          <Button onClick={() => setDrawer({ key: location.key })}>
            筛选手牌
          </Button>
          <Button
            variant="secondary"
            disabled={query.isFetching}
            onClick={() => {
              if (page.cursor) goto({ ...page, cursor: null })
              else void query.refetch()
            }}
          >
            刷新
          </Button>
          {page.query.sessionId ? (
            <Link to={resourcePath('table', page.query.sessionId)}>
              返回本场牌桌
            </Link>
          ) : null}
        </div>
      </section>
      {query.error ? (
        <RequestError
          error={query.error}
          hasData={!!query.data}
          retry={() => void query.refetch()}
        />
      ) : null}
      {query.error instanceof ApiError && query.error.status === 400 ? (
        <Button onClick={() => goto({ ...page, cursor: null })}>
          游标无效，重新从首页读取
        </Button>
      ) : null}
      {query.isPending ? <LoadingFeedback /> : null}
      {query.data?.items.length === 0 ? (
        <EmptyState
          title="没有匹配的已完成手牌"
          description="可修改筛选条件，或完成新的一手后刷新。"
        />
      ) : null}
      {adjacentSessions(query.data?.items ?? []).map((group, index) => (
        <section key={`${group.sessionId}:${index}`} className="history-group">
          <header>
            <h3>场次 {group.sessionId}</h3>
            <p>本页 {group.items.length} 手</p>
            <Link to={sessionHistoryPath(group.sessionId)}>仅看本场</Link>
          </header>
          {group.items.map((item) => (
            <article className="history-panel" key={item.handId}>
              <Link
                className="history-hand-link"
                to={resourcePath('hand', item.handId)}
                state={{ pathname: location.pathname, search: location.search }}
              >
                第 {item.handNumber} 手 <span>查看流程 ↗</span>
              </Link>
              <p>
                {new Date(item.startedAt).toLocaleString()} ·{' '}
                {item.user.position} · {item.user.startingHandCategory}
              </p>
              <Cards cards={item.user.holeCards} />
              <Cards cards={item.board} />
              <p className="history-net">
                净变化 {signed(item.user.netChange)}
              </p>
              <p>
                用户派奖 {item.result.userAwardAmount} ·{' '}
                {item.result.terminationReason === 'showdown'
                  ? '摊牌结算'
                  : '其余玩家弃牌结束'}
              </p>
              <details>
                <summary>历史 AI 配置</summary>
                {item.aiParticipants.map((person) => (
                  <div className="history-option" key={person.seatNumber}>
                    <p>
                      {person.displayName} · {person.personaId} · v
                      {person.personaVersion}
                    </p>
                    <p>{person.configSnapshotKey}</p>
                    <Button
                      variant="secondary"
                      onClick={() =>
                        setDrawer({
                          config: person.configSnapshotKey,
                          key: location.key,
                        })
                      }
                    >
                      按此人物配置筛选
                    </Button>
                  </div>
                ))}
              </details>
            </article>
          ))}
        </section>
      ))}
      <nav className="history-links" aria-label="历史分页">
        <Button
          variant="secondary"
          disabled={!page.cursor}
          onClick={() => goto({ ...page, cursor: null })}
        >
          回到首页
        </Button>
        <Button
          disabled={
            !query.data?.nextCursor || query.isFetching || query.isError
          }
          onClick={() => goto({ ...page, cursor: query.data!.nextCursor })}
        >
          下一页
        </Button>
      </nav>
      {drawer ? (
        <HistoryFilters
          key={`${drawer.key}:${drawer.config ?? ''}`}
          page={page}
          config={drawer.config}
          searchKey={location.key}
          close={() => setDrawer(null)}
          apply={change}
        />
      ) : null}
    </div>
  )
}
