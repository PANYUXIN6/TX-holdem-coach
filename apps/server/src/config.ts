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
})

interface ServerConfigValues {
  readonly port: number
  readonly databaseUrl: string
  readonly deepSeekApiKey?: string
}

export class ServerConfig {
  public readonly port: number
  readonly #databaseUrl: string
  readonly #deepSeekApiKey: string | undefined

  public constructor(values: ServerConfigValues) {
    this.port = values.port
    this.#databaseUrl = values.databaseUrl
    this.#deepSeekApiKey = values.deepSeekApiKey
  }

  public getDatabaseUrl(): string {
    return this.#databaseUrl
  }

  public hasDeepSeekApiKey(): boolean {
    return this.#deepSeekApiKey !== undefined
  }

  public getDeepSeekApiKey(): string | undefined {
    return this.#deepSeekApiKey
  }
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
  })

  if (!result.success) {
    throw new ServerConfigurationError()
  }

  const {
    PORT: port,
    DATABASE_URL: databaseUrl,
    DEEPSEEK_API_KEY: deepSeekApiKey,
  } = result.data

  return new ServerConfig({
    port,
    databaseUrl,
    ...(deepSeekApiKey === undefined ? {} : { deepSeekApiKey }),
  })
}

export function getProviderCreationPolicy(config: ServerConfig): {
  readonly deepSeekConfigured: boolean
} {
  return Object.freeze({
    deepSeekConfigured: config.hasDeepSeekApiKey(),
  })
}

export function getProviderSettingsResponse(
  config: ServerConfig,
): ProviderSettingsResponse {
  const deepSeekConfigured = config.hasDeepSeekApiKey()

  return ProviderSettingsResponseSchema.parse({
    deepSeek: {
      ...createInitialProviderHealthSummary(deepSeekConfigured),
      canCreateSession: deepSeekConfigured,
    },
  })
}
