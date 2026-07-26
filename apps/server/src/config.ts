import { z } from 'zod'

const DEFAULT_PORT = 8787
const DEFAULT_DATABASE_PATH = 'data/poker-practice.sqlite'

const optionalApiKeySchema = z
  .string()
  .trim()
  .transform((value) => value || undefined)
  .optional()

const environmentSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(DEFAULT_PORT),
  DATABASE_PATH: z.string().trim().min(1).default(DEFAULT_DATABASE_PATH),
  DEEPSEEK_API_KEY: optionalApiKeySchema,
  KIMI_API_KEY: optionalApiKeySchema,
})

interface ServerConfigValues {
  readonly port: number
  readonly databasePath: string
  readonly deepSeekApiKey?: string
  readonly kimiApiKey?: string
}

export class ServerConfig {
  public readonly port: number
  public readonly databasePath: string
  readonly #deepSeekApiKey: string | undefined
  readonly #kimiApiKey: string | undefined

  public constructor(values: ServerConfigValues) {
    this.port = values.port
    this.databasePath = values.databasePath
    this.#deepSeekApiKey = values.deepSeekApiKey
    this.#kimiApiKey = values.kimiApiKey
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

export class ServerConfigurationError extends Error {
  public constructor() {
    super('服务配置无效，请检查后端 .env 文件。')
    this.name = 'ServerConfigurationError'
  }
}

export function loadServerConfig(environment: NodeJS.ProcessEnv): ServerConfig {
  const result = environmentSchema.safeParse({
    PORT: environment.PORT,
    DATABASE_PATH: environment.DATABASE_PATH,
    DEEPSEEK_API_KEY: environment.DEEPSEEK_API_KEY,
    KIMI_API_KEY: environment.KIMI_API_KEY,
  })

  if (!result.success) {
    throw new ServerConfigurationError()
  }

  const {
    PORT: port,
    DATABASE_PATH: databasePath,
    DEEPSEEK_API_KEY: deepSeekApiKey,
    KIMI_API_KEY: kimiApiKey,
  } = result.data

  return new ServerConfig({
    port,
    databasePath,
    ...(deepSeekApiKey === undefined ? {} : { deepSeekApiKey }),
    ...(kimiApiKey === undefined ? {} : { kimiApiKey }),
  })
}

export function getServerCapabilities(
  config: ServerConfig,
): ServerCapabilities {
  const canCreateSession = config.hasDeepSeekApiKey()

  return {
    canUseReadOnlyFeatures: true,
    canCreateSession,
    warnings: [
      ...(canCreateSession ? [] : ['DeepSeek API Key 未配置，无法创建场次。']),
      ...(config.hasKimiApiKey()
        ? []
        : ['Kimi API Key 未配置，自动降级不可用。']),
    ],
  }
}
