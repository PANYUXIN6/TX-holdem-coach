import type { CreateSessionRequest } from '@tx-holdem-coach/contracts'
import {
  mutationOptions,
  type QueryClient,
  type QueryKey,
  type FetchQueryOptions,
} from '@tanstack/react-query'
import { ApiError } from '../api/errors.js'
import { queries } from '../query/options.js'
import type { SessionRuntime } from '../session-sync/runtime.js'
import { createRequest, type SetupDraft, type SetupSource } from './model.js'

export class OpeningError extends Error {
  constructor(
    public reason: 'active' | 'source' | 'provider' | 'read',
    public target: string | null = null,
  ) {
    super(
      {
        active: '已找到活动训练场，请继续当前训练场',
        source: '阵容来源已变化，请返回选择阵容重新确认',
        provider: 'DeepSeek 配置暂不可用，请重新读取配置',
        read: '复核读取未完成或已失效，请重新确认',
      }[reason],
    )
  }
}
// 取消旧 GET 后重新读取；保留 Query 对象身份和最终状态核对，拒绝 reset/remove 后的旧授权。
export async function freshRead<T, K extends QueryKey>(
  client: QueryClient,
  options: FetchQueryOptions<T, Error, T, K>,
) {
  await client.cancelQueries({ queryKey: options.queryKey, exact: true })
  const promise = client.fetchQuery({ ...options, staleTime: 0 })
  const query = client
    .getQueryCache()
    .find({ queryKey: options.queryKey, exact: true })
  const data = await promise
  const state = query?.state
  return {
    data,
    valid: () => {
      const current = client
        .getQueryCache()
        .find({ queryKey: options.queryKey, exact: true })
      return (
        current === query &&
        current?.state === state &&
        current?.state.status === 'success' &&
        current.state.fetchStatus === 'idle' &&
        !current.state.isInvalidated
      )
    },
  }
}
export type OpeningInput = CreateSessionRequest & {
  draft: SetupDraft
  source: SetupSource
  valid: () => boolean
}
export function openingOptions(
  client: QueryClient,
  runtime: SessionRuntime,
  reads = queries,
) {
  const original = runtime.createOptions()
  return mutationOptions<{ sessionId: string | null }, Error, OpeningInput>({
    ...original,
    mutationFn: async (input: OpeningInput, context) => {
      if (!input.valid() || runtime.isCreating())
        throw new ApiError('cancelled')
      const results = await Promise.allSettled([
        freshRead(client, runtime.activeOptions()),
        freshRead(client, reads.providers()),
        input.source === 'current'
          ? freshRead(client, reads.personas())
          : freshRead(client, reads.rosterPreview()),
      ])
      if (!input.valid()) throw new ApiError('cancelled')
      const [active, provider, source] = results
      if (
        active.status !== 'fulfilled' ||
        provider.status !== 'fulfilled' ||
        source.status !== 'fulfilled' ||
        !active.value.valid() ||
        !provider.value.valid() ||
        !source.value.valid()
      )
        throw new OpeningError('read')
      if (active.value.data) throw new OpeningError('active', active.value.data)
      if (!provider.value.data.deepSeek.canCreateSession)
        throw new OpeningError('provider')
      const data = source.value.data
      let body
      try {
        body = createRequest(
          input.draft,
          input.source,
          'personas' in data ? data.personas : undefined,
          'agents' in data ? data : undefined,
        )
      } catch {
        throw new OpeningError('source')
      }
      if (!input.valid() || runtime.isCreating())
        throw new ApiError('cancelled')
      return original.mutationFn!(body, context)
    },
  })
}
