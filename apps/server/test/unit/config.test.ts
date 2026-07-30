import { describe, expect, test } from 'vitest'
import {
  getServerCapabilities,
  getProviderSettingsResponse,
  loadServerConfig,
  ServerConfigurationError,
} from '../../src/config.js'

const databaseUrl =
  'postgresql://postgres.abcdefghijklmnopqrst:database-secret@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres'

function createEnvironment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: databaseUrl,
    ...overrides,
  }
}

describe('server configuration', () => {
  test('keeps read-only features available when both provider keys are missing', () => {
    const config = loadServerConfig(createEnvironment())

    expect(getServerCapabilities(config)).toStrictEqual({
      canUseReadOnlyFeatures: true,
      canCreateSession: false,
      warnings: [
        'DeepSeek API Key 未配置，无法创建场次。',
        'Kimi API Key 未配置，自动降级不可用。',
      ],
    })
    expect(getProviderSettingsResponse(config)).toStrictEqual({
      protocolVersion: 1,
      deepSeek: {
        configured: false,
        checkStatus: 'notConfigured',
        lastCheckedAt: null,
        errorCode: null,
        canCreateSession: false,
      },
      kimi: {
        configured: false,
        checkStatus: 'notConfigured',
        lastCheckedAt: null,
        errorCode: null,
        canFallback: false,
      },
    })
  })

  test('treats blank provider keys as missing', () => {
    const config = loadServerConfig(
      createEnvironment({
        DEEPSEEK_API_KEY: '   ',
        KIMI_API_KEY: '',
      }),
    )

    expect(getServerCapabilities(config)).toStrictEqual({
      canUseReadOnlyFeatures: true,
      canCreateSession: false,
      warnings: [
        'DeepSeek API Key 未配置，无法创建场次。',
        'Kimi API Key 未配置，自动降级不可用。',
      ],
    })
    expect(getProviderSettingsResponse(config)).toStrictEqual(
      getProviderSettingsResponse(loadServerConfig(createEnvironment())),
    )
  })

  test('blocks session creation when the DeepSeek key is missing', () => {
    const config = loadServerConfig(
      createEnvironment({
        KIMI_API_KEY: 'kimi-test-key',
      }),
    )

    expect(getServerCapabilities(config)).toStrictEqual({
      canUseReadOnlyFeatures: true,
      canCreateSession: false,
      warnings: ['DeepSeek API Key 未配置，无法创建场次。'],
    })
    expect(getProviderSettingsResponse(config)).toStrictEqual({
      protocolVersion: 1,
      deepSeek: {
        configured: false,
        checkStatus: 'notConfigured',
        lastCheckedAt: null,
        errorCode: null,
        canCreateSession: false,
      },
      kimi: {
        configured: true,
        checkStatus: 'notChecked',
        lastCheckedAt: null,
        errorCode: null,
        canFallback: true,
      },
    })
  })

  test('allows session creation and reports unavailable fallback when the Kimi key is missing', () => {
    const config = loadServerConfig(
      createEnvironment({
        DEEPSEEK_API_KEY: 'deepseek-test-key',
      }),
    )

    expect(getServerCapabilities(config)).toStrictEqual({
      canUseReadOnlyFeatures: true,
      canCreateSession: true,
      warnings: ['Kimi API Key 未配置，自动降级不可用。'],
    })
    expect(getProviderSettingsResponse(config)).toStrictEqual({
      protocolVersion: 1,
      deepSeek: {
        configured: true,
        checkStatus: 'notChecked',
        lastCheckedAt: null,
        errorCode: null,
        canCreateSession: true,
      },
      kimi: {
        configured: false,
        checkStatus: 'notConfigured',
        lastCheckedAt: null,
        errorCode: null,
        canFallback: false,
      },
    })
  })

  test('returns a key-free public projection for a valid configuration', () => {
    const marker = 'must-not-appear-in-public-config'
    const markedDatabaseUrl =
      'postgresql://postgres.abcdefghijklmnopqrst:must-not-appear-in-public-config@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres'
    const config = loadServerConfig(
      createEnvironment({
        PORT: '8799',
        DATABASE_URL: markedDatabaseUrl,
        DEEPSEEK_API_KEY: marker,
        KIMI_API_KEY: marker,
      }),
    )

    expect(config.port).toBe(8799)
    expect(config.getDatabaseUrl()).toBe(markedDatabaseUrl)
    expect('databasePath' in config).toBe(false)
    expect(getServerCapabilities(config)).toStrictEqual({
      canUseReadOnlyFeatures: true,
      canCreateSession: true,
      warnings: [],
    })
    expect(getProviderSettingsResponse(config)).toStrictEqual({
      protocolVersion: 1,
      deepSeek: {
        configured: true,
        checkStatus: 'notChecked',
        lastCheckedAt: null,
        errorCode: null,
        canCreateSession: true,
      },
      kimi: {
        configured: true,
        checkStatus: 'notChecked',
        lastCheckedAt: null,
        errorCode: null,
        canFallback: true,
      },
    })
    expect(getServerCapabilities(config).canCreateSession).toBe(
      getProviderSettingsResponse(config).deepSeek.canCreateSession,
    )
    expect(JSON.stringify(config)).not.toContain(marker)
    expect(JSON.stringify(getServerCapabilities(config))).not.toContain(marker)
    expect(JSON.stringify(getProviderSettingsResponse(config))).not.toContain(
      marker,
    )
  })

  test.each([['postgresql'], ['postgres']])(
    'accepts the %s scheme',
    (scheme) => {
      const value = databaseUrl.replace('postgresql:', `${scheme}:`)

      expect(
        loadServerConfig(
          createEnvironment({ DATABASE_URL: value }),
        ).getDatabaseUrl(),
      ).toBe(value)
    },
  )

  test.each([
    ['missing DATABASE_URL', undefined],
    ['blank DATABASE_URL', '   '],
    ['non-PostgreSQL scheme', 'sqlite:///data/poker-practice.sqlite'],
    [
      'non-Supabase host',
      'postgresql://postgres.abcdefghijklmnopqrst:secret@db.example.com:6543/postgres',
    ],
    [
      'session pooler port',
      'postgresql://postgres.abcdefghijklmnopqrst:secret@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres',
    ],
    [
      'missing username',
      'postgresql://:secret@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres',
    ],
    [
      'missing password',
      'postgresql://postgres.abcdefghijklmnopqrst@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres',
    ],
    [
      'missing database name',
      'postgresql://postgres.abcdefghijklmnopqrst:secret@aws-0-ap-northeast-1.pooler.supabase.com:6543',
    ],
    [
      'password placeholder',
      'postgresql://postgres.abcdefghijklmnopqrst:[YOUR-PASSWORD]@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres',
    ],
    [
      'invalid password encoding',
      'postgresql://postgres.abcdefghijklmnopqrst:%ZZ@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres',
    ],
  ])('rejects %s', (_caseName, value) => {
    expect(() =>
      loadServerConfig(createEnvironment({ DATABASE_URL: value })),
    ).toThrow(ServerConfigurationError)
  })

  test.each([{ PORT: '0' }, { PORT: 'not-a-port' }])(
    'rejects invalid configuration without exposing secrets',
    (environment) => {
      const marker = 'must-not-appear-in-errors'
      const markedDatabaseUrl =
        'postgresql://postgres.abcdefghijklmnopqrst:must-not-appear-in-errors@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres'
      const invalidEnvironment = createEnvironment({
        ...environment,
        DATABASE_URL: markedDatabaseUrl,
        DEEPSEEK_API_KEY: marker,
        KIMI_API_KEY: marker,
      })

      expect(() => loadServerConfig(invalidEnvironment)).toThrow(
        ServerConfigurationError,
      )

      try {
        loadServerConfig(invalidEnvironment)
      } catch (error) {
        expect(error).toBeInstanceOf(ServerConfigurationError)
        expect(String(error)).toBe(
          'ServerConfigurationError: 服务配置无效，请检查后端 .env 文件。',
        )
        expect(JSON.stringify(error)).not.toContain(marker)
        expect(JSON.stringify(error)).not.toContain(markedDatabaseUrl)
      }
    },
  )
})
