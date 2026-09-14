import {
  mutationOptions,
  type Query,
  type QueryClient,
} from '@tanstack/react-query'
import type * as C from '@tx-holdem-coach/contracts'
import { api as defaultApi, sessionId, type Api } from '../api/client.js'
import { ApiError } from '../api/errors.js'
import { keys } from './keys.js'
import { writePolicy } from './client.js'

const training = (query: Query) =>
  [
    'session',
    'session-ai-status',
    'sessions',
    'hands',
    'agent-runs',
    'statistics',
  ].includes(String(query.queryKey[0]))
const list = (query: Query) =>
  ((query.queryKey[0] === 'sessions' || query.queryKey[0] === 'hands') &&
    (query.queryKey[1] === 'list' || query.queryKey[1] === 'roster-preview')) ||
  query.queryKey[0] === 'statistics'
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined
}
function belongsTo(query: Query, id: string) {
  const data = record(query.state.data)
  const owner =
    query.meta?.sessionId ??
    data?.sessionId ??
    record(data?.history)?.sessionId ??
    record(data?.hand)?.sessionId
  return (
    (typeof owner === 'string' && owner.toLowerCase() === id) ||
    (query.queryKey[0] === 'session' && query.queryKey[1] === id)
  )
}
function affectedList(query: Query, id: string) {
  const key = query.queryKey
  if (key[0] === 'sessions' && key[1] === 'list')
    return record(key[2])?.lifecycle !== 'active'
  if ((key[0] === 'hands' && key[1] === 'list') || key[0] === 'statistics') {
    const filter = record(key[key[0] === 'statistics' ? 1 : 2])?.sessionId
    return filter === null || filter === undefined || filter === id
  }
  return false
}
function removeResources(
  client: QueryClient,
  predicate: (query: Query) => boolean,
) {
  for (const query of client.getQueryCache().findAll({ predicate })) {
    // removeQueries 本身不会更新现有 observer；先明确交付已删除状态。
    query.setState({
      data: undefined,
      dataUpdatedAt: 0,
      status: 'error',
      error: new ApiError('http', 404, 'RESOURCE_DELETED'),
      fetchStatus: 'idle',
    })
    client.getQueryCache().remove(query)
  }
}
async function refresh(client: QueryClient, queryKey: readonly unknown[]) {
  await client.cancelQueries({ queryKey, exact: true })
  // refetch 错误保存在读取状态，不把已提交的写入变成失败。
  await client.invalidateQueries(
    { queryKey, exact: true },
    { throwOnError: false },
  )
}
export type DataLifecycle = {
  freeze: (id?: string) => { finish: (success: boolean) => void }
}
export function createMutations(
  client: QueryClient,
  api: Api = defaultApi,
  lifecycle?: DataLifecycle,
) {
  return {
    checkProvider: () =>
      mutationOptions({
        ...writePolicy,
        mutationKey: ['settings', 'providers', 'check'],
        mutationFn: (input: {
          provider: C.ProviderPathParams['provider']
          body: C.ProviderCheckRequest
        }) => api.checkProvider(input.provider, input.body),
        onSuccess: () => refresh(client, keys.providers()),
      }),
    updateAgentSettings: () =>
      mutationOptions({
        ...writePolicy,
        mutationKey: ['settings', 'agent', 'update'],
        mutationFn: (input: C.PlayerAgentSettingsPatchRequest) =>
          api.updateAgentSettings(input),
        onSuccess: () => refresh(client, keys.agent()),
      }),
    deleteSession: () =>
      mutationOptions({
        ...writePolicy,
        onMutate: (input: {
          sessionId: string
          body: C.DeleteSessionRequest
        }) => lifecycle?.freeze(input.sessionId),
        onSettled: (_data, error, _input, context) => context?.finish(!error),
        mutationFn: (input: {
          sessionId: string
          body: C.DeleteSessionRequest
        }) => api.deleteSession(input.sessionId, input.body),
        async onSuccess(data) {
          const id = sessionId(data.deletedSessionId)
          await client.cancelQueries(
            {
              predicate: (query) =>
                belongsTo(query, id) ||
                affectedList(query, id) ||
                (query.queryKey[0] === 'sessions' &&
                  query.queryKey[1] === 'roster-preview'),
            },
            { revert: false },
          )
          removeResources(
            client,
            (query) => training(query) && !list(query) && belongsTo(query, id),
          )
          await Promise.all([
            client.resetQueries(
              { queryKey: keys.rosterPreview(), exact: true },
              { throwOnError: false },
            ),
            client.invalidateQueries(
              { predicate: (query) => affectedList(query, id) },
              { throwOnError: false },
            ),
          ])
        },
      }),
    clearData: () =>
      mutationOptions({
        ...writePolicy,
        onMutate: () => lifecycle?.freeze(),
        onSettled: (_data, error, _input, context) => context?.finish(!error),
        mutationFn: (input: C.ClearDataRequest) => api.clearData(input),
        async onSuccess() {
          await client.cancelQueries({ predicate: training }, { revert: false })
          // 保留活动列表的订阅对象以真实重新读取；reset 清掉其旧数据。
          const activeLists = new Set(
            client.getQueryCache().findAll({
              predicate: (query) =>
                training(query) && list(query) && query.isActive(),
            }),
          )
          removeResources(
            client,
            (query) => training(query) && !activeLists.has(query),
          )
          await client.resetQueries(
            { predicate: (query) => activeLists.has(query) },
            { throwOnError: false },
          )
        },
      }),
  }
}
