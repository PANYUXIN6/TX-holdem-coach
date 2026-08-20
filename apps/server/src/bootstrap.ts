import { randomUUID } from 'node:crypto'
import { serve } from '@hono/node-server'
import { createApp, type ApiRuntime } from './http/create-app.js'
import {
  loadServerConfig,
  ServerConfigurationError,
  type ServerConfig,
  getProviderCreationPolicy,
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
import { createSessionCreationRepository } from './persistence/session-creation-repository.js'
import { productionSessionMutationRepository } from './persistence/session-mutation-repository.js'
import { productionSessionRecoveryRepository } from './persistence/session-recovery-repository.js'
import { insertInProgressHandAudit } from './persistence/hand-audit-repository.js'
import { createPublicProjectionFactsRepository } from './persistence/public-projection-repository.js'
import { SECURE_RANDOM_SOURCE } from './poker/random-source.js'
import { createSessionCreationIdentityGraph } from './sessions/session-creation/session-creation-consistency.js'
import { createSessionCreationService } from './sessions/session-creation/session-creation-service.js'
import { createSessionCommandHandlerMap } from './sessions/command-execution/command-handler-map.js'
import { createPlayerActionHandlerBinding } from './sessions/command-execution/player-action-handler.js'
import { createRebuyHandlerBinding } from './sessions/command-execution/rebuy-handler.js'
import { createStartNextHandHandlerBinding } from './sessions/command-execution/start-next-hand-handler.js'
import { createEndSessionHandlerBinding } from './sessions/command-execution/end-session-handler.js'
import { createSessionCommandExecutor } from './sessions/command-execution/session-command-executor.js'
import { createCommittedSessionEventHub } from './sessions/public-projection/committed-session-event-hub.js'
import { createPublicSessionBindings } from './sessions/public-projection/public-session-bindings.js'
import { createPublicSessionQueryService } from './sessions/public-projection/public-session-query-service.js'
import { createPublicEventReplayRepository } from './persistence/public-event-replay-repository.js'
import { createSessionEventStreamService } from './sessions/public-projection/session-event-stream-service.js'

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
  const committedSessionEvents = createCommittedSessionEventHub({
    onListenerError: () =>
      console.error(JSON.stringify({ category: 'sse_listener_failed' })),
  })
  const projectionBindings = createPublicSessionBindings(owner)
  const mutationRepository = productionSessionMutationRepository
  const recoveryRepository = productionSessionRecoveryRepository
  const creationRepository = createSessionCreationRepository()
  const logPublishFailure = (entry: {
    readonly eventCount: number
    readonly firstEventSeq: number
    readonly lastEventSeq: number
  }) =>
    console.error(
      JSON.stringify({ category: 'committed_event_publish_failed', ...entry }),
    )
  const creation = createSessionCreationService({
    sql: database.sql,
    owner,
    catalog: personaCatalog,
    readProviderPolicy: () => getProviderCreationPolicy(config),
    createIdentityGraph: (seatNumbers) =>
      createSessionCreationIdentityGraph(seatNumbers),
    randomSource: SECURE_RANDOM_SOURCE,
    now: () => new Date().toISOString(),
    creationRepository,
    mutationRepository,
    handAuditWriter: {
      insertInProgress: (transaction, scopedOwner, input) =>
        insertInProgressHandAudit(transaction, scopedOwner, input),
    },
    snapshotProjectorBinding: projectionBindings.creation,
    activeSessionSnapshotReaderBinding: projectionBindings.activeReader,
    committedEventPublisher: committedSessionEvents,
    logPublishFailure,
  })
  const handlers = createSessionCommandHandlerMap({
    bindings: [
      createPlayerActionHandlerBinding({ owner }),
      createRebuyHandlerBinding(),
      createStartNextHandHandlerBinding({
        owner,
        nextHandId: randomUUID,
        randomSource: SECURE_RANDOM_SOURCE,
      }),
      createEndSessionHandlerBinding({ owner }),
    ],
  })
  const commands = createSessionCommandExecutor({
    sql: database.sql,
    owner,
    handlers,
    mutationRepository,
    recoveryRepository,
    snapshotProjectorBinding: projectionBindings.command,
    now: () => new Date().toISOString(),
    nextEventId: randomUUID,
    committedEventPublisher: committedSessionEvents,
    logPublishFailure,
  })
  const query = createPublicSessionQueryService(
    createPublicProjectionFactsRepository({ sql: database.sql, owner }),
  )
  const sessionEvents = createSessionEventStreamService({
    repository: createPublicEventReplayRepository({ sql: database.sql, owner }),
    hub: committedSessionEvents,
    nextEventId: randomUUID,
    diagnose: (entry) => console.error(JSON.stringify(entry)),
  })
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
    sessionHttp: { creation, query, commands },
    sessionEvents,
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
