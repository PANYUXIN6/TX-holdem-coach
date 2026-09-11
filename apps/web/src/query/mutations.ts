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
  ['session', 'sessions', 'hands', 'agent-runs', 'statistics'].includes(
    String(query.queryKey[0]),
  )
const list = (query: Query) =>
  ((query.queryKey[0] === 'sessions' || query.queryKey[0] === 'hands') &&
    query.queryKey[1] === 'list') ||
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
export function createMutations(client: QueryClient, api: Api = defaultApi) {
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
        mutationFn: (input: {
          sessionId: string
          body: C.DeleteSessionRequest
        }) => api.deleteSession(input.sessionId, input.body),
        async onSuccess(data) {
          const id = sessionId(data.deletedSessionId)
          await client.cancelQueries({ predicate: training })
          removeResources(
            client,
            (query) => training(query) && !list(query) && belongsTo(query, id),
          )
          await client.invalidateQueries(
            { predicate: (query) => affectedList(query, id) },
            { throwOnError: false },
          )
        },
      }),
    clearData: () =>
      mutationOptions({
        ...writePolicy,
        mutationFn: (input: C.ClearDataRequest) => api.clearData(input),
        async onSuccess() {
          await client.cancelQueries({ predicate: training })
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
