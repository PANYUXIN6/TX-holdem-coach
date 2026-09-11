import { QueryCache, QueryClient } from '@tanstack/react-query'
import { ApiError } from '../api/errors.js'

export const readPolicy = { retry: false, networkMode: 'always' } as const
export const writePolicy = { retry: false, networkMode: 'always' } as const
export function createQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache({
      onError(error, query) {
        if (
          error instanceof ApiError &&
          error.kind === 'http' &&
          error.status === 404 &&
          query.meta?.resourceDetail
        ) {
          // 保留 error 状态供现有订阅展示，同时丢弃旧的成功投影。
          query.setState({ data: undefined, dataUpdatedAt: 0 })
        }
      },
    }),
    defaultOptions: {
      queries: {
        ...readPolicy,
        staleTime: 0,
        gcTime: 5 * 60_000,
        refetchOnMount: true,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        refetchInterval: false,
        throwOnError: false,
      },
      mutations: { ...writePolicy, throwOnError: false },
    },
  })
}
