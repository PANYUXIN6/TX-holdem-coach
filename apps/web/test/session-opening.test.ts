import { afterEach, expect, test, vi } from 'vitest'
import { MutationObserver } from '@tanstack/react-query'
import { createApi } from '../src/api/client.js'
import { createQueries } from '../src/query/options.js'
import { createQueryClient } from '../src/query/client.js'
import { createSessionRuntime } from '../src/session-sync/runtime.js'
import { keys } from '../src/query/keys.js'
import {
  initialDraft,
  setupReducer,
  createRequest,
} from '../src/session-setup/model.js'
import {
  freshRead,
  openingOptions,
  type OpeningInput,
} from '../src/session-setup/opening.js'
import { setupPersonas, rosterPreview } from './setup-fixtures.js'
import { ids, publicSnapshot } from './fixtures.js'
const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((fn) => fn()))
const json = (data: unknown, status = 200) => Response.json(data, { status })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
function fixture() {
  const client = createQueryClient()
  cleanup.push(() => client.clear())
  let configured = true
  let failure = ''
  let active = false
  let changed = false
  let hold: ReturnType<typeof deferred<Response>> | null = null
  let postHold: ReturnType<typeof deferred<Response>> | null = null
  const requests: string[] = []
  const bodies: unknown[] = []
  const fetcher: typeof fetch = async (url, init) => {
    const path = String(url)
    requests.push(`${init?.method ?? 'GET'} ${path}`)
    if (path.endsWith('/settings/providers')) {
      if (failure === 'provider') throw new TypeError('offline')
      if (hold) return hold.promise
      return json({
        deepSeek: {
          configured,
          canCreateSession: configured,
          checkStatus: configured ? 'notChecked' : 'notConfigured',
          lastCheckedAt: null,
          errorCode: null,
        },
      })
    }
    if (path.endsWith('/agent-personas'))
      return json({
        personas: setupPersonas.map((p) =>
          changed ? { ...p, personaVersion: 2 } : p,
        ),
      })
    if (path.endsWith('/latest-ended'))
      return json(
        changed
          ? { ...rosterPreview, sourceSessionId: ids.hand }
          : rosterPreview,
      )
    if (path.endsWith('/active')) {
      if (failure === 'active') throw new TypeError('offline')
      return active
        ? json({ snapshot: publicSnapshot })
        : json({ code: 'SESSION_NOT_FOUND', message: '无活动' }, 404)
    }
    if (init?.method === 'POST' && path.endsWith('/sessions')) {
      bodies.push(JSON.parse(String(init.body)))
      if (postHold) return postHold.promise
      if (failure === 'network') throw new TypeError('offline')
      if (failure === 'conflict') {
        active = true
        return json(
          {
            code: 'ACTIVE_SESSION_EXISTS',
            message: '存在活动',
            latestSnapshot: publicSnapshot,
          },
          409,
        )
      }
      active = true
      return json({ snapshot: publicSnapshot }, 201)
    }
    throw new Error(`unexpected ${path}`)
  }
  const api = createApi(fetcher)
  const runtime = createSessionRuntime(client, api)
  const reads = createQueries(api)
  const observer = new MutationObserver(
    client,
    openingOptions(client, runtime, reads),
  )
  let draft = initialDraft()
  for (const p of setupPersonas.slice(0, 5))
    draft = setupReducer(draft, {
      type: 'select',
      personaId: p.personaId,
      personaVersion: p.personaVersion,
    })
  let live = true
  const input = (): OpeningInput => ({
    ...createRequest(draft, 'current', setupPersonas),
    draft,
    source: 'current',
    valid: () => live,
  })
  return {
    client,
    runtime,
    reads,
    observer,
    requests,
    bodies,
    input,
    configure(value: boolean) {
      configured = value
    },
    fail(value: string) {
      failure = value
    },
    change() {
      changed = true
    },
    leave() {
      live = false
    },
    holdPost() {
      postHold = deferred<Response>()
      return postHold
    },
    hold() {
      hold = deferred<Response>()
      return hold
    },
  }
}
test('热缓存仍重新 GET，创建只 POST 一次并接收首手，不发开手命令或检测', async () => {
  const f = fixture()
  await f.client.fetchQuery(f.reads.personas())
  await f.client.fetchQuery(f.reads.providers())
  const result = await f.observer.mutate(f.input())
  expect(result.sessionId).toBe(ids.session)
  expect(f.client.getQueryData(keys.session(ids.session))).toMatchObject({
    pokerPhase: 'inHand',
  })
  expect(f.requests.filter((r) => r.startsWith('POST'))).toHaveLength(1)
  expect(f.requests.filter((r) => r.endsWith('/agent-personas'))).toHaveLength(
    2,
  )
  expect(f.bodies[0]).toEqual({ rosterSource: f.input().rosterSource })
})
test.each(['provider', 'changed', 'unconfigured'])(
  '%s 复核失败不能 POST',
  async (reason) => {
    const f = fixture()
    await f.client.fetchQuery(f.reads.providers())
    if (reason === 'provider') f.fail('provider')
    if (reason === 'changed') f.change()
    if (reason === 'unconfigured') f.configure(false)
    await expect(f.observer.mutate(f.input())).rejects.toThrow()
    expect(f.bodies).toHaveLength(0)
  },
)
test.each(['leave', 'remove', 'reset', 'invalidate'])(
  '复核期间 %s 不提交旧授权',
  async (reason) => {
    const f = fixture()
    const hold = f.hold()
    const pending = f.observer.mutate(f.input())
    const rejected = expect(pending).rejects.toThrow()
    await vi.waitFor(() =>
      expect(f.client.getQueryState(keys.personas())?.status).toBe('success'),
    )
    if (reason === 'leave') f.leave()
    if (reason === 'remove')
      f.client.removeQueries({ queryKey: keys.personas() })
    if (reason === 'reset')
      await f.client.resetQueries({ queryKey: keys.personas() })
    if (reason === 'invalidate')
      await f.client.invalidateQueries({
        queryKey: keys.personas(),
        refetchType: 'none',
      })
    hold.resolve(
      json({
        deepSeek: {
          configured: true,
          canCreateSession: true,
          checkStatus: 'notChecked',
          lastCheckedAt: null,
          errorCode: null,
        },
      }),
    )
    await rejected
    expect(f.bodies).toHaveLength(0)
  },
)
test('已有在途 GET 被取消并重新发起，不能合并旧读取', async () => {
  const f = fixture()
  const hold = f.hold()
  const old = f.client.fetchQuery(f.reads.providers()).catch(() => {})
  await vi.waitFor(() => expect(f.requests).toHaveLength(1))
  const fresh = freshRead(f.client, f.reads.providers())
  await vi.waitFor(() => expect(f.requests).toHaveLength(2))
  hold.resolve(
    json({
      deepSeek: {
        configured: true,
        canCreateSession: true,
        checkStatus: 'notChecked',
        lastCheckedAt: null,
        errorCode: null,
      },
    }),
  )
  expect((await fresh).valid()).toBe(true)
  await old
})
test.each(['conflict', 'network'])(
  '%s 保持失败 Mutation，原 runtime 完成活动定位且不重复 POST',
  async (failure) => {
    const f = fixture()
    f.fail(failure)
    await expect(f.observer.mutate(f.input())).rejects.toThrow()
    expect(f.observer.getCurrentResult().status).toBe('error')
    expect(f.bodies).toHaveLength(1)
    expect(f.runtime.getCreateTarget()).toBe(
      failure === 'conflict' ? ids.session : null,
    )
    expect(f.client.getQueryState(keys.active())).toMatchObject({
      status: 'success',
      fetchStatus: 'idle',
    })
  },
)

