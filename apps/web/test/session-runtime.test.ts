import { afterEach, describe, expect, it, vi } from 'vitest'
import { MutationObserver, QueryObserver } from '@tanstack/react-query'
import {
  PublicSessionSnapshotSchema,
  type SseEvent,
} from '@tx-holdem-coach/contracts'
import { createApi } from '../src/api/client.js'
import { ApiError } from '../src/api/errors.js'
import type { StreamOptions } from '../src/api/sse.js'
import { createQueryClient } from '../src/query/client.js'
import { keys } from '../src/query/keys.js'
import { createSessionRuntime } from '../src/session-sync/runtime.js'
import { ids, publicSnapshot } from './fixtures.js'
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const snap = (eventSeq = 8, stateVersion = 4) =>
  PublicSessionSnapshotSchema.parse({
    ...publicSnapshot,
    eventSeq,
    stateVersion,
  })
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
const event = (
  eventSeq = 8,
  stateVersion = 4,
  type: SseEvent['type'] = 'snapshot',
): SseEvent => ({
  eventId: ids.event,
  sessionId: ids.session,
  eventSeq,
  stateVersion,
  type,
  payload: { snapshot: snap(eventSeq, stateVersion) },
})
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}
const cleanup: (() => void)[] = []
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn())
  vi.useRealTimers()
})
function setup(
  handler: (
    url: string,
    options?: RequestInit,
  ) => Promise<Response> = async () => json({ snapshot: snap() }),
) {
  const client = createQueryClient()
  const fetcher = vi.fn((url: string | URL | Request, options?: RequestInit) =>
    handler(String(url), options),
  )
  const streams: {
    options: StreamOptions
    done: ReturnType<typeof deferred<void>>
  }[] = []
  const runtime = createSessionRuntime(
    client,
    createApi(fetcher),
    (options) => {
      const done = deferred<void>()
      streams.push({ options, done })
      options.signal.addEventListener('abort', () => done.resolve())
      return done.promise
    },
  )
  cleanup.push(() => client.clear())
  const acquire = () => {
    const release = runtime.acquire(ids.session)
    cleanup.push(release)
    return release
  }
  return { runtime, client, fetcher, streams, acquire }
}
describe('场次连接与操作', () => {
  it('snapshot 后 GET 和有效流共同开闸；断线旧 GET 不开新闸，恢复使用接收游标', async () => {
    vi.useFakeTimers()
    const gets: ReturnType<typeof deferred<Response>>[] = []
    const { runtime, streams, acquire, fetcher } = setup(async () => {
      const get = deferred<Response>()
      gets.push(get)
      return get.promise
    })
    acquire()
    const first = streams[0]!
    first.options.onOpen()
    first.options.onBytes()
    first.options.onEvent(event(8, 4, 'actionCommitted'))
    expect(runtime.getStatus(ids.session)).toBe('calibrating')
    expect(fetcher).not.toHaveBeenCalled()
    first.options.onEvent(event())
    expect(gets).toHaveLength(1)
    first.done.resolve()
    await flush()
    expect(runtime.getStatus(ids.session)).toBe('reconnecting')
    gets[0]!.resolve(json({ snapshot: snap() }))
    await flush()
    expect(runtime.getStatus(ids.session)).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(1000)
    expect(streams[1]!.options.cursor).toBe(8)
    streams[1]!.options.onEvent(event())
    gets[1]!.resolve(json({ snapshot: snap() }))
    await flush()
    expect(runtime.getStatus(ids.session)).toBe('ready')
  })
  it('缺口风暴合并一个 GET 并以完整校准覆盖；同版本 ended 关闭流并清 active', async () => {
    const latest = deferred<Response>()
    let reads = 0
    const { runtime, client, streams, acquire } = setup(async () =>
      ++reads === 1 ? json({ snapshot: snap() }) : latest.promise,
    )
    acquire()
    streams[0]!.options.onEvent(event())
    await flush()
    expect(runtime.getStatus(ids.session)).toBe('ready')
    streams[0]!.options.onEvent(event(12, 4, 'actionCommitted'))
    streams[0]!.options.onEvent(event(13, 4, 'actionCommitted'))
    expect(reads).toBe(2)
    expect(client.getQueryData(keys.session(ids.session))).toEqual(snap())
    latest.resolve(json({ snapshot: snap(13, 4) }))
    await flush()
    expect(runtime.getStatus(ids.session)).toBe('ready')
    client.setQueryData(keys.active(), ids.session)
    const ended = event(14, 4, 'sessionEnded')
    ended.payload.snapshot = {
      ...snap(14, 4),
      lifecycleStatus: 'ended',
      pokerPhase: 'betweenHands',
      hand: null,
    }
    streams[0]!.options.onEvent(ended)
    expect(runtime.getStatus(ids.session)).toBe('ended')
    expect(client.getQueryData(keys.active())).toBeNull()
    expect(streams[0]!.options.signal.aborted).toBe(true)
  })
  it('真实 Mutation 阻止第二命令；网络失败不重发，人工重发保留 ID/body 与原基线', async () => {
    const post = deferred<Response>()
    const bodies: string[] = []
    let current = snap()
    const { runtime, client, streams, acquire } = setup(
      async (_url, options) => {
        if (options?.method === 'POST') {
          bodies.push(String(options.body))
          return bodies.length === 1 ? post.promise : json({ snapshot: snap() })
        }
        return json({ snapshot: current })
      },
    )
    acquire()
    streams[0]!.options.onEvent(event())
    await flush()
    const first = new MutationObserver(
      client,
      runtime.commandOptions(ids.session),
    )
    const task = first
      .mutate({ type: 'playerAction', payload: { action: { type: 'fold' } } })
      .catch((error) => error)
    await flush()
    await expect(
      new MutationObserver(client, runtime.commandOptions(ids.session)).mutate({
        type: 'endSession',
        payload: {},
      }),
    ).rejects.toMatchObject({ kind: 'input' })
    post.reject(new Error('offline'))
    await task
    expect(bodies).toHaveLength(1)
    const pending = runtime.pendingOperations(ids.session)[0]!
    current = snap(9, 5)
    streams[0]!.options.onEvent(event(9, 5, 'actionCommitted'))
    await runtime.resend(ids.session, pending.command.commandId)
    expect(bodies[1]).toBe(bodies[0])
    expect(runtime.pendingOperations(ids.session)).toEqual([])
  })
  it('active 旧 null 不覆盖创建冲突定位；Mutation 仍失败', async () => {
    const old = deferred<Response>()
    const { runtime, client } = setup(async (url) =>
      url.endsWith('/active')
        ? old.promise
        : json(
            {
              code: 'ACTIVE_SESSION_EXISTS',
              message: '已存在',
              latestSnapshot: snap(),
            },
            409,
          ),
    )
    const active = new QueryObserver(client, runtime.activeOptions())
    const unsub = active.subscribe(() => {})
    cleanup.push(unsub)
    const create = new MutationObserver(client, runtime.createOptions())
    await expect(
      create.mutate({ rosterSource: { type: 'latestEnded' } }),
    ).rejects.toMatchObject({ status: 409, code: 'ACTIVE_SESSION_EXISTS' })
    expect(create.getCurrentResult().status).toBe('error')
    expect(runtime.getCreateTarget()).toBe(ids.session)
    expect(client.getQueryData(keys.active())).toBe(ids.session)
    old.resolve(json({ code: 'SESSION_NOT_FOUND', message: '不存在' }, 404))
    await flush()
    expect(client.getQueryData(keys.active())).toBe(ids.session)
  })
  it('清空响应前后迟到 GET/SSE 不复活；保留设置', async () => {
    const old = deferred<Response>()
    const deletion = deferred<Response>()
    const { runtime, client, streams, acquire } = setup(
      async (_url, options) =>
        options?.method === 'DELETE' ? deletion.promise : old.promise,
    )
    acquire()
    streams[0]!.options.onEvent(event())
    client.setQueryData(keys.agent(), { preserved: true })
    const mutation = new MutationObserver(client, runtime.mutations.clearData())
    const task = mutation.mutate({ confirmation: '永久清空全部数据' })
    await flush()
    expect(streams[0]!.options.signal.aborted).toBe(true)
    streams[0]!.options.onEvent(event(9, 5, 'actionCommitted'))
    deletion.resolve(json({ deletedSessionCount: 1, invalidatedRunCount: 0 }))
    await task
    old.resolve(json({ snapshot: snap(10, 6) }))
    await flush()
    expect(client.getQueryData(keys.session(ids.session))).toBeUndefined()
    expect(client.getQueryData(keys.active())).toBeNull()
    expect(client.getQueryData(keys.agent())).toEqual({ preserved: true })
  })
  it('重复协议错误收敛 blocked；隐藏/恢复与 45 秒心跳屏障超时清理', async () => {
    vi.useFakeTimers()
    const { runtime, streams, acquire } = setup()
    acquire()
    streams[0]!.done.reject(new ApiError('protocol'))
    await flush()
    expect(streams).toHaveLength(2)
    streams[1]!.done.reject(new ApiError('protocol'))
    await flush()
    expect(runtime.getStatus(ids.session)).toBe('blocked')
    await vi.advanceTimersByTimeAsync(90_000)
    expect(streams).toHaveLength(2)
    const restored = runtime.refresh(ids.session)
    streams.at(-1)!.options.onEvent(event())
    await restored
    runtime.visibility(true)
    expect(runtime.getStatus(ids.session)).toBe('suspended')
    runtime.visibility(false)
    const latest = streams.at(-1)!
    for (let i = 0; i < 3; i++) {
      latest.options.onBytes()
      await vi.advanceTimersByTimeAsync(15_000)
    }
    expect(runtime.getStatus(ids.session)).toBe('reconnecting')
  })
})

