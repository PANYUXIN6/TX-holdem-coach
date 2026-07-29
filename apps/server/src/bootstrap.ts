import { serve } from '@hono/node-server'
import { app } from './app.js'
import {
  loadServerConfig,
  ServerConfigurationError,
  type ServerConfig,
} from './config.js'
import { initializeDatabase, StartupError } from './startup.js'

export interface BootstrapDependencies {
  readonly environment?: NodeJS.ProcessEnv
  readonly loadConfig?: typeof loadServerConfig
  readonly initializeDatabase?: typeof initializeDatabase
  readonly listen?: (config: ServerConfig) => void
  readonly logError?: (message: string) => void
  readonly setExitCode?: (value: number) => void
}

function listen(config: ServerConfig): void {
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
    await initialize(config)
    startListening(config)
  } catch (error) {
    if (
      error instanceof ServerConfigurationError ||
      error instanceof StartupError
    ) {
      logError(error.message)
      setExitCode(1)
      return
    }

    throw error
  }
}
