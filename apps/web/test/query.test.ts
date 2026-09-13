import { afterEach, expect, it } from 'vitest'
import {
  MutationObserver,
  QueryObserver,
  onlineManager,
} from '@tanstack/react-query'
import { ApiError } from '../src/api/errors.js'
import { createApi } from '../src/api/client.js'
import { createQueryClient } from '../src/query/client.js'
import { createQueries } from '../src/query/options.js'
import { createMutations } from '../src/query/mutations.js'
import { keys } from '../src/query/keys.js'
import {
  callsSearch,
  historySearch,
  sessionsSearch,
} from '../src/api/search.js'
import { agentPersonaSummary, ids } from './fixtures.js'
import { AgentRunDetailResponseSchema } from '@tx-holdem-coach/contracts'

const clients: ReturnType<typeof createQueryClient>[] = []
function client() {
  const value = createQueryClient()
  clients.push(value)
  return value
}
afterEach(() => {
  for (const value of clients) value.clear()
  clients.length = 0
  onlineManager.setOnline(true)
})
const json = (value: unknown, status = 200) => Response.json(value, { status })
const otherSession = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const otherHand = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function runFixture(sessionId = ids.session) {
  return AgentRunDetailResponseSchema.parse({
    runId: ids.command,
    sessionId,
    handId: ids.hand,
    runtime: 'coach',
    executionMode: 'live',
    lifecycle: 'completed',
    participantId: null,
    seatNumber: null,
    sourceStateVersion: null,
    decisionRequestId: null,
    createdAt: '2026-09-10T00:00:00.000000Z',
    startedAt: null,
    completedAt: null,
    terminationReasonCode: null,
    parentRunId: null,
    replacementRunId: null,
    reexecutionSourceRunId: null,
    decision: { kind: 'none' },
    commandEventRange: null,
    contentAvailability: {
      requestBody: 'notExposed',
      rawResponse: 'notRecorded',
      validationDetails: 'notRecorded',
    },
  })
}
it('真实 QueryClient 只缓存认证响应，后台协议错误保留旧数据并暴露错误', async () => {
  const cache = client()
  let valid = true
  const options = createQueries(
    createApi(async () =>
      json(
        valid ? { status: 'ok', database: 'available' } : { private: 'secret' },
      ),
    ),
  ).health()
  await cache.fetchQuery(options)
  valid = false
  await expect(cache.fetchQuery(options)).rejects.toMatchObject({
    kind: 'protocol',
  })
  expect(cache.getQueryState(options.queryKey)).toMatchObject({
    status: 'error',
    data: { status: 'ok' },
  })
  const fresh = client()
  await expect(fresh.fetchQuery(options)).rejects.toMatchObject({
    kind: 'protocol',
  })
  expect(fresh.getQueryData(options.queryKey)).toBeUndefined()
})
it('详情 404 清掉旧成功数据，普通协议失败不会清理无关资源', async () => {
  const cache = client()
  let missing = false
  const queries = createQueries(
    createApi(async () =>
      missing
        ? json({ code: 'PERSONA_NOT_FOUND', message: 'secret' }, 404)
        : json({ persona: agentPersonaSummary }),
    ),
  )
  const options = queries.persona(agentPersonaSummary.personaId)
  await cache.fetchQuery(options)
  missing = true
  await expect(
    cache.fetchQuery({ ...options, staleTime: 0 }),
  ).rejects.toMatchObject({ status: 404 })
  expect(cache.getQueryState(options.queryKey)).toMatchObject({
    data: undefined,
    status: 'error',
  })
})
it('同义 URL 命中同键，筛选、游标和审计视图隔离且审计需要明确启用', async () => {
  const cache = client()
  let count = 0
  const queries = createQueries(
    createApi(async () => {
      count++
      return json({ items: [], nextCursor: null })
    }),
  )
  const first = queries.hands(historySearch.decode(''))
  const equivalent = queries.hands(
    historySearch.decode('?limit=20&sort=newest'),
  )
  await cache.fetchQuery({ ...first, staleTime: Infinity })
  await cache.fetchQuery({ ...equivalent, staleTime: Infinity })
  expect(count).toBe(1)
  expect(
    queries.hands(historySearch.decode('?cursor=abc')).queryKey,
  ).not.toEqual(first.queryKey)
  expect(
    queries.hands(historySearch.decode('?sort=oldest')).queryKey,
  ).not.toEqual(first.queryKey)
  expect(queries.hand(ids.hand).queryKey).not.toEqual(
    queries.hand(ids.hand, 'auditReveal', true).queryKey,
  )
  expect(() => queries.hand(ids.hand, 'auditReveal')).toThrow(ApiError)
  expect(count).toBe(1)
})
it('Mutation 写成功后的读取失败独立存在；离线指示不暂停或重放写入', async () => {
  const cache = client()
  let wrote = false
  const methods: string[] = []
  const api = createApi(async (_url, init) => {
    methods.push(init?.method ?? 'GET')
    if (init?.method === 'PATCH') {
      wrote = true
      return json({
        settings: { attemptTimeoutSeconds: 10, decisionDeadlineSeconds: 30 },
      })
    }
    if (wrote) return json({ code: 'UNAVAILABLE', message: 'secret' }, 503)
    return json({
      settings: { attemptTimeoutSeconds: 5, decisionDeadlineSeconds: 30 },
    })
  })
  const options = createQueries(api).agent()
  await cache.fetchQuery(options)
  const observer = new QueryObserver(cache, { ...options, staleTime: Infinity })
  const unsubscribe = observer.subscribe(() => {})
  onlineManager.setOnline(false)
  const mutation = new MutationObserver(
    cache,
    createMutations(cache, api).updateAgentSettings(),
  )
  await mutation.mutate({ settings: { attemptTimeoutSeconds: 10 } })
  expect(mutation.getCurrentResult().status).toBe('success')
  expect(cache.getQueryState(keys.agent())?.status).toBe('error')
  onlineManager.setOnline(true)
  expect(methods.filter((method) => method === 'PATCH')).toHaveLength(1)
  unsubscribe()
})
it('删除取消延迟 GET，目标关联详情不复活，其他场次与设置保留，所有相关 cursor 失效', async () => {
  const cache = client()
  const page = callsSearch.decode('')
  let delay = false
  const pending = deferred<Response>()
  let oldSignal: AbortSignal | null | undefined
  const api = createApi(async (url, init) => {
    if (init?.method === 'DELETE')
      return json({ deletedSessionId: ids.session, invalidatedRunCount: 0 })
    if (String(url).includes('/attempts'))
      return json({
        query: page.query,
        runId: ids.command,
        items: [],
        nextCursor: null,
      })
    if (String(url).startsWith('/api/agent-runs')) return json(runFixture())
    const hand = String(url).includes(otherHand) ? otherHand : ids.hand
    if (delay) {
      oldSignal = init?.signal
      return pending.promise
    }
    return json({
      hand: {
        handId: hand,
        sessionId: hand === otherHand ? otherSession : ids.session,
        handNumber: 1,
        status: 'completed',
      },
      query: page.query,
      items: [],
      nextCursor: null,
    })
  })
  const queries = createQueries(api)
  await cache.fetchQuery(queries.handCalls(ids.hand, page))
  await cache.fetchQuery(queries.handCalls(otherHand, page))
  await cache.fetchQuery(queries.run(ids.command))
  const child = await queries.attempts(cache, ids.command, page)
  expect(child.meta).toMatchObject({ sessionId: ids.session, handId: ids.hand })
  await cache.fetchQuery(child)
  const related = [
    keys.hands(historySearch.decode('')),
    keys.hands(historySearch.decode('?cursor=second')),
    keys.sessions(sessionsSearch.decode('?lifecycle=readonlyDiagnostic')),
  ]
  for (const key of related) cache.setQueryData(key, { items: [] })
  const unrelated = keys.hands(
    historySearch.decode(`?sessionId=${otherSession}`),
  )
  cache.setQueryData(unrelated, { items: [] })
  cache.setQueryData(keys.personas(), { personas: [agentPersonaSummary] })
  cache.setQueryData(keys.agent(), {
    settings: { attemptTimeoutSeconds: 10, decisionDeadlineSeconds: 30 },
  })
  delay = true
  const reading = cache
    .fetchQuery(queries.handCalls(ids.hand, page))
    .catch(() => undefined)
  await new MutationObserver(
    cache,
    createMutations(cache, api).deleteSession(),
  ).mutate({ sessionId: ids.session, body: { confirmation: '永久删除本场' } })
  expect(oldSignal?.aborted).toBe(true)
  pending.resolve(
    json({
      hand: {
        handId: ids.hand,
        sessionId: ids.session,
        handNumber: 1,
        status: 'completed',
      },
      query: page.query,
      items: [],
      nextCursor: null,
    }),
  )
  await reading
  expect(cache.getQueryData(keys.handCalls(ids.hand, page))).toBeUndefined()
  expect(cache.getQueryData(child.queryKey)).toBeUndefined()
  expect(cache.getQueryData(keys.run(ids.command))).toBeUndefined()
  expect(cache.getQueryData(keys.handCalls(otherHand, page))).toBeDefined()
  expect(cache.getQueryData(keys.personas())).toBeDefined()
  expect(cache.getQueryData(keys.agent())).toBeDefined()
  for (const key of related)
    expect(cache.getQueryState(key)?.isInvalidated).toBe(true)
  expect(cache.getQueryState(unrelated)?.isInvalidated).toBe(false)
})
it('清空移除两种 Session key 与训练域，活动列表重新读取，保留基础配置', async () => {
  const cache = client()
  let cleared = false
  let reads = 0
  const pending = deferred<Response>()
  const api = createApi(async (_url, init) => {
    if (init?.method === 'DELETE') {
      cleared = true
      return json({ deletedSessionCount: 1, invalidatedRunCount: 0 })
    }
    reads++
    return cleared ? pending.promise : json({ items: [], nextCursor: null })
  })
  const options = createQueries(api).hands(historySearch.decode(''))
  await cache.fetchQuery(options)
  const observer = new QueryObserver(cache, { ...options, staleTime: Infinity })
  const unsubscribe = observer.subscribe(() => {})
  for (const key of [
    keys.session(ids.session),
    keys.active(),
    keys.run(ids.command),
    keys.hand(ids.hand, 'public'),
    ['statistics', {}],
  ])
    cache.setQueryData(key, {})
  for (const key of [keys.health(), keys.personas(), keys.agent()])
    cache.setQueryData(key, {})
  const mutation = new MutationObserver(
    cache,
    createMutations(cache, api).clearData(),
  )
  const result = mutation.mutate({ confirmation: '永久清空全部数据' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(cache.getQueryData(options.queryKey)).toBeUndefined()
  pending.resolve(json({ items: [], nextCursor: null }))
  await result
  expect(reads).toBe(2)
  expect(observer.getCurrentResult().data).toEqual({
    items: [],
    nextCursor: null,
  })
  for (const key of [
    keys.session(ids.session),
    keys.active(),
    keys.run(ids.command),
    keys.hand(ids.hand, 'public'),
  ])
    expect(cache.getQueryData(key)).toBeUndefined()
  for (const key of [keys.health(), keys.personas(), keys.agent()])
    expect(cache.getQueryData(key)).toBeDefined()
  unsubscribe()
})

it('实际手牌端点拒绝错配视图、错配身份及未知协议版本，审计不会污染 public', async () => {
  const fixtures = (await import('./hand-fixtures.json')).default
  const cache = client()
  let mode: 'normal' | 'wrongView' | 'wrongId' | 'future' = 'normal'
  const queries = createQueries(
    createApi(async (url) => {
      const audit = String(url).includes('auditReveal')
      const data = structuredClone(
        mode === 'wrongView' || audit ? fixtures.auditReveal : fixtures.public,
      )
      if (mode === 'wrongId') data.history.handId = otherHand
      if (mode === 'future') data.protocolVersion = 999
      return json(data)
    }),
  )
  const id = fixtures.public.history.handId
  const publicOptions = queries.hand(id)
  await cache.fetchQuery(publicOptions)
  await cache.fetchQuery(queries.hand(id, 'auditReveal', true))
  expect(cache.getQueryData(publicOptions.queryKey)).toEqual(fixtures.public)
  expect(
    cache.getQueryData(queries.hand(id, 'auditReveal', true).queryKey),
  ).toEqual(fixtures.auditReveal)
  for (const failure of ['wrongView', 'wrongId', 'future'] as const) {
    mode = failure
    await expect(cache.fetchQuery(publicOptions)).rejects.toMatchObject({
      kind: 'protocol',
    })
    expect(cache.getQueryData(publicOptions.queryKey)).toEqual(fixtures.public)
  }
})
it('Provider GET 不执行检测，手动 unavailable 是成功摘要且只刷新 Provider', async () => {
  const cache = client()
  let checks = 0
  const summary = {
    deepSeek: {
      configured: true,
      checkStatus: 'unavailable',
      lastCheckedAt: '2026-09-10T00:00:00.000Z',
      errorCode: 'provider_timeout',
      canCreateSession: true,
    },
  }
  const api = createApi(async (_url, init) => {
    if (init?.method === 'POST') {
      checks++
      expect(init.body).toBe('{}')
    }
    return json(summary)
  })
  const query = createQueries(api).providers()
  await cache.fetchQuery(query)
  cache.setQueryData(keys.agent(), {})
  cache.setQueryData(keys.run(ids.command), {})
  expect(checks).toBe(0)
  const observer = new QueryObserver(cache, { ...query, staleTime: Infinity })
  const unsubscribe = observer.subscribe(() => {})
  const mutation = new MutationObserver(
    cache,
    createMutations(cache, api).checkProvider(),
  )
  expect(await mutation.mutate({ provider: 'deepseek', body: {} })).toEqual(
    summary,
  )
  expect(checks).toBe(1)
  expect(cache.getQueryState(keys.agent())?.isInvalidated).toBe(false)
  expect(cache.getQueryState(keys.run(ids.command))?.isInvalidated).toBe(false)
  unsubscribe()
})
it('删除结果不确定时保持缓存且不自动重发', async () => {
  const cache = client()
  let requests = 0
  const api = createApi(async () => {
    requests++
    throw new Error('secret')
  })
  cache.setQueryData(keys.session(ids.session), { sessionId: ids.session })
  const mutation = new MutationObserver(
    cache,
    createMutations(cache, api).clearData(),
  )
  await expect(
    mutation.mutate({ confirmation: '永久清空全部数据' }),
  ).rejects.toMatchObject({ kind: 'network' })
  expect(requests).toBe(1)
  expect(cache.getQueryData(keys.session(ids.session))).toBeDefined()
})

it('删除后现有详情订阅也清除旧实体并显示资源不可用', async () => {
  const cache = client()
  const api = createApi(async (_url, init) =>
    init?.method === 'DELETE'
      ? json({ deletedSessionId: ids.session, invalidatedRunCount: 0 })
      : json(runFixture()),
  )
  const options = createQueries(api).run(ids.command)
  await cache.fetchQuery(options)
  const observer = new QueryObserver(cache, { ...options, staleTime: Infinity })
  const unsubscribe = observer.subscribe(() => {})
  await new MutationObserver(
    cache,
    createMutations(cache, api).deleteSession(),
  ).mutate({ sessionId: ids.session, body: { confirmation: '永久删除本场' } })
  expect(observer.getCurrentResult()).toMatchObject({
    data: undefined,
    status: 'error',
    error: { status: 404 },
  })
  unsubscribe()
})

it('缓存揭牌后撤销审计意图，拒绝审计 observer 并只订阅 public', async () => {
  const fixtures = (await import('./hand-fixtures.json')).default
  const cache = client()
  const queries = createQueries(
    createApi(async (url) =>
      json(
        String(url).includes('auditReveal')
          ? fixtures.auditReveal
          : fixtures.public,
      ),
    ),
  )
  const id = fixtures.public.history.handId
  const auditOptions = {
    ...queries.hand(id, 'auditReveal', true),
    staleTime: Infinity,
  }
  const publicOptions = { ...queries.hand(id), staleTime: Infinity }
  await cache.fetchQuery(auditOptions)
  await cache.fetchQuery(publicOptions)
  const observer = new QueryObserver(cache, auditOptions)
  const unsubscribe = observer.subscribe(() => {})
  try {
    expect(observer.getCurrentResult().data).toEqual(fixtures.auditReveal)
    // 工厂必须在 observer 有机会读取现存审计缓存之前拒绝无审计意图的组合。
    expect(
      () => new QueryObserver(cache, queries.hand(id, 'auditReveal', false)),
    ).toThrow(ApiError)
    observer.setOptions(publicOptions)
    expect(observer.getCurrentResult().data).toEqual(fixtures.public)
    // 合法审计缓存可保留；退出后的 observer 只消费 public。
    expect(cache.getQueryData(auditOptions.queryKey)).toEqual(
      fixtures.auditReveal,
    )
  } finally {
    unsubscribe()
  }
})

it('删除任意场次清掉 Observer 旧预览，迟到 GET 不复活，并保留人物目录', async () => {
  const { rosterPreview } = await import('./setup-fixtures.js')
  const cache = client()
  const late = deferred<Response>()
  const next = deferred<Response>()
  let reads = 0
  const api = createApi(async (_url, options) => {
    if (options?.method === 'DELETE')
      return json({ deletedSessionId: otherSession, invalidatedRunCount: 0 })
    reads++
    if (reads === 1) return json(rosterPreview)
    return reads === 2 ? late.promise : next.promise
  })
  cache.setQueryData(keys.personas(), { personas: [agentPersonaSummary] })
  const observer = new QueryObserver(cache, createQueries(api).rosterPreview())
  const states: unknown[] = []
  const unsubscribe = observer.subscribe((result) => states.push(result.data))
  await observer.refetch()
  const old = observer.refetch()
  const mutation = new MutationObserver(
    cache,
    createMutations(cache, api).deleteSession(),
  )
  const deleting = mutation.mutate({
    sessionId: otherSession,
    body: { confirmation: '永久删除本场' },
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(observer.getCurrentResult().data).toBeUndefined()
  late.resolve(json(rosterPreview))
  await old
  expect(observer.getCurrentResult().data).toBeUndefined()
  next.resolve(
    json({ code: 'ROSTER_SOURCE_NOT_FOUND', message: '没有来源' }, 404),
  )
  await deleting
  expect(observer.getCurrentResult().isError).toBe(true)
  expect(cache.getQueryData(keys.personas())).toBeDefined()
  expect(states).toContain(undefined)
  unsubscribe()
})

it('热预览缓存挂载后删除，重置重读成功可接受新阵容并继续', async () => {
  const { rosterPreview } = await import('./setup-fixtures.js')
  const { readReady, initialDraft, setupReducer, previewMatches } =
    await import('../src/session-setup/model.js')
  const cache = client()
  const next = deferred<Response>()
  const updated = { ...rosterPreview, sourceSessionId: otherSession }
  let reads = 0
  const api = createApi(async (_url, options) => {
    if (options?.method === 'DELETE')
      return json({ deletedSessionId: ids.session, invalidatedRunCount: 0 })
    return ++reads === 1 ? json(rosterPreview) : next.promise
  })
  cache.setQueryData(keys.rosterPreview(), rosterPreview)
  const observer = new QueryObserver(cache, {
    ...createQueries(api).rosterPreview(),
    refetchOnMount: 'always',
  })
  let wasResetSinceMount = false
  let draft = setupReducer(initialDraft(), {
    type: 'accept',
    preview: rosterPreview,
  })
  const stopCache = cache.getQueryCache().subscribe((event) => {
    if (
      event.type === 'updated' &&
      event.action.type === 'setState' &&
      event.query.queryKey[1] === 'roster-preview' &&
      event.query.state.data === undefined
    ) {
      wasResetSinceMount = true
      draft = setupReducer(draft, { type: 'clearHistory' })
    }
  })
  const ready = () =>
    readReady({ ...observer.getCurrentResult(), wasResetSinceMount })
  const stop = observer.subscribe(() => {})
  try {
    expect(ready()).toBe(false)
    await observer.refetch({ cancelRefetch: false })
    expect(ready()).toBe(true)
    const mutation = new MutationObserver(
      cache,
      createMutations(cache, api).deleteSession(),
    )
    const deleting = mutation.mutate({
      sessionId: ids.session,
      body: { confirmation: '永久删除本场' },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(ready()).toBe(false)
    expect(draft.preview).toBeNull()
    next.resolve(json(updated))
    await deleting
    expect(observer.getCurrentResult().isFetchedAfterMount).toBe(false)
    expect(ready()).toBe(true)
    expect(previewMatches(draft.preview, updated)).toBe(false)
    draft = setupReducer(draft, { type: 'accept', preview: updated })
    expect(
      ready() &&
        previewMatches(draft.preview, observer.getCurrentResult().data),
    ).toBe(true)
  } finally {
    stop()
    stopCache()
  }
})
