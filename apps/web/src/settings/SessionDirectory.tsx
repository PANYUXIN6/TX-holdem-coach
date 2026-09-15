import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { queries } from '../query/options.js'
import { ApiError } from '../api/errors.js'
import { Button, StatusBadge } from '../components/controls.js'
import { LoadingFeedback, RequestError } from '../components/feedback.js'
import { DeleteSessionTrigger } from '../ui/confirmation-host.js'
import { paths, resourcePath } from '../navigation.js'
import { chips, lifecycleLabels } from './adapter.js'
import { SettingsTime } from './SettingsTime.js'
export function SessionDirectory() {
  const [cursor, setCursor] = useState<string | null>(null)
  const query = useQuery(
    queries.sessions({
      query: {
        lifecycle: 'all',
        sort: 'newest',
        limit: 20,
        from: null,
        to: null,
      },
      cursor,
    }),
  )
  useEffect(() => {
    if (
      cursor &&
      ((query.error instanceof ApiError && query.error.status === 400) ||
        (query.data && query.data.items.length === 0))
    )
      setCursor(null)
  }, [cursor, query.error, query.data])
  return (
    <section className="settings-section">
      <p className="eyebrow">训练档案</p>
      <h2>训练数据目录</h2>
      <p>按场次创建时间从新到旧，每页最多 20 场。</p>
      <Button
        variant="secondary"
        disabled={query.isFetching}
        onClick={() => void query.refetch()}
      >
        刷新目录
      </Button>
      {query.isPending ? <LoadingFeedback /> : null}
      {query.error ? (
        <RequestError error={query.error} hasData={!!query.data} />
      ) : null}
      {query.data?.items.length === 0 ? <p>还没有训练数据</p> : null}
      <div className="settings-directory">
        {query.data?.items.map((item) => {
          const accounting =
            item.accounting.status === 'available'
              ? item.accounting.seats.find((seat) => seat.seatNumber === 0)
              : null
          return (
            <article className="settings-session" key={item.sessionId}>
              <StatusBadge>{lifecycleLabels[item.lifecycle]}</StatusBadge>
              <dl>
                <div>
                  <dt>场次 ID</dt>
                  <dd>{item.sessionId}</dd>
                </div>
                <div>
                  <dt>创建时间</dt>
                  <dd>
                    <SettingsTime value={item.createdAt} />
                  </dd>
                </div>
                {item.endedAt ? (
                  <div>
                    <dt>结束时间</dt>
                    <dd>
                      <SettingsTime value={item.endedAt} />
                    </dd>
                  </div>
                ) : null}
                <div>
                  <dt>正常完成手数</dt>
                  <dd>{item.completedHandCount.toLocaleString('zh-CN')}</dd>
                </div>
                <div>
                  <dt>历史 AI 阵容</dt>
                  <dd>
                    <ul>
                      {item.roster.flatMap((seat) =>
                        seat.kind === 'ai'
                          ? [
                              <li key={seat.participantId}>
                                {seat.displayName} · v{seat.personaVersion}
                              </li>,
                            ]
                          : [],
                      )}
                    </ul>
                  </dd>
                </div>
                {accounting ? (
                  <>
                    <div>
                      <dt>初始筹码</dt>
                      <dd>{chips(accounting.initialChips)}</dd>
                    </div>
                    <div>
                      <dt>当前筹码</dt>
                      <dd>{chips(accounting.currentChips)}</dd>
                    </div>
                    <div>
                      <dt>累计买入</dt>
                      <dd>{chips(accounting.cumulativeBuyIn)}</dd>
                    </div>
                    {accounting.finalChips !== null ? (
                      <div>
                        <dt>最终筹码</dt>
                        <dd>{chips(accounting.finalChips)}</dd>
                      </div>
                    ) : null}
                    {accounting.sessionNetChange !== null ? (
                      <div>
                        <dt>场次净变化</dt>
                        <dd>{chips(accounting.sessionNetChange)}</dd>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div>
                    <dt>账务</dt>
                    <dd>只读诊断场次，账务不可用</dd>
                  </div>
                )}
              </dl>
              <div className="settings-actions">
                {item.lifecycle === 'active' ? (
                  <Link
                    className="primary-link"
                    to={resourcePath('table', item.sessionId)}
                  >
                    进入牌桌 ↗
                  </Link>
                ) : item.lifecycle === 'ended' ? (
                  <>
                    <Link
                      className="primary-link"
                      to={`${paths.history}?sessionId=${encodeURIComponent(item.sessionId)}`}
                    >
                      查看本场历史 ↗
                    </Link>
                    <DeleteSessionTrigger sessionId={item.sessionId} />
                  </>
                ) : (
                  <Link className="primary-link" to={paths.debug}>
                    查看诊断入口 ↗
                  </Link>
                )}
              </div>
            </article>
          )
        })}
      </div>
      <div className="settings-actions">
        {cursor ? (
          <Button variant="secondary" onClick={() => setCursor(null)}>
            回到首页
          </Button>
        ) : null}
        <Button
          variant="secondary"
          disabled={!query.data?.nextCursor || query.isFetching}
          onClick={() => setCursor(query.data?.nextCursor ?? null)}
        >
          下一页
        </Button>
      </div>
    </section>
  )
}