it('HTTP/SSE 任意先到都维护历史；普通行动不失效全部历史，跨手恢复按场失效', async () => {
  const { publicCompletedHandSummary } = await import('./fixtures.js')
  const { runtime, client, streams, acquire } = setup()
  acquire()
  streams[0]!.options.onEvent(event())
  await flush()
  const historyKey = [
    'hands',
    'list',
    { sessionId: ids.session },
    null,
  ] as const
  const otherKey = [
    'hands',
    'list',
    { sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    null,
  ] as const
  const handsStats = [
    'statistics',
    { scope: 'hands', sessionId: null },
  ] as const
  const sessionStats = [
    'statistics',
    { scope: 'sessions', sessionId: null },
  ] as const
  for (const key of [historyKey, otherKey, handsStats, sessionStats])
    client.setQueryData(key, { rows: [] })
  streams[0]!.options.onEvent(event(9, 5, 'actionCommitted'))
  await flush()
  expect(client.getQueryState(historyKey)?.isInvalidated).toBe(false)
  const finished = event(10, 6, 'actionCommitted')
  finished.payload.snapshot = PublicSessionSnapshotSchema.parse({
    ...snap(10, 6),
    hand: null,
    pokerPhase: 'betweenHands',
    lastCompletedHandSummary: publicCompletedHandSummary,
  })
  streams[0]!.options.onEvent(finished)
  await flush()
  expect(client.getQueryState(historyKey)?.isInvalidated).toBe(true)
  expect(client.getQueryState(handsStats)?.isInvalidated).toBe(true)
  expect(client.getQueryState(sessionStats)?.isInvalidated).toBe(false)
  expect(client.getQueryState(otherKey)?.isInvalidated).toBe(false)
})
it('成功命令被 SSE 覆盖仍成功；失败 latestSnapshot 更新缓存而 Mutation 保持失败', async () => {
  const response = deferred<Response>()
  let fail = false
  const { runtime, client, streams, acquire } = setup(async (_url, options) =>
    options?.method === 'POST'
      ? fail
        ? json(
            {
              code: 'STATE_VERSION_CONFLICT',
              message: 'conflict',
              latestSnapshot: snap(10, 6),
            },
            409,
          )
        : response.promise
      : json({ snapshot: snap() }),
  )
  acquire()
  streams[0]!.options.onEvent(event())
  await flush()
  const mutation = new MutationObserver(
    client,
    runtime.commandOptions(ids.session),
  )
  const task = mutation.mutate({ type: 'endSession', payload: {} })
  await flush()
  streams[0]!.options.onEvent(event(9, 5, 'actionCommitted'))
  response.resolve(json({ snapshot: snap() }))
  await task
  expect(mutation.getCurrentResult().status).toBe('success')
  expect(client.getQueryData(keys.session(ids.session))).toEqual(snap(9, 5))
  fail = true
  await expect(
    mutation.mutate({ type: 'endSession', payload: {} }),
  ).rejects.toMatchObject({ status: 409 })
  expect(client.getQueryData(keys.session(ids.session))).toEqual(snap(10, 6))
})
it('单删不关闭另一场连接；删除期间的命令结果不能复活目标数据', async () => {
  const post = deferred<Response>()
  const otherId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const { runtime, client, streams, acquire } = setup(async (url, options) =>
    options?.method === 'POST'
      ? post.promise
      : options?.method === 'DELETE'
        ? json({ deletedSessionId: ids.session, invalidatedRunCount: 0 })
        : json({
            snapshot: {
              ...snap(),
              sessionId: url.includes(otherId) ? otherId : ids.session,
            },
          }),
  )
  acquire()
  streams[0]!.options.onEvent(event())
  await flush()
  const release = runtime.acquire(otherId)
  cleanup.push(release)
  const other = {
    ...event(),
    sessionId: otherId,
    payload: { snapshot: { ...snap(), sessionId: otherId } },
  }
  streams[1]!.options.onEvent(other)
  await flush()
  client.setQueryData(keys.active(), otherId)
  const command = new MutationObserver(
    client,
    runtime.commandOptions(ids.session),
  )
    .mutate({ type: 'endSession', payload: {} })
    .catch((error) => error)
  await flush()
  await new MutationObserver(client, runtime.mutations.deleteSession()).mutate({
    sessionId: ids.session,
    body: { confirmation: '永久删除本场' },
  })
  post.resolve(json({ snapshot: snap(9, 5) }))
  await command
  await flush()
  expect(client.getQueryData(keys.session(ids.session))).toBeUndefined()
  expect(client.getQueryData(keys.active())).toBe(otherId)
  expect(streams[1]!.options.signal.aborted).toBe(false)
  expect(runtime.getStatus(otherId)).toBe('ready')
})
it.each(['ended', 'readonlyDiagnostic'] as const)(
  '缓存 %s 挂载读取但不建流',
  async (lifecycleStatus) => {
    const snapshot = {
      ...snap(),
      hand: null,
      pokerPhase: 'betweenHands',
      lifecycleStatus,
    }
    const { runtime, client, streams, acquire, fetcher } = setup(async () =>
      json({ snapshot }),
    )
    // 通过生产 GET 建立认证缓存。
    await runtime.read(ids.session)
    acquire()
    await flush()
    expect(streams).toHaveLength(0)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(client.getQueryData(keys.session(ids.session))).toEqual(snapshot)
  },
)
it('删除后的 Query 订阅重建不能自动建立新的接收生命周期', async () => {
  const { runtime, client, acquire, streams, fetcher } = setup(
    async (_url, options) =>
      options?.method === 'DELETE'
        ? json({ deletedSessionCount: 1, invalidatedRunCount: 0 })
        : json({ snapshot: snap() }),
  )
  acquire()
  streams[0]!.options.onEvent(event())
  await flush()
  await new MutationObserver(client, runtime.mutations.clearData()).mutate({
    confirmation: '永久清空全部数据',
  })
  const count = fetcher.mock.calls.length
  await expect(
    client.fetchQuery(runtime.sessionOptions(ids.session)),
  ).rejects.toMatchObject({ status: 404 })
  expect(fetcher.mock.calls.length).toBe(count)
  expect(client.getQueryData(keys.session(ids.session))).toBeUndefined()
})
it('隐藏期间命令网络失败保留 suspended；恢复必须重新完成连接屏障', async () => {
  const post = deferred<Response>()
  const { runtime, client, streams, acquire } = setup(async (_url, options) =>
    options?.method === 'POST' ? post.promise : json({ snapshot: snap() }),
  )
  acquire()
  streams[0]!.options.onEvent(event())
  await flush()
  const task = new MutationObserver(client, runtime.commandOptions(ids.session))
    .mutate({ type: 'endSession', payload: {} })
    .catch((error) => error)
  await flush()
  runtime.visibility(true)
  post.reject(new Error('offline'))
  await task
  expect(runtime.getStatus(ids.session)).toBe('suspended')
  expect(runtime.pendingOperations(ids.session)).toHaveLength(1)
  runtime.visibility(false)
  expect(runtime.getStatus(ids.session)).toBe('connecting')
  streams.at(-1)!.options.onEvent(event())
  await flush()
  expect(runtime.getStatus(ids.session)).toBe('ready')
})
it('创建成功定位首手且不补发命令；创建在途阻止重复创建和清空', async () => {
  const response = deferred<Response>()
  const { runtime, client, fetcher } = setup(async () => response.promise)
  const create = new MutationObserver(client, runtime.createOptions())
  const task = create.mutate({ rosterSource: { type: 'latestEnded' } })
  await flush()
  await expect(
    new MutationObserver(client, runtime.createOptions()).mutate({
      rosterSource: { type: 'latestEnded' },
    }),
  ).rejects.toMatchObject({ kind: 'input' })
  await expect(
    new MutationObserver(client, runtime.mutations.clearData()).mutate({
      confirmation: '永久清空全部数据',
    }),
  ).rejects.toMatchObject({ kind: 'input' })
  expect(fetcher).toHaveBeenCalledTimes(1)
  response.resolve(json({ snapshot: snap() }, 201))
  await expect(task).resolves.toEqual({ sessionId: ids.session })
  expect(client.getQueryData(keys.active())).toBe(ids.session)
  expect(client.getQueryData(keys.session(ids.session))).toEqual(snap())
  expect(fetcher).toHaveBeenCalledTimes(1)
})
it('不确定创建只读取 active，保留创建失败并提供继续目标', async () => {
  const { runtime, client, fetcher } = setup(async (url) => {
    if (url.endsWith('/active')) return json({ snapshot: snap() })
    throw new Error('network')
  })
  await expect(
    new MutationObserver(client, runtime.createOptions()).mutate({
      rosterSource: { type: 'latestEnded' },
    }),
  ).rejects.toMatchObject({ kind: 'network' })
  expect(fetcher.mock.calls.map((call) => call[1]?.method)).toEqual([
    'POST',
    'GET',
  ])
  expect(runtime.getCreateTarget()).toBe(ids.session)
})
it('网络恢复按 1/2/4/8/16/30 秒退避，卸载清理调度', async () => {
  vi.useFakeTimers()
  const { streams, acquire } = setup()
  const release = acquire()
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    const count = streams.length
    streams.at(-1)!.done.reject(new ApiError('network'))
    await flush()
    await vi.advanceTimersByTimeAsync(delay - 1)
    expect(streams).toHaveLength(count)
    await vi.advanceTimersByTimeAsync(1)
    expect(streams).toHaveLength(count + 1)
  }
  release()
  const count = streams.length
  await vi.advanceTimersByTimeAsync(90_000)
  expect(streams).toHaveLength(count)
  expect(streams.at(-1)!.options.signal.aborted).toBe(true)
})
it('Query 读取 ended 详情成功返回，终止流不取消正在交付的权威 GET', async () => {
  const snapshot = PublicSessionSnapshotSchema.parse({
    ...snap(),
    lifecycleStatus: 'ended',
    pokerPhase: 'betweenHands',
    hand: null,
  })
  const { runtime, client } = setup(async () => json({ snapshot }))
  await expect(
    client.fetchQuery(runtime.sessionOptions(ids.session)),
  ).resolves.toEqual(snapshot)
  expect(runtime.getStatus(ids.session)).toBe('ended')
})

