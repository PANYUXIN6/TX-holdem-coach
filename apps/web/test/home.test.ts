import { QueryObserver } from '@tanstack/react-query'
import { createQueryClient } from '../src/query/client.js'
import { createApi } from '../src/api/client.js'
import { createQueries } from '../src/query/options.js'
import { createSessionRuntime } from '../src/session-sync/runtime.js'
import { keys } from '../src/query/keys.js'
import { homeSessions } from '../src/home/model.js'
import { homeTransport } from './home-transport.js'
import { ids } from './fixtures.js'
import { describe, expect, it } from 'vitest'
import { newSessionPath, parseRosterSource } from '../src/navigation.js'
import { preparationAllowed, settlementText } from '../src/home/model.js'
import type { SessionManagementItem } from '@tx-holdem-coach/contracts'

describe('首页入口与展示契约', () => {
  it('仅本次成功确认无活动场次才开放准备', () => {
    expect(
      preparationAllowed({
        data: null,
        status: 'success',
        fetchStatus: 'idle',
      }),
    ).toBe(true)
    for (const state of [
      { data: undefined, status: 'pending', fetchStatus: 'fetching' },
      { data: null, status: 'error', fetchStatus: 'idle' },
      { data: null, status: 'success', fetchStatus: 'fetching' },
      { data: 'session', status: 'success', fetchStatus: 'idle' },
    ])
      expect(preparationAllowed(state)).toBe(false)
  })
  it('复用意图可刷新且拒绝非法和重复参数', () => {
    expect(newSessionPath()).toBe('/sessions/new')
    expect(parseRosterSource('')).toBe('current')
    expect(
      parseRosterSource(newSessionPath('latestEnded').split('?')[1]!),
    ).toBe('latestEnded')
    for (const search of [
      'rosterSource=',
      'rosterSource=unknown',
      'rosterSource=latestEnded&rosterSource=latestEnded',
    ])
      expect(parseRosterSource(search)).toBe('invalid')
  })
  it('结算使用累计买入后的净值，未结算与不可用不画成零', () => {
    const item = {
      lifecycle: 'ended',
      roster: [{ kind: 'user', seatNumber: 0 }],
      accounting: {
        status: 'available',
        seats: [
          {
            seatNumber: 0,
            currentChips: 2500,
            cumulativeBuyIn: 4000,
            sessionNetChange: -1500,
          },
        ],
      },
    } as SessionManagementItem
    expect(settlementText(item)).toBe('-1,500')
    expect(settlementText({ ...item, lifecycle: 'active' })).toBe('本场未结算')
    expect(
      settlementText({
        ...item,
        accounting: { status: 'unavailable', reason: 'readonlyDiagnostic' },
      }),
    ).toBe('—')
  })
})

describe('真实 Query/runtime 首页读取', () => {
  it('后台空定位失败关闭准备，恢复后重新开放，其他资源仍独立可用', async () => {
    const transport = homeTransport('history')
    const api = createApi(transport.fetcher)
    const client = createQueryClient()
    const runtime = createSessionRuntime(client, api)
    const observer = new QueryObserver(client, runtime.activeOptions())
    const unsubscribe = observer.subscribe(() => {})
    try {
      await observer.refetch()
      expect(preparationAllowed(observer.getCurrentResult())).toBe(true)
      transport.fail('active')
      await observer.refetch()
      expect(observer.getCurrentResult().data).toBe(null)
      expect(preparationAllowed(observer.getCurrentResult())).toBe(false)
      const recent = await client.fetchQuery(
        createQueries(api).sessions(homeSessions('all')),
      )
      expect(settlementText(recent.items[0]!)).toBe('-1,500')
      transport.fail('')
      await observer.refetch()
      expect(preparationAllowed(observer.getCurrentResult())).toBe(true)
    } finally {
      unsubscribe()
      client.clear()
    }
  })
  it('活动快照只由active接收；禁用观察不发详情GET，独立ended查询不依赖最近列表', async () => {
    const transport = homeTransport('active')
    const api = createApi(transport.fetcher)
    const client = createQueryClient()
    const runtime = createSessionRuntime(client, api)
    try {
      expect(await client.fetchQuery(runtime.activeOptions())).toBe(ids.session)
      const observer = new QueryObserver(client, {
        ...runtime.sessionOptions(ids.session),
        enabled: false,
      })
      const unsubscribe = observer.subscribe(() => {})
      expect(observer.getCurrentResult().data?.seats).toHaveLength(9)
      const query = createQueries(api)
      const [recent, ended, summary] = await Promise.all(
        ['all', 'ended', 'active'].map((kind) =>
          client.fetchQuery(
            query.sessions(homeSessions(kind as 'all' | 'ended' | 'active')),
          ),
        ),
      )
      expect(recent!.items.every((item) => item.lifecycle === 'active')).toBe(
        true,
      )
      expect(ended!.items).toHaveLength(1)
      expect(summary!.items[0]?.completedHandCount).toBe(12)
      client.removeQueries({ queryKey: keys.session(ids.session), exact: true })
      expect(client.getQueryState(keys.session(ids.session))).toBeUndefined()
      expect(
        transport.requests.every((request) => request.startsWith('GET ')),
      ).toBe(true)
      expect(
        transport.requests.some((request) =>
          request.includes(`/sessions/${ids.session}`),
        ),
      ).toBe(false)
      unsubscribe()
    } finally {
      client.clear()
    }
  })
})
