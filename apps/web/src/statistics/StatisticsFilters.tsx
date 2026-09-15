import { useRef, useState } from 'react'
import {
  PublicLogicalPositionSchema,
  type StatisticsQuery,
} from '@tx-holdem-coach/contracts'
import { statisticsSearch } from '../api/search.js'
import { Button } from '../components/controls.js'
import { FilterDrawer } from '../components/modal.js'
import { HistoricalOptions } from '../filters/HistoricalOptions.js'
import { localDateInput } from '../filters/dates.js'
import {
  applyDates,
  parseVersion,
  personaExplanation,
  resetFilters,
  selectConfig,
} from './adapter.js'

export function StatisticsFilters({
  query,
  searchKey,
  close,
  apply,
}: {
  query: StatisticsQuery
  searchKey: string
  close: () => void
  apply: (next: StatisticsQuery) => void
}) {
  const [draft, setDraft] = useState(query)
  const [dates, setDates] = useState<{ from?: string; to?: string }>({})
  const [version, setVersion] = useState(String(query.personaVersion ?? ''))
  const [options, setOptions] = useState(false)
  const [error, setError] = useState(false)
  const errorRef = useRef<HTMLParagraphElement>(null)
  function field(
    key: 'sessionId' | 'personaId' | 'personaName' | 'configSnapshotKey',
    value: string,
  ) {
    setDraft((current) => ({ ...current, [key]: value === '' ? null : value }))
  }
  return (
    <FilterDrawer
      open
      searchKey={searchKey}
      onClose={close}
      title="统计筛选"
      onReset={() => {
        setDraft(resetFilters(query))
        setDates({ from: '', to: '' })
        setVersion('')
        setError(false)
      }}
      onApply={() => {
        try {
          const next = applyDates(
            { ...draft, personaVersion: parseVersion(version) },
            dates,
          )
          statisticsSearch.encode(next)
          apply(next)
          return true
        } catch {
          setError(true)
          requestAnimationFrame(() => errorRef.current?.focus())
          return false
        }
      }}
    >
      <div
        className="history-filter-fields"
        aria-describedby={error ? 'statistics-filter-error' : undefined}
      >
        <p>
          {query.scope === 'hands' ? '手牌开手日期' : '场次结束日期'} ·{' '}
          {Intl.DateTimeFormat().resolvedOptions().timeZone}
        </p>
        {(['from', 'to'] as const).map((key) => (
          <label key={key}>
            {key === 'from' ? '开始日期' : '结束日期（含当天）'}
            <input
              type="date"
              value={dates[key] ?? localDateInput(draft[key], key === 'to')}
              onChange={(e) =>
                setDates((current) => ({
                  ...current,
                  [key]: e.target.validity.badInput
                    ? 'invalid'
                    : e.target.value,
                }))
              }
            />
          </label>
        ))}
        <p>
          当前精确范围：{draft.from ?? '不限'} 至 {draft.to ?? '不限'}
          （不含上界）。日期控件编辑后才改为本地整日边界；未编辑的一端保留原始精度。
        </p>
        <label>
          场次标识
          <input
            value={draft.sessionId ?? ''}
            onChange={(e) => field('sessionId', e.target.value)}
          />
        </label>
        {draft.scope === 'hands' ? (
          <>
            <label>
              {draft.subject === 'user' ? '我的开手位置' : 'AI 自身开手位置'}
              <select
                value={draft.position ?? ''}
                onChange={(e) => {
                  const position = PublicLogicalPositionSchema.nullable().parse(
                    e.target.value || null,
                  )
                  setDraft((current) =>
                    current.scope === 'hands'
                      ? { ...current, position }
                      : current,
                  )
                }}
              >
                <option value="">不限</option>
                {PublicLogicalPositionSchema.options.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label>
              结果分组
              <select
                value={draft.groupBy}
                onChange={(e) => {
                  const groupBy =
                    e.target.value === 'position' ? 'position' : 'none'
                  setDraft((current) =>
                    current.scope === 'hands'
                      ? { ...current, groupBy }
                      : current,
                  )
                }}
              >
                <option value="none">不分组</option>
                <option value="position">按位置分组</option>
              </select>
            </label>
          </>
        ) : null}
        <p>{personaExplanation(draft.subject)}</p>
        <p>所选配置：{draft.configSnapshotKey ?? '不限'}</p>
        <details>
          <summary>历史人物精确条件</summary>
          <label>
            人物 ID
            <input
              value={draft.personaId ?? ''}
              onChange={(e) => field('personaId', e.target.value)}
            />
          </label>
          <label>
            人物版本
            <input
              inputMode="numeric"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
            />
          </label>
          <label>
            历史名称
            <input
              value={draft.personaName ?? ''}
              onChange={(e) => field('personaName', e.target.value)}
            />
          </label>
          <label>
            配置键
            <input
              value={draft.configSnapshotKey ?? ''}
              onChange={(e) => field('configSnapshotKey', e.target.value)}
            />
          </label>
        </details>
        <Button
          variant="secondary"
          onClick={() => {
            setDraft((current) => ({
              ...current,
              personaId: null,
              personaVersion: null,
              personaName: null,
              configSnapshotKey: null,
            }))
            setVersion('')
          }}
        >
          清除人物条件
        </Button>
        <Button variant="secondary" onClick={() => setOptions(!options)}>
          {options ? '收起历史选项' : '查找历史场次与人物'}
        </Button>
        {options ? (
          <HistoricalOptions
            session={(id) => field('sessionId', id)}
            config={(key) => {
              setDraft((current) => selectConfig(current, key))
              setVersion('')
            }}
          />
        ) : null}
        {error ? (
          <p
            id="statistics-filter-error"
            role="alert"
            tabIndex={-1}
            ref={errorRef}
          >
            筛选参数无效，请检查日期范围、场次标识和人物条件。人物版本须为规范正整数，且必须同时填写人物
            ID。
          </p>
        ) : null}
      </div>
    </FilterDrawer>
  )
}