test('完整历史绑定创建；预览变化或复核时 reset 都拒绝旧绑定', async () => {
  for (const change of ['none', 'changed', 'reset']) {
    const f = fixture()
    const draft = setupReducer(initialDraft(), {
      type: 'accept',
      preview: rosterPreview,
    })
    const input: OpeningInput = {
      ...createRequest(draft, 'latestEnded', undefined, rosterPreview),
      draft,
      source: 'latestEnded',
      valid: () => true,
    }
    if (change === 'changed') f.change()
    const hold = change === 'reset' ? f.hold() : null
    const promise = f.observer.mutate(input)
    if (change === 'reset') {
      const rejected = expect(promise).rejects.toThrow()
      await vi.waitFor(() =>
        expect(f.client.getQueryState(keys.rosterPreview())?.status).toBe(
          'success',
        ),
      )
      await f.client.resetQueries({ queryKey: keys.rosterPreview() })
      hold!.resolve(
        json({
          deepSeek: {
            configured: true,
            canCreateSession: true,
            checkStatus: 'notChecked',
            lastCheckedAt: null,
            errorCode: null,
          },
        }),
      )
      await rejected
    } else if (change === 'changed') await expect(promise).rejects.toThrow()
    else {
      await promise
      expect(f.bodies[0]).toEqual({ rosterSource: input.rosterSource })
    }
    expect(f.bodies).toHaveLength(change === 'none' ? 1 : 0)
    expect(f.requests.some((r) => r.endsWith('/agent-personas'))).toBe(false)
  }
})
test('POST 后离页仍由 runtime 收尾，重入可观察全局 creating', async () => {
  const f = fixture()
  const hold = f.holdPost()
  const pending = f.observer.mutate(f.input())
  await vi.waitFor(() => expect(f.bodies).toHaveLength(1))
  f.leave()
  expect(f.runtime.isCreating()).toBe(true)
  hold.resolve(json({ snapshot: publicSnapshot }, 201))
  expect(await pending).toEqual({ sessionId: ids.session })
  expect(f.runtime.isCreating()).toBe(false)
  expect(f.client.getQueryData(keys.active())).toBe(ids.session)
})
