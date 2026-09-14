import { expect, it, vi } from 'vitest'
import { MutationObserver } from '@tanstack/react-query'
import { PublicSessionSnapshotSchema } from '@tx-holdem-coach/contracts'
import { createQueryClient } from '../src/query/client.js'
import { keys } from '../src/query/keys.js'
import { maintainSessionResources } from '../src/query/session-resources.js'
import {
  aiStatusMatches,
  pauseCommandOptions,
  pauseIntentMatches,
} from '../src/ai-status/adapter.js'
import { createApi } from '../src/api/client.js'
import { createQueries } from '../src/query/options.js'
import type { SessionRuntime } from '../src/session-sync/runtime.js'
import { aiStatusFixture, uniquePlayers } from './ai-fixtures.js'
import { ids, publicSnapshot } from './fixtures.js'
const paused = () =>
  uniquePlayers(
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
it('AI Query 独立读取且不写入唯一快照；协调事件使摘要失效', async () => {
  const client = createQueryClient()
  const snapshot = paused()
  const ai = aiStatusFixture(snapshot)
  const fetcher = vi.fn(async () => Response.json(ai))
  const options = createQueries(createApi(fetcher)).sessionAiStatus(ids.session)
  try {
    client.setQueryData(keys.session(ids.session), snapshot)
    expect(await client.fetchQuery(options)).toEqual(ai)
    expect(client.getQueryData(keys.session(ids.session))).toBe(snapshot)
    const next = { ...snapshot, eventSeq: snapshot.eventSeq + 1 }
    expect(aiStatusMatches(next, ai)).toBe(false)
    maintainSessionResources(
      client,
      snapshot,
      next,
      false,
      () => true,
      'agentRepairAttempted',
    )
    await vi.waitFor(() =>
      expect(client.getQueryState(options.queryKey)?.isInvalidated).toBe(true),
    )
  } finally {
    client.clear()
  }
})
it('延迟 Mutation 不可用旧暂停意图；未决命令和读取在途关闭恢复资格', async () => {
  const client = createQueryClient()
  const snapshot = paused()
  const ai = aiStatusFixture(snapshot)
  const send = vi.fn(async (_intent: unknown) => ({ snapshot }))
  let pending = false
  const runtime = {
    getStatus: () => 'ready',
    isSubmitting: () => false,
    pendingOperations: () => (pending ? [{}] : []),
    commandOptions: () => ({ mutationFn: send }),
  } as unknown as SessionRuntime
  const intent = {
    scope: 'page',
    sessionId: ids.session,
    handId: ids.hand,
    stateVersion: snapshot.stateVersion,
    eventSeq: snapshot.eventSeq,
    expectedPausedRunId:
      ai.coordination.state === 'paused' ? ai.coordination.run.runId : '',
  }
  const install = () => {
    client.setQueryData(keys.session(ids.session), snapshot)
    client.setQueryData(keys.sessionAiStatus(ids.session), ai)
  }
  try {
    install()
    const mutation = new MutationObserver(
      client,
      pauseCommandOptions(client, runtime, () => true),
    )
    const stale = mutation.mutate(intent)
    const next = { ...snapshot, eventSeq: snapshot.eventSeq + 2 }
    client.setQueryData(keys.session(ids.session), next)
    client.setQueryData(
      keys.sessionAiStatus(ids.session),
      aiStatusFixture(next, ids.command),
    )
    await expect(stale).rejects.toMatchObject({ code: 'SESSION_NOT_READY' })
    expect(send).not.toHaveBeenCalled()
    install()
    pending = true
    await expect(mutation.mutate(intent)).rejects.toMatchObject({
      code: 'SESSION_NOT_READY',
    })
    pending = false
    client
      .getQueryCache()
      .find({ queryKey: keys.sessionAiStatus(ids.session) })!
      .setState({ fetchStatus: 'fetching' })
    expect(pauseIntentMatches(intent, client)).toBe(false)
    client
      .getQueryCache()
      .find({ queryKey: keys.sessionAiStatus(ids.session) })!
      .setState({ fetchStatus: 'idle' })
    await mutation.mutate(intent)
    expect(send.mock.calls[0]?.[0]).toEqual({
      type: 'retryAgent',
      payload: { expectedPausedRunId: intent.expectedPausedRunId },
    })
  } finally {
    client.clear()
  }
})
