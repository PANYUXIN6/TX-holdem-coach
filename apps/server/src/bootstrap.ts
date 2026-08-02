import { serve } from '@hono/node-server'
import { app } from './app.js'
import {
  loadServerConfig,
  ServerConfigurationError,
  type ServerConfig,
} from './config.js'
import { initializeDatabase, StartupError } from './startup.js'
import {
  loadAndValidatePersonaCatalog,
  PersonaCatalogValidationError,
  type PersonaCatalog,
} from './personas/catalog.js'

export interface BootstrapDependencies {
  readonly environment?: NodeJS.ProcessEnv
  readonly loadConfig?: typeof loadServerConfig
  readonly loadPersonaCatalog?: typeof loadAndValidatePersonaCatalog
  readonly initializeDatabase?: typeof initializeDatabase
  readonly listen?: (
    config: ServerConfig,
    personaCatalog: PersonaCatalog,
  ) => void
  readonly logError?: (message: string) => void
  readonly setExitCode?: (value: number) => void
}

function listen(config: ServerConfig, _personaCatalog: PersonaCatalog): void {
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
  const startListening = dependencies.listen ?? listen
  const logError = dependencies.logError ?? console.error
  const setExitCode =
    dependencies.setExitCode ??
    ((value) => {
      process.exitCode = value
    })

  try {
    const config = loadConfig(environment)
    const personaCatalog = loadPersonaCatalog()
    await initialize(config)
    startListening(config, personaCatalog)
  } catch (error) {
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
