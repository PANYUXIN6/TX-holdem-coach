import { afterEach, describe, expect, it, vi } from 'vitest'
import { MutationObserver } from '@tanstack/react-query'
import {
  PublicSessionSnapshotSchema,
  type PublicSessionSnapshot,
  type SseEvent,
} from '@tx-holdem-coach/contracts'
import { createApi } from '../src/api/client.js'
import type { StreamOptions } from '../src/api/sse.js'
import { createQueryClient } from '../src/query/client.js'
import { createSessionRuntime } from '../src/session-sync/runtime.js'
import { createTableScope } from '../src/ui/table-adapter.js'
import { completeTable, tableSnapshot } from './table-fixtures.js'
import { ids, publicSnapshot } from './fixtures.js'

const cleanups: (() => void)[] = []
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
)
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve()
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
function setup() {
  let current = PublicSessionSnapshotSchema.parse(publicSnapshot)
  const posts: unknown[] = []
  const response = deferred<Response>()
  const streams: StreamOptions[] = []
  const client = createQueryClient()
  const runtime = createSessionRuntime(
    client,
    createApi(async (_url, init) => {
      if (init?.method === 'POST' || init?.method === 'DELETE') {
        posts.push(JSON.parse(String(init.body)))
        return response.promise
      }
      return Response.json({ snapshot: current })
    }),
    (options) =>
      new Promise<void>((resolve) => {
        streams.push(options)
        options.signal.addEventListener('abort', () => resolve())
      }),
  )
  const scope = createTableScope(ids.session, client, runtime)
  cleanups.push(
    () => client.clear(),
    runtime.acquire(ids.session),
    scope.mount(),
  )
  function emit(
    next: PublicSessionSnapshot,
    type: SseEvent['type'] = 'actionCommitted',
  ) {
    PublicSessionSnapshotSchema.parse(next)
    current = next
    streams.at(-1)!.onEvent({
      eventId: ids.event,
      sessionId: ids.session,
      eventSeq: next.eventSeq,
      stateVersion: next.stateVersion,
      type,
      payload: { snapshot: next },
    })
  }
  emit(current, 'snapshot')
  return {
    client,
    runtime,
    scope,
    posts,
    response,
    streams,
    emit,
    current: () => current,
  }
}
describe('牌桌适配器与生产同步', () => {
  it('建议金额通过真实 Mutation 提交；进入 submitting 同步清空，失败不恢复或重发', async () => {
    const s = setup()
    await flush()
    expect(s.scope.begin('raise')).toBe(true)
    expect(s.scope.suggest(90)).toBe(true)
    const mutation = new MutationObserver(s.client, s.scope.commandOptions())
    const pending = mutation.mutate(s.scope.currentDraft()!)
    await flush()
    expect(s.posts).toHaveLength(1)
    expect(s.posts[0]).toMatchObject({
      command: {
        expectedStateVersion: 4,
        type: 'playerAction',
        payload: { action: { type: 'raise', targetStreetCommitment: 90 } },
      },
    })
    expect(s.scope.table.getState().betDraft).toBeNull()
    s.response.resolve(
      Response.json({ error: { code: 'INVALID_ACTION' } }, { status: 400 }),
    )
    await expect(pending).rejects.toBeDefined()
    await flush()
    expect(s.scope.table.getState().betDraft).toBeNull()
    expect(s.posts).toHaveLength(1)
  })
  it('非法金额保留输入；onMutate 期间版本推进使旧输入零 POST', async () => {
    const s = setup()
    await flush()
    s.scope.begin('raise')
    s.scope.table.getState().editDraft('1e2')
    await expect(
      new MutationObserver(s.client, s.scope.commandOptions()).mutate(
        s.scope.currentDraft()!,
      ),
    ).rejects.toThrow('正整数')
    expect(s.scope.table.getState().betDraft?.input).toBe('1e2')
    s.scope.table.getState().editDraft('90')
    const pause = deferred<void>()
    const mutation = new MutationObserver(s.client, {
      ...s.scope.commandOptions(),
      onMutate: () => pause.promise,
    })
    const pending = mutation.mutate(s.scope.currentDraft()!)
    await flush()
    s.emit({ ...s.current(), stateVersion: 5, eventSeq: 9 })
    pause.resolve()
    await expect(pending).rejects.toThrow('失效')
    expect(s.posts).toHaveLength(0)
  })
  it('同版本协调更新保留输入；paused、隐藏、冻结清理且不复原', async () => {
    const s = setup()
    await flush()
    s.scope.begin('raise')
    s.scope.table.getState().editDraft('90')
    s.emit({ ...s.current(), eventSeq: 9 })
    expect(s.scope.currentDraft()?.input).toBe('90')
    s.emit(
      {
        ...s.current(),
        eventSeq: 10,
        agentRunState: 'paused',
        hand: { ...s.current().hand!, legalActions: [] },
      },
      'agentPaused',
    )
    expect(s.scope.currentDraft()).toBeNull()
    s.emit(
      {
        ...s.current(),
        eventSeq: 11,
        agentRunState: 'idle',
        hand: {
          ...s.current().hand!,
          legalActions:
            PublicSessionSnapshotSchema.parse(publicSnapshot).hand!
              .legalActions,
        },
      },
      'agentRepairAttempted',
    )
    s.scope.begin('raise')
    s.scope.environment(true, false)
    expect(s.scope.currentDraft()).toBeNull()
    s.scope.environment(false, false)
    expect(s.scope.currentDraft()).toBeNull()
    s.scope.begin('raise')
    s.runtime.visibility(true)
    expect(s.scope.table.getState().betDraft).toBeNull()
  })
  it.each(['http', 'sse'] as const)(
    '%s 先接受只通知一次；抛错 listener 不影响命令或其他订阅',
    async (first) => {
      const s = setup()
      await flush()
      const listener = vi.fn()
      cleanups.push(
        s.runtime.subscribeEffects(ids.session, () => {
          throw new Error('UI')
        }),
        s.runtime.subscribeEffects(ids.session, listener),
      )
      s.scope.begin('raise')
      const pending = new MutationObserver(
        s.client,
        s.scope.commandOptions(),
      ).mutate(s.scope.currentDraft()!)
      await flush()
      const next = {
        ...s.current(),
        eventSeq: 9,
        stateVersion: 5,
        hand: {
          ...s.current().hand!,
          pot: 100,
          currentActorSeatNumber: 1,
          legalActions: [],
        },
      }
      if (first === 'sse') s.emit(next)
      s.response.resolve(Response.json({ snapshot: next }))
      await pending
      if (first === 'http') s.emit(next)
      expect(listener).toHaveBeenCalledTimes(1)
      expect(s.scope.animation.getState().batch).toMatchObject({
        stateVersion: 5,
        effects: [
          { type: 'chips', seats: [], pot: true },
          { type: 'turn', seatNumber: 1 },
        ],
      })
      s.emit({
        ...next,
        eventSeq: 10,
        stateVersion: 6,
        hand: { ...next.hand, pot: 120 },
      })
      s.scope.animation
        .getState()
        .ack({ sessionId: ids.session, stateVersion: 5 })
      expect(s.scope.animation.getState().batch?.stateVersion).toBe(6)
      s.scope.environment(false, true)
      expect(s.scope.animation.getState().batch).toBeNull()
      s.emit({ ...next, eventSeq: 11, stateVersion: 7 })
      expect(s.scope.animation.getState().batch).toBeNull()
    },
  )
  it('隐藏恢复补发与 GET 不入队；恢复后仅接收未来实时版本', async () => {
    const s = setup()
    await flush()
    const listener = vi.fn()
    cleanups.push(s.runtime.subscribeEffects(ids.session, listener))
    s.runtime.visibility(true)
    s.runtime.visibility(false)
    s.emit({ ...s.current(), eventSeq: 9, stateVersion: 5 })
    s.emit({ ...s.current(), eventSeq: 10, stateVersion: 6 })
    s.emit(s.current(), 'snapshot')
    await flush()
    expect(s.runtime.getStatus(ids.session)).toBe('ready')
    expect(listener).not.toHaveBeenCalled()
    s.emit({ ...s.current(), eventSeq: 11, stateVersion: 7 })
    expect(listener).toHaveBeenCalledTimes(1)
  })
  it('清空冻结在 DELETE 响应前清除输入和效果，失败不会恢复草稿', async () => {
    const s = setup()
    await flush()
    s.emit({ ...s.current(), eventSeq: 9, stateVersion: 5 })
    s.scope.begin('raise')
    const pending = new MutationObserver(
      s.client,
      s.runtime.mutations.clearData(),
    ).mutate({ confirmation: '永久清空全部数据' })
    await flush()
    expect(s.runtime.getStatus(ids.session)).toBe('blocked')
    expect(s.scope.table.getState().betDraft).toBeNull()
    expect(s.scope.animation.getState().batch).toBeNull()
    s.response.resolve(
      Response.json(
        { code: 'INTERNAL_ERROR', message: '失败' },
        { status: 500 },
      ),
    )
    await expect(pending).rejects.toBeDefined()
    await flush()
    expect(s.scope.table.getState().betDraft).toBeNull()
  })
  it('失败的 latestSnapshot 只校准，不发布成功动画', async () => {
    const s = setup()
    await flush()
    const listener = vi.fn()
    cleanups.push(s.runtime.subscribeEffects(ids.session, listener))
    s.scope.begin('raise')
    const pending = new MutationObserver(
      s.client,
      s.scope.commandOptions(),
    ).mutate(s.scope.currentDraft()!)
    await flush()
    s.response.resolve(
      Response.json(
        {
          code: 'STATE_VERSION_CONFLICT',
          message: '冲突',
          latestSnapshot: { ...s.current(), eventSeq: 9, stateVersion: 5 },
        },
        { status: 409 },
      ),
    )
    await expect(pending).rejects.toBeDefined()
    expect(listener).not.toHaveBeenCalled()
    expect(s.scope.animation.getState().batch).toBeNull()
  })

  it('等待 Mutation 时清除并重新编辑相同文本，旧草稿仍不可提交', async () => {
    const s = setup()
    await flush()
    s.scope.begin('raise')
    const pause = deferred<void>()
    const pending = new MutationObserver(s.client, {
      ...s.scope.commandOptions(),
      onMutate: () => pause.promise,
    }).mutate(s.scope.currentDraft()!)
    await flush()
    s.scope.table.getState().clearDraft()
    s.scope.begin('raise')
    pause.resolve()
    await expect(pending).rejects.toThrow('失效')
    expect(s.posts).toHaveLength(0)
  })
  it.each(['fold', 'call', 'allIn'] as const)(
    '旧 %s 意图不能穿越版本',
    async (type) => {
      const s = setup()
      await flush()
      const intent = s.scope.capture({ type })!
      const pause = deferred<void>()
      const pending = new MutationObserver(s.client, {
        ...s.scope.intentOptions(() => true),
        onMutate: () => pause.promise,
      }).mutate(intent)
      await flush()
      s.emit({ ...s.current(), stateVersion: 5, eventSeq: 9 })
      pause.resolve()
      await expect(pending).rejects.toThrow('失效')
      expect(s.posts).toHaveLength(0)
    },
  )
  it('正常结束确认不能成为新手暂停后的中止', async () => {
    const s = setup()
    await flush()
    const hand = s.current().hand
    s.emit({
      ...completeTable({ ...tableSnapshot(6), seats: s.current().seats }),
      stateVersion: 5,
      eventSeq: 9,
    })
    expect(s.runtime.getStatus(ids.session)).toBe('ready')
    const intent = s.scope.capture({ type: 'endSession' })!
    expect(intent).not.toBeNull()
    const pause = deferred<void>()
    const pending = new MutationObserver(s.client, {
      ...s.scope.intentOptions(() => true),
      onMutate: () => pause.promise,
    }).mutate(intent)
    await flush()
    s.emit({
      ...s.current(),
      hand: { ...hand!, handId: crypto.randomUUID(), legalActions: [] },
      tableDisplay: undefined,
      lastCompletedHandSummary: null,
      pokerPhase: 'inHand',
      agentRunState: 'paused',
      stateVersion: 6,
      eventSeq: 10,
    })
    pause.resolve()
    await expect(pending).rejects.toThrow('失效')
    expect(s.posts).toHaveLength(0)
  })

  it.each(['call', 'allIn'] as const)(
    '%s 仅发送动作类型，SSE 先到仍由原请求占用提交',
    async (type) => {
      const s = setup()
      await flush()
      const intent = s.scope.capture({ type })!
      const pending = new MutationObserver(
        s.client,
        s.scope.intentOptions(() => true),
      ).mutate(intent)
      await flush()
      expect(s.posts).toHaveLength(1)
      expect(s.posts[0]).toMatchObject({
        command: { payload: { action: { type } } },
      })
      expect(
        (s.posts[0] as { command: { payload: unknown } }).command.payload,
      ).toEqual({ action: { type } })
      s.emit({ ...s.current(), stateVersion: 5, eventSeq: 9 })
      expect(s.scope.capture({ type: 'fold' })).toBeNull()
      s.response.resolve(Response.json({ snapshot: s.current() }))
      await pending
    },
  )
  it('未知结果校准 ready 后拒绝新命令，重发沿用原请求', async () => {
    const s = setup()
    await flush()
    const pending = new MutationObserver(
      s.client,
      s.scope.intentOptions(() => true),
    ).mutate(s.scope.capture({ type: 'call' })!)
    await flush()
    s.response.resolve(new Response('bad response'))
    await expect(pending).rejects.toBeDefined()
    const refreshing = s.runtime.refresh(ids.session)
    await flush()
    s.emit(s.current(), 'snapshot')
    await refreshing
    await flush()
    expect(s.runtime.getStatus(ids.session)).toBe('ready')
    expect(s.scope.begin('raise')).toBe(false)
    expect(s.scope.capture({ type: 'fold' })).toBeNull()
    const operation = s.runtime.pendingOperations(ids.session)[0]!
    await expect(
      s.runtime.resend(ids.session, operation.command.commandId),
    ).rejects.toBeDefined()
    expect(s.posts).toHaveLength(2)
    expect(s.posts[1]).toEqual(s.posts[0])
  })
  it('部分补码使用追加额；确认关闭后同值重建不复用旧来源', async () => {
    const s = setup()
    await flush()
    s.emit({
      ...completeTable({ ...tableSnapshot(6), seats: s.current().seats }),
      stateVersion: 5,
      eventSeq: 9,
    })
    const intent = s.scope.capture({ type: 'rebuy', amount: 50 })!
    const pending = new MutationObserver(
      s.client,
      s.scope.intentOptions(() => true),
    ).mutate(intent)
    await flush()
    expect(s.posts[0]).toMatchObject({
      command: { type: 'rebuy', payload: { amount: 50 } },
    })
    const summary = s.current().lastCompletedHandSummary
    s.response.resolve(
      Response.json({
        snapshot: {
          ...s.current(),
          eventSeq: 10,
          stateVersion: 6,
          seats: s
            .current()
            .seats.map((seat) =>
              seat.isUser ? { ...seat, stack: seat.stack + 50 } : seat,
            ),
        },
      }),
    )
    await pending
    expect(
      s.client.getQueryData<{ lastCompletedHandSummary: unknown }>([
        'session',
        ids.session,
      ])?.lastCompletedHandSummary,
    ).toEqual(summary)
    const cancelled = s.scope.capture({ type: 'endSession' })!
    await expect(
      new MutationObserver(
        s.client,
        s.scope.intentOptions(() => false),
      ).mutate(cancelled),
    ).rejects.toThrow('失效')
    expect(s.posts).toHaveLength(1)
  })
})
