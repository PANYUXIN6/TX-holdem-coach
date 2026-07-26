import { describe, expect, test } from 'vitest'
import {
  getServerCapabilities,
  loadServerConfig,
  ServerConfigurationError,
} from '../../src/config.js'

describe('server configuration', () => {
  test('keeps read-only features available when both provider keys are missing', () => {
    const config = loadServerConfig({})

    expect(getServerCapabilities(config)).toStrictEqual({
      canUseReadOnlyFeatures: true,
      canCreateSession: false,
      warnings: [
        'DeepSeek API Key 未配置，无法创建场次。',
        'Kimi API Key 未配置，自动降级不可用。',
      ],
    })
  })

  test('treats blank provider keys as missing', () => {
    const config = loadServerConfig({
      DEEPSEEK_API_KEY: '   ',
      KIMI_API_KEY: '',
    })

    expect(getServerCapabilities(config)).toStrictEqual({
      canUseReadOnlyFeatures: true,
      canCreateSession: false,
      warnings: [
        'DeepSeek API Key 未配置，无法创建场次。',
        'Kimi API Key 未配置，自动降级不可用。',
      ],
    })
  })

  test('blocks session creation when the DeepSeek key is missing', () => {
    const config = loadServerConfig({
      KIMI_API_KEY: 'kimi-test-key',
    })

    expect(getServerCapabilities(config)).toStrictEqual({
      canUseReadOnlyFeatures: true,
      canCreateSession: false,
      warnings: ['DeepSeek API Key 未配置，无法创建场次。'],
    })
  })

  test('allows session creation and reports unavailable fallback when the Kimi key is missing', () => {
    const config = loadServerConfig({
      DEEPSEEK_API_KEY: 'deepseek-test-key',
    })

    expect(getServerCapabilities(config)).toStrictEqual({
      canUseReadOnlyFeatures: true,
      canCreateSession: true,
      warnings: ['Kimi API Key 未配置，自动降级不可用。'],
    })
  })

  test('returns a key-free public projection for a valid configuration', () => {
    const marker = 'must-not-appear-in-public-config'
    const config = loadServerConfig({
      PORT: '8799',
      DATABASE_PATH: 'data/test.sqlite',
      DEEPSEEK_API_KEY: marker,
      KIMI_API_KEY: marker,
    })

    expect(config.port).toBe(8799)
    expect(config.databasePath).toBe('data/test.sqlite')
    expect(getServerCapabilities(config)).toStrictEqual({
      canUseReadOnlyFeatures: true,
      canCreateSession: true,
      warnings: [],
    })
    expect(JSON.stringify(config)).not.toContain(marker)
    expect(JSON.stringify(getServerCapabilities(config))).not.toContain(marker)
  })

  test.each([{ PORT: '0' }, { PORT: 'not-a-port' }, { DATABASE_PATH: '   ' }])(
    'rejects invalid configuration without exposing provider keys',
    (environment) => {
      const marker = 'must-not-appear-in-errors'

      expect(() =>
        loadServerConfig({
          ...environment,
          DEEPSEEK_API_KEY: marker,
          KIMI_API_KEY: marker,
        }),
      ).toThrow(ServerConfigurationError)

      try {
        loadServerConfig({
          ...environment,
          DEEPSEEK_API_KEY: marker,
          KIMI_API_KEY: marker,
        })
      } catch (error) {
        expect(error).toBeInstanceOf(ServerConfigurationError)
        expect(String(error)).toBe(
          'ServerConfigurationError: 服务配置无效，请检查后端 .env 文件。',
        )
        expect(JSON.stringify(error)).not.toContain(marker)
      }
    },
  )
})
