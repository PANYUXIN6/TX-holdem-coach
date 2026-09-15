import type {
  StatisticsQuery,
  StatisticsScope,
} from '@tx-holdem-coach/contracts'
import { statisticsSearch } from '../api/search.js'
import { localDateBoundary } from '../filters/dates.js'

export function changeScope(
  query: StatisticsQuery,
  scope: StatisticsScope,
): StatisticsQuery {
  if (query.scope === scope) return query
  const { scope: _scope, groupBy: _group, ...common } = query
  const { position: _position, ...fields } = { position: null, ...common }
  return statisticsSearch.normalize(
    scope === 'hands'
      ? { ...fields, scope, position: null, groupBy: 'none' }
      : { ...fields, scope, groupBy: 'none' },
  )
}
export function resetFilters(query: StatisticsQuery) {
  return changeScope(
    { ...statisticsSearch.decode(''), subject: query.subject },
    query.scope,
  )
}
export function applyDates(
  query: StatisticsQuery,
  dates: { from?: string; to?: string },
) {
  const next = { ...query }
  for (const key of ['from', 'to'] as const) {
    const value = dates[key]
    if (value !== undefined)
      next[key] = value ? localDateBoundary(value, key === 'to') : null
  }
  return statisticsSearch.normalize(next)
}
export function parseVersion(value: string) {
  if (!value) return null
  if (!/^[1-9]\d*$/.test(value)) throw new Error('人物版本须为规范正整数')
  return Number(value)
}
export function selectConfig(
  query: StatisticsQuery,
  key: string,
): StatisticsQuery {
  return {
    ...query,
    configSnapshotKey: key,
    personaId: null,
    personaVersion: null,
    personaName: null,
  }
}
export const integer = (value: number) =>
  value.toLocaleString('en-US', { maximumFractionDigits: 0 })
export const amount = (value: number) =>
  `${value > 0 ? '+' : ''}${integer(value)}`
export const personaExplanation = (subject: StatisticsQuery['subject']) =>
  subject === 'user'
    ? '只看对手阵容包含此历史配置的场次中的我的数据。多个匹配 AI 不重复计用户。'
    : '只统计自身符合此历史配置的 AI；未选配置时为全部 AI 汇总。'
