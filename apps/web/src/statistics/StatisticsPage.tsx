import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useLocation, useNavigate } from 'react-router'
import type { StatisticsQuery } from '@tx-holdem-coach/contracts'
import { statisticsSearch } from '../api/search.js'
import { queries } from '../query/options.js'
import { Button, EmptyState } from '../components/controls.js'
import { LoadingFeedback, RequestError } from '../components/feedback.js'
import { StatisticsFilters } from './StatisticsFilters.js'
import { StatisticsResults } from './StatisticsResults.js'
import { changeScope, personaExplanation } from './adapter.js'
import '../history/history.css'
import './statistics.css'

export function StatisticsPage() {
  const location = useLocation()
  let query
  try {
    query = statisticsSearch.decode(location.search)
  } catch {
    return (
      <EmptyState
        title="统计筛选参数无效"
        description="请返回默认统计后重新设置条件。"
        action={<Link to="/statistics">返回默认统计</Link>}
      />
    )
  }
  return <StatisticsContent query={query} />
}
function StatisticsContent({ query }: { query: StatisticsQuery }) {
  const location = useLocation()
  const navigate = useNavigate()
  const result = useQuery(queries.statistics(query))
  const [drawer, setDrawer] = useState<string | null>(null)
  const [positionClearedQuery, setPositionClearedQuery] = useState<
    string | null
  >(null)
  const queryKey = statisticsSearch.encode(query)
  function apply(next: StatisticsQuery) {
    const search = statisticsSearch.encode(next)
    if (search !== queryKey) void navigate({ search })
  }
  const labels: Record<string, string> = {
    from: '开始时刻',
    to: '结束时刻（不含）',
    sessionId: '场次',
    position: query.subject === 'user' ? '我的开手位置' : 'AI 自身开手位置',
    personaId: '人物 ID',
    personaVersion: '人物版本',
    personaName: '历史名称',
    configSnapshotKey: '配置键',
  }
  return (
    <div className="statistics-page">
      <section className="statistics-intro">
        <p className="eyebrow">STATISTICS / 练习记录</p>
        <h2>看清每一份样本</h2>
        <fieldset className="statistics-switch">
          <legend>统计模式</legend>
          {(
            [
              ['hands', '完成手统计'],
              ['sessions', '已结束场次账务'],
            ] as const
          ).map(([scope, label]) => (
            <label key={scope}>
              <input
                type="radio"
                name="statistics-scope"
                checked={query.scope === scope}
                onChange={() => {
                  const next = changeScope(query, scope)
                  apply(next)
                  setPositionClearedQuery(
                    scope === 'sessions' &&
                      query.scope === 'hands' &&
                      (query.position || query.groupBy === 'position')
                      ? statisticsSearch.encode(next)
                      : null,
                  )
                }}
              />
              {label}
            </label>
          ))}
        </fieldset>
        <fieldset className="statistics-switch">
          <legend>统计主体</legend>
          {(
            [
              ['user', '我的数据'],
              ['ai', 'AI 数据'],
            ] as const
          ).map(([subject, label]) => (
            <label key={subject}>
              <input
                type="radio"
                name="statistics-subject"
                checked={query.subject === subject}
                onChange={() => apply({ ...query, subject })}
              />
              {label}
            </label>
          ))}
        </fieldset>
        <p className="statistics-note">
          完成手按开手日期；账务按结束日期，位置条件仅用于完成手。
        </p>
        {positionClearedQuery === queryKey ? (
          <p role="status">已清除位置条件与位置分组。</p>
        ) : null}
        <p>{personaExplanation(query.subject)}</p>
        <p>
          {query.from || query.to ? '已限定时间范围' : '全部时间'} ·{' '}
          {query.scope === 'hands' ? '手牌开手日期' : '场次结束日期'} ·{' '}
          {query.groupBy === 'position' ? '按位置分组' : '不分组'}
        </p>
        <dl className="history-filter-summary">
          {Object.entries(query)
            .filter(([key, value]) => value !== null && labels[key])
            .map(([key, value]) => (
              <div key={key}>
                <dt>{labels[key]}</dt>
                <dd>{String(value)}</dd>
              </div>
            ))}
        </dl>
        <div className="history-links">
          <Button onClick={() => setDrawer(location.key)}>筛选</Button>
          <Button
            variant="secondary"
            disabled={result.isFetching}
            onClick={() => void result.refetch()}
          >
            刷新
          </Button>
        </div>
      </section>
      {result.isPending ? <LoadingFeedback /> : null}
      {result.isFetching && result.data ? <p role="status">正在更新</p> : null}
      {result.error ? (
        <>
          <p role="status">
            {result.data ? '更新失败，以下为上次成功结果' : '统计读取失败'}
          </p>
          <RequestError
            error={result.error}
            retry={() => void result.refetch()}
          />
        </>
      ) : null}
      {result.data ? (
        <StatisticsResults key={queryKey} data={result.data} />
      ) : null}
      {drawer !== null ? (
        <StatisticsFilters
          key={drawer}
          query={query}
          searchKey={location.key}
          close={() => setDrawer(null)}
          apply={apply}
        />
      ) : null}
    </div>
  )
}
