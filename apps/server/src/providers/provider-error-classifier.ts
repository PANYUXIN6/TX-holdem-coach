import type { ProviderPublicErrorCode } from '@tx-holdem-coach/contracts'

export type ProviderCheckFailureKind =
  | 'auth'
  | 'billing'
  | 'network'
  | 'timeout'
  | 'rateLimited'
  | 'serviceUnavailable'
  | 'unknown'

export class ProviderCheckFailure extends Error {
  public constructor(public readonly kind: ProviderCheckFailureKind) {
    super('Provider 检测失败。')
    this.name = 'ProviderCheckFailure'
  }
}

const publicCodes: Readonly<
  Record<ProviderCheckFailureKind, ProviderPublicErrorCode>
> = {
  auth: 'provider_auth_error',
  billing: 'provider_billing_unavailable',
  network: 'provider_network_error',
  timeout: 'provider_timeout',
  rateLimited: 'provider_rate_limited',
  serviceUnavailable: 'provider_service_unavailable',
  unknown: 'provider_unknown_error',
}

export function classifyProviderCheckError(
  error: unknown,
): ProviderPublicErrorCode {
  return error instanceof ProviderCheckFailure
    ? publicCodes[error.kind]
    : 'provider_unknown_error'
}
