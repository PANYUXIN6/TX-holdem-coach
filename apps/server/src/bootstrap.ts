import { serve } from '@hono/node-server'
import { createApp, type ApiRuntime } from './app.js'
import {
  loadServerConfig,
  ServerConfigurationError,
  type ServerConfig,
} from './config.js'
import { initializeDatabase, StartupError } from './startup.js'
import type { DatabaseClient } from './db/client.js'
import {
  loadAndValidatePersonaCatalog,
  PersonaCatalogValidationError,
  type PersonaCatalog,
} from './personas/catalog.js'
import { resolveOwnerScope } from './persistence/owner-scope.js'
import { createProviderCheckTransport } from './providers/provider-check-transport.js'
import { createProviderHealthService } from './providers/provider-health-service.js'
import { createHealthService } from './http/health-service.js'
import { createPlayerAgentSettingsService } from './settings/player-agent-settings-service.js'
import { createSessionDataDeletionService } from './sessions/session-data-deletion-service.js'

function createLocalWebOrigins(port: number): ReadonlySet<string> {
  return new Set([
    'http://127.0.0.1:5173',
    'http://localhost:5173',
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ])
}

export async function createApiRuntime(
  config: ServerConfig,
  personaCatalog: PersonaCatalog,
  database: DatabaseClient,
): Promise<ApiRuntime> {
  let owner: Awaited<ReturnType<typeof resolveOwnerScope>>
  try {
    owner = await resolveOwnerScope(database.sql, { ownerId: 'local-user' })
  } catch {
    throw new StartupError('databaseConnectionFailed')
  }
  return Object.freeze({
    health: createHealthService(database.sql),
    providerHealth: createProviderHealthService({
      config,
      transport: createProviderCheckTransport(),
      logCheck: (entry) => console.info(JSON.stringify(entry)),
    }),
    playerAgentSettings: createPlayerAgentSettingsService({
      sql: database.sql,
      owner,
    }),
    personaCatalog,
    deletion: createSessionDataDeletionService({ sql: database.sql, owner }),
  })
}

export interface BootstrapDependencies {
  readonly environment?: NodeJS.ProcessEnv
  readonly loadConfig?: typeof loadServerConfig
  readonly loadPersonaCatalog?: typeof loadAndValidatePersonaCatalog
  readonly initializeDatabase?: typeof initializeDatabase
  readonly createRuntime?: typeof createApiRuntime
  readonly listen?: (
    config: ServerConfig,
    app: ReturnType<typeof createApp>,
  ) => void
  readonly logError?: (message: string) => void
  readonly setExitCode?: (value: number) => void
}

function listen(config: ServerConfig, app: ReturnType<typeof createApp>): void {
  serve({
    fetch: app.fetch,
    hostname: '127.0.0.1',
    port: config.port,
  })
}

export async function bootstrap(
  dependencies: BootstrapDependencies = {},
): Promise<void> {
  const environment = dependencies.environment ?? process.env
  const loadConfig = dependencies.loadConfig ?? loadServerConfig
  const loadPersonaCatalog =
    dependencies.loadPersonaCatalog ?? loadAndValidatePersonaCatalog
  const initialize = dependencies.initializeDatabase ?? initializeDatabase
  const createRuntime = dependencies.createRuntime ?? createApiRuntime
  const startListening = dependencies.listen ?? listen
  const logError = dependencies.logError ?? console.error
  const setExitCode =
    dependencies.setExitCode ??
    ((value) => {
      process.exitCode = value
    })

  let database: DatabaseClient | undefined
  let listening = false
  try {
    const config = loadConfig(environment)
    const personaCatalog = loadPersonaCatalog()
    database = await initialize(config)
    const runtime = await createRuntime(config, personaCatalog, database)
    const app = createApp(runtime, {
      port: config.port,
      allowedOrigins: createLocalWebOrigins(config.port),
      logRequest: (entry) => console.info(JSON.stringify(entry)),
    })
    startListening(config, app)
    listening = true
  } catch (error) {
    if (database !== undefined && !listening) {
      try {
        await database.close()
      } catch {
        // Preserve the original sanitized startup or composition failure.
      }
    }
    if (
      error instanceof ServerConfigurationError ||
      error instanceof PersonaCatalogValidationError ||
      error instanceof StartupError
    ) {
      logError(error.message)
      setExitCode(1)
      return
    }

    throw error
  }
}
