import { describe, expect, it } from 'vitest'
import { matchRoutes } from 'react-router'
import {
  resourcePath,
  returnTarget,
  routes,
  sessionHistoryPath,
} from '../src/navigation.js'

describe('应用路由归属', () => {
  it.each([
    ['/', 'home', 'regular', 'training'],
    ['/sessions/new', 'newSession', 'regular', 'training'],
    ['/sessions/table-1', 'table', 'table', null],
    ['/sessions/table-1/current-hand', 'currentHand', 'detail', null],
  ])('%s 使用约定的页面、布局和主导航', (pathname, id, layout, tab) => {
    const matched = matchRoutes(routes, pathname)?.at(-1)?.route
    expect(matched?.id).toBe(id)
    expect(matched?.handle).toMatchObject({ layout, tab })
  })
})

describe('详情返回', () => {
  it('返回合法列表并保留筛选与游标', () => {
    expect(
      returnTarget(
        'hand',
        { handId: 'hand-1' },
        {
          pathname: '/history',
          search: '?sessionId=s1&cursor=next',
        },
      ),
    ).toEqual({
      pathname: '/history',
      search: '?sessionId=s1&cursor=next',
      label: '返回历史',
    })
    expect(
      returnTarget(
        'run',
        { runId: 'run-1' },
        {
          pathname: '/debug/hands/hand-1',
          search: '?cursor=next',
        },
      ),
    ).toEqual({
      pathname: '/debug/hands/hand-1',
      search: '?cursor=next',
      label: '返回手牌关联调用',
    })
  })
  it('直接打开使用确定性上级', () => {
    expect(returnTarget('currentHand', { sessionId: 'table-1' }, null)).toEqual(
      { pathname: '/sessions/table-1', search: '', label: '返回牌桌' },
    )
    expect(returnTarget('hand', { handId: 'h1' }, null).pathname).toBe(
      '/history',
    )
    expect(returnTarget('run', { runId: 'r1' }, null).pathname).toBe('/debug')
  })
  it.each([
    { pathname: 'https://example.com/history', search: '' },
    { pathname: '//example.com/history', search: '' },
    { pathname: '/settings', search: '' },
    { pathname: '/history', search: '//example.com' },
    { pathname: '/debug/hands/../..', search: '' },
  ])('拒绝外部或未允许的来源 %j', (state) => {
    expect(returnTarget('run', { runId: 'r1' }, state).pathname).toBe('/debug')
  })
})

it('资源入口只编码一次，保留目标标识与本场历史筛选', () => {
  expect(resourcePath('currentHand', '练习 / A')).toBe(
    '/sessions/%E7%BB%83%E4%B9%A0%20%2F%20A/current-hand',
  )
  expect(sessionHistoryPath('table / A')).toBe('/history?sessionId=table+%2F+A')
})
