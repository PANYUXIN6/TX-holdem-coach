import { APICallError } from 'ai'
import type { ModelGatewayFailure } from '../foundation/errors.js'

export type StableProviderFailure = Extract<
  ModelGatewayFailure,
  | 'provider_billing_unavailable'
  | 'provider_network_error'
  | 'provider_timeout'
  | 'provider_service_unavailable'
  | 'provider_auth_error'
  | 'provider_rate_limited'
  | 'provider_unknown_error'
  | 'runtime_cancelled'
>

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
])

function hasNetworkErrorCode(error: unknown): boolean {
  let current = error
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== 'object' || current === null) return false
    if (
      'code' in current &&
      typeof current.code === 'string' &&
      NETWORK_CODES.has(current.code)
    ) {
      return true
    }
    if (!('cause' in current)) return false
    current = current.cause
  }
  return false
}

export function classifyProviderError(
  error: unknown,
  signal: AbortSignal,
): StableProviderFailure {
  if (signal.aborted) {
    return signal.reason === 'provider_timeout'
      ? 'provider_timeout'
      : 'runtime_cancelled'
  }
  if (APICallError.isInstance(error)) {
    switch (error.statusCode) {
      case 401:
      case 403:
        return 'provider_auth_error'
      case 402:
        return 'provider_billing_unavailable'
      case 429:
        return 'provider_rate_limited'
      case 500:
      case 502:
      case 503:
      case 504:
        return 'provider_service_unavailable'
      default:
        return error.statusCode === undefined &&
          hasNetworkErrorCode(error.cause)
          ? 'provider_network_error'
          : 'provider_unknown_error'
    }
  }
  return hasNetworkErrorCode(error)
    ? 'provider_network_error'
    : 'provider_unknown_error'
}
