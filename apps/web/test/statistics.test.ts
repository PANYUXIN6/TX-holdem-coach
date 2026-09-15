import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { HandStatisticsMetricsSchema } from '@tx-holdem-coach/contracts'
import { statisticsSearch } from '../src/api/search.js'
import {
  changeScope,
  applyDates,
  parseVersion,
  selectConfig,
} from '../src/statistics/adapter.js'
import { HandMetrics } from '../src/statistics/StatisticsResults.js'

test('模式切换保持共同条件，位置与分组不恢复', () => {
  const query = statisticsSearch.decode(
    '?position=BTN&groupBy=position&subject=ai&personaName=old&from=2026-09-14T01:02:03.123456Z',
  )
  const sessions = changeScope(query, 'sessions')
  expect(sessions).not.toHaveProperty('position')
  expect(sessions.groupBy).toBe('none')
  expect(sessions.subject).toBe('ai')
  expect(sessions.personaName).toBe('old')
  expect(sessions.from).toBe('2026-09-14T01:02:03.123456Z')
  expect(changeScope(sessions, 'hands')).toMatchObject({
    position: null,
    groupBy: 'none',
  })
})
test('日期只转换已编辑端，拒绝无效输入，配置选择不改变时间', () => {
  const query = statisticsSearch.decode(
    '?from=2026-09-14T01:02:03.123456Z&to=2026-09-20T01:02:03.654321Z&personaName=old',
  )
  expect(applyDates(query, {})).toEqual(query)
  expect(applyDates(query, { from: '2026-09-15' }).to).toBe(query.to)
  expect(() => applyDates(query, { from: '2026-02-30' })).toThrow()
  expect(selectConfig(query, 'a'.repeat(64))).toMatchObject({
    personaName: null,
    from: query.from,
    configSnapshotKey: 'a'.repeat(64),
  })
  expect(() => parseVersion('01')).toThrow()
  expect(() => parseVersion('1e2')).toThrow()
})
test('中文计数和服务端百分比区分空分母与零结果，AI 样本不冒充牌局', () => {
  const metrics = HandStatisticsMetricsSchema.parse({
    handCount: 5,
    distinctHandCount: 1,
    handNetChange: -300,
    vpip: { numerator: 0, denominator: 5, percentage: 0 },
    pfr: { numerator: 0, denominator: 5, percentage: 0 },
    threeBet: { numerator: 1, denominator: 3, percentage: 33.33 },
    wtsd: { numerator: 0, denominator: 0, percentage: null },
    wsd: { numerator: 0, denominator: 0, percentage: null },
  })
  const html = renderToStaticMarkup(
    createElement(HandMetrics, { metrics, subject: 'ai' }),
  )
  for (const text of [
    'AI 参与者手数',
    '实际牌局数',
    '33.33%',
    '0%',
    '暂无分母样本',
    '合法 3-bet 机会次数',
    '获派奖不等于该手净盈利',
    '-300',
  ])
    expect(html).toContain(text)
})

test('夏令时换日按日历推进，开放区间可应用', () => {
  const previous = process.env.TZ
  try {
    process.env.TZ = 'America/New_York'
    const query = applyDates(statisticsSearch.decode(''), {
      from: '2026-03-08',
      to: '2026-03-08',
    })
    expect(query.from).toBe('2026-03-08T05:00:00.000000Z')
    expect(query.to).toBe('2026-03-09T04:00:00.000000Z')
    expect(applyDates(query, { to: '' }).to).toBeNull()
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
})
