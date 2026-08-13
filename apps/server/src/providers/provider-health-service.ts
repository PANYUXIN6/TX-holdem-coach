import {
  PROTOCOL_VERSION,
  ProviderSettingsResponseSchema,
  type ProviderHealthSummary,
  type ProviderId,
  type ProviderSettingsResponse,
} from '@tx-holdem-coach/contracts'
import type { ServerConfig } from '../config.js'
import type { ProviderCheckTransport } from './provider-check-transport.js'
import { classifyProviderCheckError } from './provider-error-classifier.js'

export interface ProviderHealthService {
  read(): ProviderSettingsResponse
  check(provider: ProviderId): Promise<ProviderSettingsResponse>
}

export interface ProviderCheckLogEntry {
  readonly provider: ProviderId
  readonly errorCode: ProviderHealthSummary['errorCode']
  readonly durationMs: number
}

export function createProviderHealthService(input: {
  readonly config: ServerConfig
  readonly transport: ProviderCheckTransport
  readonly now?: () => string
  readonly logCheck?: (entry: ProviderCheckLogEntry) => void
}): ProviderHealthService {
  const { config, transport } = input
  const now = input.now ?? (() => new Date().toISOString())
  const checked = new Map<ProviderId, ProviderHealthSummary>()
  const inFlight = new Map<ProviderId, Promise<ProviderSettingsResponse>>()

  const configured = (provider: ProviderId) =>
    provider === 'deepseek'
      ? config.hasDeepSeekApiKey()
      : config.hasKimiApiKey()
  const key = (provider: ProviderId) =>
    provider === 'deepseek'
      ? config.getDeepSeekApiKey()
      : config.getKimiApiKey()
  const summary = (provider: ProviderId): ProviderHealthSummary => {
    if (!configured(provider)) {
      return {
        configured: false,
        checkStatus: 'notConfigured',
        lastCheckedAt: null,
        errorCode: null,
      }
    }
    return (
      checked.get(provider) ?? {
        configured: true,
        checkStatus: 'notChecked',
        lastCheckedAt: null,
        errorCode: null,
      }
    )
  }
  const read = (): ProviderSettingsResponse =>
    ProviderSettingsResponseSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      deepSeek: {
        ...summary('deepseek'),
        canCreateSession: config.hasDeepSeekApiKey(),
      },
      kimi: {
        ...summary('kimi'),
        canFallback: config.hasKimiApiKey(),
      },
    })

  return Object.freeze({
    read,
    async check(provider: ProviderId): Promise<ProviderSettingsResponse> {
      const apiKey = key(provider)
      if (apiKey === undefined) return read()
      const existing = inFlight.get(provider)
      if (existing !== undefined) return existing

      const operation = (async () => {
        const startedAt = Date.now()
        try {
          await transport.check(provider, apiKey)
          checked.set(provider, {
            configured: true,
            checkStatus: 'available',
            lastCheckedAt: now(),
            errorCode: null,
          })
        } catch (error) {
          checked.set(provider, {
            configured: true,
            checkStatus: 'unavailable',
            lastCheckedAt: now(),
            errorCode: classifyProviderCheckError(error),
          })
        }
        try {
          input.logCheck?.({
            provider,
            errorCode: checked.get(provider)?.errorCode ?? null,
            durationMs: Date.now() - startedAt,
          })
        } catch {
          // Diagnostics never change the provider check result.
        }
        return read()
      })()
      inFlight.set(provider, operation)
      try {
        return await operation
      } finally {
        inFlight.delete(provider)
      }
    },
  })
}
