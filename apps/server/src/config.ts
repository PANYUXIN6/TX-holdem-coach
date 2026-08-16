import { ProviderSettingsResponseSchema } from '@tx-holdem-coach/contracts'
import type { ProviderSettingsResponse } from '@tx-holdem-coach/contracts'
import { z } from 'zod'
import { parseSupabaseDatabaseUrl } from './db/database-url-policy.js'

const DEFAULT_PORT = 8787

const optionalApiKeySchema = z
  .string()
  .trim()
  .transform((value) => value || undefined)
  .optional()

const databaseUrlSchema = z
  .string()
  .trim()
  .min(1)
  .superRefine((value, context) => {
    try {
      parseSupabaseDatabaseUrl(value, 'runtime')
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'Invalid Supabase transaction pooler URL.',
      })
    }
  })

const environmentSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(DEFAULT_PORT),
  DATABASE_URL: databaseUrlSchema,
  DEEPSEEK_API_KEY: optionalApiKeySchema,
  KIMI_API_KEY: optionalApiKeySchema,
})

interface ServerConfigValues {
  readonly port: number
  readonly databaseUrl: string
  readonly deepSeekApiKey?: string
  readonly kimiApiKey?: string
}

export class ServerConfig {
  public readonly port: number
  readonly #databaseUrl: string
  readonly #deepSeekApiKey: string | undefined
  readonly #kimiApiKey: string | undefined

  public constructor(values: ServerConfigValues) {
    this.port = values.port
    this.#databaseUrl = values.databaseUrl
    this.#deepSeekApiKey = values.deepSeekApiKey
    this.#kimiApiKey = values.kimiApiKey
  }

  public getDatabaseUrl(): string {
    return this.#databaseUrl
  }

  public hasDeepSeekApiKey(): boolean {
    return this.#deepSeekApiKey !== undefined
  }

  public hasKimiApiKey(): boolean {
    return this.#kimiApiKey !== undefined
  }

  public getDeepSeekApiKey(): string | undefined {
    return this.#deepSeekApiKey
  }

  public getKimiApiKey(): string | undefined {
    return this.#kimiApiKey
  }
}

export interface ServerCapabilities {
  readonly canUseReadOnlyFeatures: true
  readonly canCreateSession: boolean
  readonly warnings: readonly string[]
}

function createInitialProviderHealthSummary(configured: boolean) {
  return configured
    ? {
        configured: true,
        checkStatus: 'notChecked' as const,
        lastCheckedAt: null,
        errorCode: null,
      }
    : {
        configured: false,
        checkStatus: 'notConfigured' as const,
        lastCheckedAt: null,
        errorCode: null,
      }
}

export class ServerConfigurationError extends Error {
  public constructor() {
    super('服务配置无效，请检查后端 .env 文件。')
    this.name = 'ServerConfigurationError'
  }
}

export function loadServerConfig(environment: NodeJS.ProcessEnv): ServerConfig {
  const result = environmentSchema.safeParse({
    PORT: environment.PORT,
    DATABASE_URL: environment.DATABASE_URL,
    DEEPSEEK_API_KEY: environment.DEEPSEEK_API_KEY,
    KIMI_API_KEY: environment.KIMI_API_KEY,
  })

  if (!result.success) {
    throw new ServerConfigurationError()
  }

  const {
    PORT: port,
    DATABASE_URL: databaseUrl,
    DEEPSEEK_API_KEY: deepSeekApiKey,
    KIMI_API_KEY: kimiApiKey,
  } = result.data

  return new ServerConfig({
    port,
    databaseUrl,
    ...(deepSeekApiKey === undefined ? {} : { deepSeekApiKey }),
    ...(kimiApiKey === undefined ? {} : { kimiApiKey }),
  })
}

export function getServerCapabilities(
  config: ServerConfig,
): ServerCapabilities {
  const providerSettings = getProviderSettingsResponse(config)
  const canCreateSession = providerSettings.deepSeek.canCreateSession

  return {
    canUseReadOnlyFeatures: true,
    canCreateSession,
    warnings: [
      ...(canCreateSession ? [] : ['DeepSeek API Key 未配置，无法创建场次。']),
      ...(providerSettings.kimi.canFallback
        ? []
        : ['Kimi API Key 未配置，自动降级不可用。']),
    ],
  }
}

export function getProviderCreationPolicy(config: ServerConfig): {
  readonly deepSeekConfigured: boolean
  readonly kimiConfigured: boolean
} {
  return Object.freeze({
    deepSeekConfigured: config.hasDeepSeekApiKey(),
    kimiConfigured: config.hasKimiApiKey(),
  })
}

export function getProviderSettingsResponse(
  config: ServerConfig,
): ProviderSettingsResponse {
  const deepSeekConfigured = config.hasDeepSeekApiKey()
  const kimiConfigured = config.hasKimiApiKey()

  return ProviderSettingsResponseSchema.parse({
    deepSeek: {
      ...createInitialProviderHealthSummary(deepSeekConfigured),
      canCreateSession: deepSeekConfigured,
    },
    kimi: {
      ...createInitialProviderHealthSummary(kimiConfigured),
      canFallback: kimiConfigured,
    },
  })
}
