import { describe, expect, test, vi } from 'vitest'
import { ServerConfig } from '../../src/config.js'
import { createProviderHealthService } from '../../src/providers/provider-health-service.js'
import { ProviderCheckFailure } from '../../src/providers/provider-error-classifier.js'

function config(keys: { deepSeek?: string } = {}) {
  return new ServerConfig({
    port: 8787,
    databaseUrl: 'postgresql://runtime',
    ...(keys.deepSeek === undefined ? {} : { deepSeekApiKey: keys.deepSeek }),
  })
}

describe('provider health service', () => {
  test('GET projection performs no network and unconfigured checks stay local', async () => {
    const check = vi.fn()
    const service = createProviderHealthService({
      config: config(),
      transport: { check },
    })

    expect(service.read().deepSeek.checkStatus).toBe('notConfigured')
    await expect(service.check('deepseek')).resolves.toEqual(service.read())
    expect(check).not.toHaveBeenCalled()
  })

  test('single-flights checks and exposes only a sanitized result', async () => {
    let resolveCheck: (() => void) | undefined
    const check = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCheck = resolve
        }),
    )
    const service = createProviderHealthService({
      config: config({ deepSeek: 'secret-key' }),
      transport: { check },
      now: () => '2026-08-11T00:00:00.000Z',
    })

    const first = service.check('deepseek')
    const second = service.check('deepseek')
    expect(check).toHaveBeenCalledOnce()
    resolveCheck?.()
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(firstResult).toEqual(secondResult)
    expect(firstResult.deepSeek.checkStatus).toBe('available')
    expect(JSON.stringify(firstResult)).not.toContain('secret-key')
  })

  test('maps transport failures to HTTP-200-compatible public diagnostics', async () => {
    const logCheck = vi.fn(() => {
      throw new Error('logging failed')
    })
    const service = createProviderHealthService({
      config: config({ deepSeek: 'secret-key' }),
      transport: {
        check: async () => {
          throw new ProviderCheckFailure('rateLimited')
        },
      },
      now: () => '2026-08-11T00:00:00.000Z',
      logCheck,
    })

    const response = await service.check('deepseek')
    expect(response.deepSeek).toMatchObject({
      configured: true,
      checkStatus: 'unavailable',
      errorCode: 'provider_rate_limited',
      canCreateSession: true,
    })
    expect(logCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'deepseek',
        errorCode: 'provider_rate_limited',
      }),
    )
    expect(JSON.stringify(logCheck.mock.calls)).not.toContain('secret-key')
  })

  test.each([
    ['auth', 'provider_auth_error'],
    ['billing', 'provider_billing_unavailable'],
    ['network', 'provider_network_error'],
    ['timeout', 'provider_timeout'],
    ['rateLimited', 'provider_rate_limited'],
    ['serviceUnavailable', 'provider_service_unavailable'],
    ['unknown', 'provider_unknown_error'],
  ] as const)('publishes %s as %s', async (kind, errorCode) => {
    const service = createProviderHealthService({
      config: config({ deepSeek: 'secret-key' }),
      transport: {
        check: async () => {
          throw new ProviderCheckFailure(kind)
        },
      },
      now: () => '2026-08-11T00:00:00.000Z',
    })

    await expect(service.check('deepseek')).resolves.toMatchObject({
      deepSeek: {
        checkStatus: 'unavailable',
        errorCode,
      },
    })
  })

  test('resets configured provider diagnostics when the service is recreated', async () => {
    const input = {
      config: config({ deepSeek: 'secret-key' }),
      transport: { check: async () => undefined },
      now: () => '2026-08-11T00:00:00.000Z',
    }
    const firstProcess = createProviderHealthService(input)
    await expect(firstProcess.check('deepseek')).resolves.toMatchObject({
      deepSeek: { checkStatus: 'available' },
    })

    const restartedProcess = createProviderHealthService(input)
    expect(restartedProcess.read().deepSeek).toMatchObject({
      configured: true,
      checkStatus: 'notChecked',
      lastCheckedAt: null,
      errorCode: null,
    })
  })
})