it.each([false, true])(
  'A ended 与定位 B 的 active GET 竞速时重新读取（订阅=%s）',
  async (subscribed) => {
    const old = deferred<Response>()
    const fresh = deferred<Response>()
    const nextId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    let activeReads = 0
    const { runtime, client, streams, acquire } = setup(async (url) => {
      if (url.endsWith('/active'))
        return ++activeReads === 1 ? old.promise : fresh.promise
      return json({ snapshot: snap() })
    })
    acquire()
    streams[0]!.options.onEvent(event())
    await flush()
    client.setQueryData(keys.active(), ids.session)
    if (subscribed)
      cleanup.push(
        new QueryObserver(client, runtime.activeOptions()).subscribe(() => {}),
      )
    const previous = client.fetchQuery(runtime.activeOptions()).catch(() => {})
    await flush()
    const ended = event(9, 4, 'sessionEnded')
    ended.payload.snapshot = {
      ...snap(9, 4),
      lifecycleStatus: 'ended',
      pokerPhase: 'betweenHands',
      hand: null,
    }
    streams[0]!.options.onEvent(ended)
    await flush()
    expect(activeReads).toBe(2)
    fresh.resolve(json({ snapshot: { ...snap(), sessionId: nextId } }))
    await flush()
    old.resolve(json({ snapshot: snap() }))
    await previous
    await flush()
    expect(client.getQueryData(keys.active())).toBe(nextId)
  },
)
it('refresh 的返回值等待 snapshot 后 GET 屏障，不暴露正常替换读取的取消', async () => {
  const barrier = deferred<Response>()
  let hold = false
  const { runtime, streams, acquire } = setup(async () =>
    hold ? barrier.promise : json({ snapshot: snap() }),
  )
  acquire()
  streams[0]!.options.onEvent(event())
  await flush()
  hold = true
  let settled = false
  const refreshing = runtime.refresh(ids.session)
  const observed = refreshing.then(
    (value) => {
      settled = true
      return value
    },
    (error) => {
      settled = true
      throw error
    },
  )
  // 先注册 rejection 观察，避免旧实现的取消形成未处理拒绝。
  const result = observed.catch((error) => error)
  streams.at(-1)!.options.onEvent(event())
  await flush()
  expect(settled).toBe(false)
  barrier.resolve(json({ snapshot: snap() }))
  await flush()
  expect(runtime.getStatus(ids.session)).toBe('ready')
  expect(await result).toEqual(snap())
})

it.each(['release', 'missing', 'protocol'] as const)(
  'refresh 在恢复中 %s 时结束等待并返回对应错误',
  async (failure) => {
    const { runtime, streams, acquire } = setup()
    const release = acquire()
    streams[0]!.options.onEvent(event())
    await flush()
    const result = runtime.refresh(ids.session).catch((error) => error)
    if (failure === 'release') release()
    else if (failure === 'missing')
      streams
        .at(-1)!
        .done.reject(new ApiError('http', 404, 'SESSION_NOT_FOUND'))
    else {
      streams.at(-1)!.done.reject(new ApiError('protocol'))
      await flush()
      streams.at(-1)!.done.reject(new ApiError('protocol'))
    }
    await flush()
    expect(await result).toMatchObject(
      failure === 'release'
        ? { kind: 'cancelled' }
        : failure === 'missing'
          ? { kind: 'http', status: 404 }
          : { kind: 'protocol' },
    )
  },
)
it('没有实时消费者时 refresh 保留显式读取，不等待不存在的连接屏障', async () => {
  const { runtime, streams } = setup()
  await expect(runtime.refresh(ids.session)).resolves.toEqual(snap())
  expect(streams).toHaveLength(0)
})
