import { useState } from 'react'
import {
  PublicLogicalPositionSchema,
  type HandHistoryPageRequest,
} from '@tx-holdem-coach/contracts'
import { historySearch } from '../api/search.js'
import { Button } from '../components/controls.js'
import { FilterDrawer } from '../components/modal.js'
import { HistoricalOptions } from '../filters/HistoricalOptions.js'
import { localDateBoundary, localDateInput } from './presentation.js'

type Query = HandHistoryPageRequest['query']
export function selectConfig(query: Query, key: string): Query {
  return {
    ...query,
    configSnapshotKey: key,
    personaId: null,
    personaVersion: null,
    personaName: null,
  }
}
export function HistoryFilters({
  page,
  searchKey,
  close,
  apply,
  config,
}: {
  page: HandHistoryPageRequest
  searchKey: string
  close: () => void
  apply: (page: HandHistoryPageRequest) => void
  config?: string | undefined
}) {
  const initial = config ? selectConfig(page.query, config) : page.query
  const [draft, setDraft] = useState<Query>(initial)
  const [from, setFrom] = useState(localDateInput(initial.from))
  const [to, setTo] = useState(localDateInput(initial.to, true))
  const [error, setError] = useState(false)
  const [options, setOptions] = useState(false)
  function field(key: keyof Query, value: unknown) {
    setDraft((current) => ({ ...current, [key]: value === '' ? null : value }))
  }
  return (
    <FilterDrawer
      open
      onClose={close}
      searchKey={searchKey}
      onReset={() => {
        setDraft(historySearch.decode('').query)
        setFrom('')
        setTo('')
        setError(false)
      }}
      onApply={() => {
        try {
          const next = historySearch.normalize({ query: draft, cursor: null })
          apply(next)
          return true
        } catch {
          setError(true)
          return false
        }
      }}
    >
      <div className="history-filter-fields">
        <p>手牌开手日期 · {Intl.DateTimeFormat().resolvedOptions().timeZone}</p>
        <label>
          开始日期
          <input
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value)
              try {
                field(
                  'from',
                  e.target.value
                    ? localDateBoundary(e.target.value, false)
                    : null,
                )
                setError(false)
              } catch {
                setError(true)
              }
            }}
          />
        </label>
        <label>
          结束日期（含当天）
          <input
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value)
              try {
                field(
                  'to',
                  e.target.value
                    ? localDateBoundary(e.target.value, true)
                    : null,
                )
                setError(false)
              } catch {
                setError(true)
              }
            }}
          />
        </label>
        <p>
          实际范围：{draft.from ?? '不限'} 至 {draft.to ?? '不限'}（不含上界）
        </p>
        <label>
          场次标识
          <input
            value={draft.sessionId ?? ''}
            onChange={(e) => field('sessionId', e.target.value)}
          />
        </label>
        <label>
          用户位置
          <select
            value={draft.position ?? ''}
            onChange={(e) => field('position', e.target.value)}
          >
            <option value="">不限</option>
            {PublicLogicalPositionSchema.options.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          单手结果
          <select
            value={draft.result ?? ''}
            onChange={(e) => field('result', e.target.value)}
          >
            <option value="">不限</option>
            <option value="profit">盈利</option>
            <option value="loss">亏损</option>
            <option value="even">持平</option>
          </select>
        </label>
        <label>
          起手牌类别
          <input
            placeholder="AA、AKs、AKo"
            value={draft.startingHand ?? ''}
            onChange={(e) => field('startingHand', e.target.value)}
          />
        </label>
        <label>
          排序
          <select
            value={draft.sort}
            onChange={(e) => field('sort', e.target.value)}
          >
            <option value="newest">开手时间从新到旧</option>
            <option value="oldest">开手时间从旧到新</option>
          </select>
        </label>
        <label>
          每页手数
          <select
            value={draft.limit}
            onChange={(e) => field('limit', Number(e.target.value))}
          >
            {[...new Set([20, 50, 100, page.query.limit])].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <p>所选配置：{draft.configSnapshotKey ?? '不限'}</p>
        <details>
          <summary>历史人物精确条件</summary>
          {(
            [
              ['personaId', '人物 ID'],
              ['personaVersion', '人物版本'],
              ['personaName', '历史名称'],
              ['configSnapshotKey', '配置键'],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                inputMode={key === 'personaVersion' ? 'numeric' : 'text'}
                value={draft[key] ?? ''}
                onChange={(e) =>
                  field(
                    key,
                    key === 'personaVersion' && e.target.value
                      ? Number(e.target.value)
                      : e.target.value,
                  )
                }
              />
            </label>
          ))}
        </details>
        <Button variant="secondary" onClick={() => setOptions(!options)}>
          {options ? '收起历史选项' : '查找历史场次与人物'}
        </Button>
        {options ? (
          <HistoricalOptions
            session={(id) => field('sessionId', id)}
            config={(key) => setDraft((current) => selectConfig(current, key))}
          />
        ) : null}
        {error ? (
          <p role="alert">
            筛选参数无效，请检查日期范围、起手牌、人物版本与标识。
          </p>
        ) : null}
      </div>
    </FilterDrawer>
  )
}
