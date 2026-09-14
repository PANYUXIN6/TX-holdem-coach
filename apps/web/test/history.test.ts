import { createElement } from 'react'
import { describe, expect, test } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  HandHistoryResponseSchema,
  type HandHistoryListItem,
} from '@tx-holdem-coach/contracts'
import { historySearch } from '../src/api/search.js'
import {
  actionLabel,
  adjacentSessions,
  localDateBoundary,
} from '../src/history/presentation.js'
import { selectConfig } from '../src/history/HistoryFilters.js'
import { CompletedFlow } from '../src/history/HandFlow.js'
import fixtures from './hand-fixtures.json'
import showdownFixture from './history-showdown-fixture.json'

describe('历史展示适配', () => {
  test('相邻场次分组保持服务端顺序', () => {
    const items = ['a', 'a', 'b', 'a'].map((sessionId, i) => ({
      sessionId,
      handId: String(i),
    })) as HandHistoryListItem[]
    expect(
      adjacentSessions(items).map((g) => g.items.map((i) => i.handId)),
    ).toEqual([['0', '1'], ['2'], ['3']])
  })
  test('动作金额来自展示块，旧载荷待校准', () => {
    expect(
      actionLabel(
        { type: 'call' },
        { committedAmount: 40, streetContributionAfterAction: 60 },
      ),
    ).toBe('跟注 40')
    expect(
      actionLabel(
        { type: 'raise', targetStreetCommitment: 60 },
        { committedAmount: 50, streetContributionAfterAction: 60 },
      ),
    ).toBe('加到 60')
    expect(actionLabel({ type: 'call' })).toContain('投入详情待校准')
  })
  test('日期以本地日历边界转换并拒绝非法日期', () => {
    expect(new Date(localDateBoundary('2026-09-14', false)).getHours()).toBe(0)
    expect(new Date(localDateBoundary('2026-09-14', true)).getDate()).toBe(15)
    expect(() => localDateBoundary('2026-02-30', false)).toThrow()
  })
  test('选择固化配置保持日期微秒并清除其他人物条件', () => {
    const page = historySearch.decode(
      '?from=2026-09-14T01:02:03.123456Z&personaName=old&cursor=abc',
    )
    const selected = selectConfig(page.query, 'snapshot-key')
    expect(selected.from).toBe('2026-09-14T01:02:03.123456Z')
    expect(selected.personaName).toBeNull()
    expect(selected.configSnapshotKey).toBe('snapshot-key')
  })
  test('全下自动发牌的空行动街和多个底池逐项显示', () => {
    const data = HandHistoryResponseSchema.parse(showdownFixture)
    const html = renderToStaticMarkup(createElement(CompletedFlow, { data }))
    expect((html.match(/本街无下注行动/g) ?? []).length).toBe(3)
    expect(html).toContain('摊牌 / 结算')
    expect(html).toContain('边池 1')
    expect(html).toContain('未跟注返还')
    expect(html).toContain('派奖')
  })
  test('真实分街组件按 public 与 audit 可见性展示', () => {
    const publicData = HandHistoryResponseSchema.parse(fixtures.public)
    const audit = HandHistoryResponseSchema.parse(fixtures.auditReveal)
    const publicHtml = renderToStaticMarkup(
      createElement(CompletedFlow, { data: publicData }),
    )
    const auditHtml = renderToStaticMarkup(
      createElement(CompletedFlow, { data: audit }),
    )
    expect(publicHtml).toContain('未公开底牌')
    expect(publicHtml).toContain('净变化')
    expect(auditHtml).not.toContain('未公开底牌')
    expect(auditHtml).toContain('未跟注返还')
  })
})
