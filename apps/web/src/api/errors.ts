import type {
  PublicSessionSnapshot,
  ProviderCheckStatus,
  ProviderPublicErrorCode,
} from '@tx-holdem-coach/contracts'
import type { z } from 'zod'

export type ApiErrorKind =
  'input' | 'network' | 'protocol' | 'http' | 'cancelled'
export class ApiError extends Error {
  readonly name = 'ApiError'
  constructor(
    readonly kind: ApiErrorKind,
    readonly status?: number,
    readonly code?: string,
    readonly fieldPaths: readonly string[] = [],
    readonly latestSnapshot?: PublicSessionSnapshot,
  ) {
    super(`API ${kind}`)
    // 产品错误和 Query 日志均不携带原始异常栈或响应正文。
    delete this.stack
  }
}
export function parseInput<S extends z.ZodType>(
  schema: S,
  input: unknown,
): z.output<S> {
  const result = schema.safeParse(input)
  if (!result.success)
    throw new ApiError(
      'input',
      undefined,
      undefined,
      safeFieldPaths(result.error.issues.map((issue) => issue.path)),
    )
  return result.data
}
export function errorMessage(error: unknown): string | null {
  if (!(error instanceof ApiError)) return '操作未完成，请稍后重新读取。'
  if (error.kind === 'cancelled') return null
  if (error.kind === 'input') return '请检查并修改请求参数。'
  if (error.kind === 'network') return '无法连接服务，请检查服务后重新读取。'
  if (error.kind === 'protocol')
    return '响应格式不兼容，请刷新页面并确认前后端版本一致。'
  if (error.status === 404) return '资源已不可用。'
  if (error.code === 'STATE_VERSION_CONFLICT')
    return '状态已变化，请等待校准后重新决策。'
  if (error.code === 'SESSION_READONLY_DIAGNOSTIC')
    return '场次处于只读诊断状态，无法进行牌局操作。'
  return '请求未完成，请重新读取当前状态。'
}

const safeFields = new Set([
  'settings',
  'attemptTimeoutSeconds',
  'decisionDeadlineSeconds',
  'confirmation',
  'command',
  'commandId',
  'sessionId',
  'expectedStateVersion',
  'from',
  'to',
  'limit',
  'cursor',
  'view',
  'personaId',
  'personaVersion',
  'personaName',
])
export function safeFieldPaths(
  paths: readonly (readonly PropertyKey[])[],
): string[] {
  return paths
    .filter(
      (path) =>
        path.length > 0 &&
        path.every((part) => typeof part === 'string' && safeFields.has(part)),
    )
    .map((path) => path.join('.'))
}
export function fieldMessages(
  error: ApiError,
  allowedPaths: readonly string[],
): Record<string, string> {
  return Object.fromEntries(
    error.fieldPaths
      .filter((path) => allowedPaths.includes(path))
      .map((path) => [path, '请检查此项参数。']),
  )
}

export const providerStatusMessages: Record<ProviderCheckStatus, string> = {
  notConfigured: '尚未配置',
  notChecked: '尚未检测',
  available: '检测可用',
  unavailable: '检测不可用',
}
export const providerErrorMessages: Record<ProviderPublicErrorCode, string> = {
  provider_auth_error: '供应商认证失败',
  provider_billing_unavailable: '供应商账户暂不可用',
  provider_network_error: '无法连接供应商',
  provider_timeout: '供应商响应超时',
  provider_rate_limited: '供应商请求受限',
  provider_service_unavailable: '供应商服务暂不可用',
  provider_unknown_error: '供应商检测未完成',
}
