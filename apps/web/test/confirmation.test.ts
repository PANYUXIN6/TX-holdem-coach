import { aiStatusFixture, uniquePlayers } from './ai-fixtures.js'
import { keys } from '../src/query/keys.js'
import { expect, it } from 'vitest'
import { MutationObserver } from '@tanstack/react-query'
import { PublicSessionSnapshotSchema } from '@tx-holdem-coach/contracts'
import type { StreamOptions } from '../src/api/sse.js'
import { createApi } from '../src/api/client.js'
import { createQueryClient } from '../src/query/client.js'
import { createSessionRuntime } from '../src/session-sync/runtime.js'
import {
  abortConfirmationOptions,
  confirmationEligible,
} from '../src/ui/confirmation.js'
import { createOverlayUiStore } from '../src/ui/stores.js'
import { ids, publicSnapshot } from './fixtures.js'
const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

it('中止实际 Mutation 调度时复核旧版本，合法确认沿用原命令构造', async () => {
  let snapshot = uniquePlayers(
    PublicSessionSnapshotSchema.parse({
      ...publicSnapshot,
      agentRunState: 'paused',
      hand: {
        ...publicSnapshot.hand,
        currentActorSeatNumber: 1,
        legalActions: [],
      },
    }),
  )
  const requests: unknown[] = []
  let stream!: StreamOptions
  const client = createQueryClient()
  const runtime = createSessionRuntime(
    client,
    createApi(async (_url, init) => {
      if (init?.method === 'POST') requests.push(JSON.parse(String(init.body)))
      return Response.json({ snapshot })
    }),
    async (options) => {
      stream = options
      await new Promise<void>((resolve) =>
        options.signal.addEventListener('abort', () => resolve()),
      )
    },
  )
  const release = runtime.acquire(ids.session)
  const emit = () =>
    stream.onEvent({
      eventId: ids.event,
      sessionId: ids.session,
      eventSeq: snapshot.eventSeq,
      stateVersion: snapshot.stateVersion,
      type: 'snapshot',
      payload: { snapshot },
    })
  try {
    emit()
    await flush()
    const store = createOverlayUiStore()
    const open = () => {
      client.setQueryData(
        keys.sessionAiStatus(ids.session),
        aiStatusFixture(snapshot),
      )
      store.getState().open('page', {
        kind: 'abortHandAndEndSession',
        expectedPausedRunId: '40000000-0000-4000-8000-000000000001',
        eventSeq: snapshot.eventSeq,
        sessionId: ids.session,
        handId: ids.hand,
        stateVersion: snapshot.stateVersion,
      })
      return store.getState().active!
    }
    const target = open()
    if (target.kind !== 'abortHandAndEndSession') throw new Error('target')
    const mutation = new MutationObserver(
      client,
      abortConfirmationOptions(
        client,
        runtime,
        (value) => store.getState().active === value,
      ),
    )
    expect(confirmationEligible(target, client, runtime)).toBe(true)
    const rejected = mutation.mutate(target)
    snapshot = {
      ...snapshot,
      stateVersion: snapshot.stateVersion + 1,
      eventSeq: snapshot.eventSeq + 1,
    }
    emit()
    await expect(rejected).rejects.toMatchObject({ code: 'SESSION_NOT_READY' })
    expect(requests).toHaveLength(0)
    store.getState().close(target.instanceId)
    const next = open()
    if (next.kind !== 'abortHandAndEndSession') throw new Error('target')
    await mutation.mutate(next)
    expect(requests).toEqual([
      {
        command: {
          commandId: expect.any(String),
          sessionId: ids.session,
          expectedStateVersion: 5,
          type: 'endSession',
          payload: {
            expectedPausedRunId: '40000000-0000-4000-8000-000000000001',
          },
        },
      },
    ])
  } finally {
    release()
    client.clear()
  }
})

it('删除资格要求已结束的可读快照，读取在途不借用缓存授权', async () => {
  const client = createQueryClient()
  const snapshot = PublicSessionSnapshotSchema.parse({
    ...publicSnapshot,
    lifecycleStatus: 'ended',
    pokerPhase: 'betweenHands',
    hand: null,
  })
  let release!: (value: Response) => void
  const runtime = createSessionRuntime(
    client,
    createApi(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
    ),
  )
  const target = {
    kind: 'deleteSession' as const,
    sessionId: ids.session,
    scope: 'page',
    instanceId: 1,
  }
  try {
    expect(confirmationEligible(target, client, runtime)).toBe(false)
    client.setQueryData(['session', ids.session], snapshot)
    expect(confirmationEligible(target, client, runtime)).toBe(true)
    const read = client.fetchQuery(runtime.sessionOptions(ids.session))
    expect(confirmationEligible(target, client, runtime)).toBe(false)
    release(Response.json({ snapshot }))
    await read
    expect(confirmationEligible(target, client, runtime)).toBe(true)
    client.setQueryData(['session', ids.session], {
      ...snapshot,
      lifecycleStatus: 'readonlyDiagnostic',
    })
    expect(confirmationEligible(target, client, runtime)).toBe(false)
  } finally {
    client.clear()
  }
})
