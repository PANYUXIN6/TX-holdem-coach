import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
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
import {
  createPlayerCommitSessionComposition,
  createSessionCommandExecutor,
} from './sessions/command-execution/session-command-executor.js'
import { createCommittedSessionEventHub } from './sessions/public-projection/committed-session-event-hub.js'
import { createPublicSessionBindings } from './sessions/public-projection/public-session-bindings.js'
import { createPublicSessionQueryService } from './sessions/public-projection/public-session-query-service.js'
import { createPublicEventReplayRepository } from './persistence/public-event-replay-repository.js'
import { createSessionEventStreamService } from './sessions/public-projection/session-event-stream-service.js'
import { createAgentRunCoordinator } from './agents/foundation/agent-run-coordinator.js'
import {
  createAgentWorker,
  type AgentWorker,
} from './agents/foundation/agent-worker.js'
import { createCapabilityExecutor } from './agents/foundation/capability-executor.js'
import { createModelGateway } from './agents/foundation/model-gateway.js'
import type { ModelProviderAdapter } from './agents/foundation/model-gateway-protocol.js'
import { createSensitiveValueScanner } from './agents/model-gateway/sensitive-value-scanner.js'
import { createDeepSeekModelAdapter } from './agents/model-gateway/deepseek-model-adapter.js'
import { deepSeekPricingPolicy } from './agents/model-gateway/model-pricing-policy.js'
import { productionRuntimeRegistry } from './agents/production-runtime-registry.js'
import { playerDecisionCapabilityDefinitions } from './agents/player/player-decision-capabilities.js'
import { playerRuntimeDefinition } from './agents/player/foundation-definition.js'
import { playerDecisionPreprocessingPlan } from './agents/player/player-decision-preprocessing-plan.js'
import { createPlayerRuntimeExecutor } from './agents/player/player-runtime-executor.js'
import { createPlayerExecutionSupervisor } from './agents/player/player-execution-supervisor.js'
import { createPlayerCommitResultPort } from './agents/player/player-commit-gate.js'
import { createSessionAgentCoordinator } from './agents/player/session-agent-coordinator.js'
import {
  createPlayerTurnDispatcher,
  type PlayerTurnDispatcherLifecycle,
} from './agents/player/player-turn-dispatcher.js'
import { playerModelRoutePolicy } from './agents/player/route-policy.js'
import { PlayerRuntimeConfigurationUnavailableError } from './agents/player/player-runtime-startup-mode.js'
import { createStaticStrategyPackRepository } from './poker-strategy/strategy-pack-repository.js'
import { createAgentFoundationAuditRepository } from './persistence/agent-foundation-audit-repository.js'
import { createPlayerDecisionRepository } from './persistence/player-decision-repository.js'
import { createPostgresPlayerDecisionReferencePort } from './persistence/player-decision-reference-authority.js'
import { createPostgresPlayerRunObservationPort } from './persistence/player-run-observation-port.js'
import { createDatabaseCapabilityExecutionControl } from './persistence/agent-capability-execution-control.js'
import { createPlayerModelAttemptControlV1 } from './persistence/player-model-attempt-control.js'
import { createStartupRecoveryCandidateRepository } from './persistence/startup-recovery-candidate-repository.js'
import {
  createServiceStartupRecovery,
  type ServiceStartupRecovery,
} from './sessions/startup-recovery/service-startup-recovery.js'

function createLocalWebOrigins(port: number): ReadonlySet<string> {
  return new Set([
    'http://127.0.0.1:5173',
    'http://localhost:5173',
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ])
}

export interface ConfiguredPlayerRuntime {
  readonly worker: AgentWorker
  readonly dispatcher: PlayerTurnDispatcherLifecycle
  readonly startupRecovery: ServiceStartupRecovery
  reconcileInitialTurns(): Promise<readonly string[]>
}

export type ApiRuntimeWithPlayerRuntime = ApiRuntime & {
  readonly playerRuntime?: ConfiguredPlayerRuntime
}

/** 仅供受控 E2E 注入确定性 Provider；默认生产组合始终创建 DeepSeek adapter。 */
export interface ApiRuntimeCompositionDependencies {
  readonly playerModelAdapter?: ModelProviderAdapter
}

export async function createApiRuntime(
  config: ServerConfig,
  personaCatalog: PersonaCatalog,
  database: DatabaseClient,
  dependencies: ApiRuntimeCompositionDependencies = {},
): Promise<ApiRuntimeWithPlayerRuntime> {
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
  let dispatcher: PlayerTurnDispatcherLifecycle | undefined
  const playerTurnHintPort = Object.freeze({
    notify(sessionId: string) {
      dispatcher?.notify(sessionId)
    },
  })
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
    playerTurnHintPort,
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
  const sessionDependencies = {
    sql: database.sql,
    owner,
    mutationRepository,
    recoveryRepository,
    snapshotProjectorBinding: projectionBindings.command,
    now: () => new Date().toISOString(),
    nextEventId: randomUUID,
    committedEventPublisher: committedSessionEvents,
    logPublishFailure,
    playerTurnHintPort,
  }
  let commands: ReturnType<typeof createSessionCommandExecutor>
  let playerRuntime: ConfiguredPlayerRuntime | undefined
  const candidateReader = createStartupRecoveryCandidateRepository({
    sql: database.sql,
    owner,
  })
  if (!config.hasDeepSeekApiKey()) {
    const activeSessionIds = await candidateReader.listActiveSessionIds()
    if (activeSessionIds.length !== 0) {
      throw new PlayerRuntimeConfigurationUnavailableError()
    }
    commands = createSessionCommandExecutor({
      ...sessionDependencies,
      handlers,
    })
  } else {
    const strategyPackRepository = createStaticStrategyPackRepository()
    const runEventPort = Object.freeze({
      async publish() {
        // AgentRun rows are durable; the Worker poll loop owns eventual discovery.
      },
    })
    const runCoordinator = createAgentRunCoordinator({
      sql: database.sql,
      owner,
      eventPort: runEventPort,
    })
    const playerCoordinator = createSessionAgentCoordinator({
      sql: database.sql,
      owner,
      registry: productionRuntimeRegistry,
      runCoordinator,
      strategyPackRepository,
      runEventPort,
      sessionEventPublisher: committedSessionEvents,
    })
    const sessionComposition = createPlayerCommitSessionComposition({
      session: sessionDependencies,
      player: { runEventPort },
    })
    commands = sessionComposition.commands
    const foundationRepository = createAgentFoundationAuditRepository()
    const decisionRepository = createPlayerDecisionRepository()
    const scanner = createSensitiveValueScanner({
      secrets: [config.getDatabaseUrl(), config.getDeepSeekApiKey()!],
    })
    const playerExecutor = createPlayerRuntimeExecutor({
      database,
      owner,
      registry: productionRuntimeRegistry,
      observationPortFactory: createPostgresPlayerRunObservationPort,
      referencePort: createPostgresPlayerDecisionReferencePort({ database }),
      strategyPackRepository,
      capabilityExecutor: createCapabilityExecutor({
        runtimeType: 'player',
        manifest: playerRuntimeDefinition.capabilityManifest,
        definitions: playerDecisionCapabilityDefinitions,
      }),
      capabilityControlFactory: ({ authority, run }) =>
        createDatabaseCapabilityExecutionControl({
          sql: database.sql,
          repository: foundationRepository,
          owner,
          authority,
          manifest: playerRuntimeDefinition.capabilityManifest,
          sessionId: run.sessionId,
          agentRunId: run.runId,
        }),
      preprocessingPlan: playerDecisionPreprocessingPlan,
      decisionRepository,
      scanner,
      modelGateway: createModelGateway({
        adapter:
          dependencies.playerModelAdapter ??
          createDeepSeekModelAdapter({
            apiKey: config.getDeepSeekApiKey()!,
            scanner,
          }),
        registry: productionRuntimeRegistry,
      }),
      routePolicy: playerModelRoutePolicy,
      pricingPolicy: deepSeekPricingPolicy,
      modelControlFactory: ({ authority, packet }) =>
        createPlayerModelAttemptControlV1({
          sql: database.sql,
          foundationRepository,
          decisionRepository,
          owner,
          authority,
          packet,
          correctionAttemptPort: playerCoordinator,
        }),
      resultPort: createPlayerCommitResultPort({
        gate: sessionComposition.playerCommitGate,
      }),
    })
    const worker = createAgentWorker({
      control: runCoordinator.workerControl,
      executors: {
        player: createPlayerExecutionSupervisor({
          executor: playerExecutor,
          coordinator: playerCoordinator,
        }),
      },
    })
    dispatcher = createPlayerTurnDispatcher({
      currentTurnCoordinator: playerCoordinator,
      candidateReader,
      worker,
    })
    playerRuntime = Object.freeze({
      worker,
      dispatcher,
      startupRecovery: createServiceStartupRecovery({
        candidateReader,
        sql: database.sql,
        owner,
        recoveryRepository,
        playerRestartRecovery: playerCoordinator,
        committedEventPublisher: committedSessionEvents,
      }),
      reconcileInitialTurns: async () =>
        dispatcher!.reconcileStartup(
          await candidateReader.listActiveSessionIds(),
        ),
    })
  }
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
    ...(playerRuntime === undefined ? {} : { playerRuntime }),
  })
}

export interface BootstrapDependencies {
  readonly environment?: NodeJS.ProcessEnv
  readonly signal?: AbortSignal
  readonly loadConfig?: typeof loadServerConfig
  readonly loadPersonaCatalog?: typeof loadAndValidatePersonaCatalog
  readonly initializeDatabase?: typeof initializeDatabase
  readonly createRuntime?: typeof createApiRuntime
  readonly listen?: (
    config: ServerConfig,
    app: ReturnType<typeof createApp>,
  ) => HttpServerHandle
}

export interface HttpServerFatal {
  readonly category: 'httpServerTerminatedUnexpectedly'
}

export interface HttpServerHandle {
  readonly bound: Promise<void>
  readonly fatal: Promise<HttpServerFatal>
  /** 停止接受新连接；既有 SSE/HTTP 请求由后续 drain 处理。 */
  beginClose(): void
  /** 等待既有连接自然结束。 */
  waitForClose(): Promise<void>
  /** 在有界 drain 超时后中断所有存活 HTTP 连接。 */
  forceClose(): void
}

export type ServiceRuntimeFatal =
  | HttpServerFatal
  | { readonly category: 'playerWorkerTerminatedUnexpectedly' }
  | { readonly category: 'playerTurnDispatcherTerminatedUnexpectedly' }

export interface RunningServiceHandle {
  readonly fatal: Promise<ServiceRuntimeFatal>
  shutdown(): Promise<void>
}

export type ServiceStartupFailure =
  | 'configurationFailed'
  | 'databaseFailed'
  | 'playerRuntimeConfigurationUnavailable'
  | 'startupRecoveryFailed'
  | 'workerStartFailed'
  | 'httpListenFailed'

export class ServiceStartupError extends Error {
  public constructor(public readonly failure: ServiceStartupFailure) {
    super('服务启动失败。')
    this.name = 'ServiceStartupError'
  }
}

export class ServiceStartupAborted extends Error {
  public constructor() {
    super('服务启动已取消。')
    this.name = 'ServiceStartupAborted'
  }
}

export class ServiceShutdownError extends Error {
  public constructor() {
    super('服务关闭未能完整完成。')
    this.name = 'ServiceShutdownError'
  }
}

const HTTP_BIND_TIMEOUT_MS = 10_000
const HTTP_DRAIN_TIMEOUT_MS = 10_000

type HttpDrainResult =
  | { readonly kind: 'closed' }
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'timedOut' }

async function drainHttpServer(server: HttpServerHandle): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const result = await Promise.race([
    server.waitForClose().then(
      (): HttpDrainResult => ({ kind: 'closed' }),
      (error: unknown): HttpDrainResult => ({ kind: 'failed', error }),
    ),
    new Promise<HttpDrainResult>((resolve) => {
      timeout = setTimeout(
        () => resolve({ kind: 'timedOut' }),
        HTTP_DRAIN_TIMEOUT_MS,
      )
    }),
  ])
  if (timeout !== undefined) clearTimeout(timeout)
  if (result.kind === 'failed') throw result.error
  if (result.kind === 'timedOut') server.forceClose()
}

function listen(
  config: ServerConfig,
  app: ReturnType<typeof createApp>,
): HttpServerHandle {
  let resolveBound!: () => void
  let rejectBound!: (error: unknown) => void
  const bound = new Promise<void>((resolve, reject) => {
    resolveBound = resolve
    rejectBound = reject
  })
  let resolveFatal!: (value: HttpServerFatal) => void
  const fatal = new Promise<HttpServerFatal>((resolve) => {
    resolveFatal = resolve
  })
  let closed = false
  let closePromise: Promise<void> | null = null
  let closeFailure: unknown
  let resolveClosed!: () => void
  const server = serve(
    {
      fetch: app.fetch,
      hostname: '127.0.0.1',
      port: config.port,
    },
    () => resolveBound(),
  ) as Server
  server.once('error', (error) => {
    if (!closed) {
      rejectBound(error)
      resolveFatal({ category: 'httpServerTerminatedUnexpectedly' })
    }
  })
  server.once('close', () => {
    if (!closed) resolveFatal({ category: 'httpServerTerminatedUnexpectedly' })
  })
  const beginClose = (): void => {
    if (closePromise !== null) return
    closed = true
    closePromise = new Promise<void>((resolve) => {
      resolveClosed = resolve
    })
    try {
      server.close((error) => {
        closeFailure = error
        resolveClosed()
      })
    } catch (error) {
      closeFailure = error
      resolveClosed()
    }
  }
  return Object.freeze({
    bound,
    fatal,
    beginClose,
    async waitForClose() {
      beginClose()
      await closePromise
      if (closeFailure !== undefined) throw closeFailure
    },
    forceClose() {
      server.closeAllConnections()
    },
  })
}

export async function bootstrap(
  dependencies: BootstrapDependencies = {},
): Promise<RunningServiceHandle> {
  const environment = dependencies.environment ?? process.env
  const signal = dependencies.signal ?? new AbortController().signal
  const loadConfig = dependencies.loadConfig ?? loadServerConfig
  const loadPersonaCatalog =
    dependencies.loadPersonaCatalog ?? loadAndValidatePersonaCatalog
  const initialize = dependencies.initializeDatabase ?? initializeDatabase
  const createRuntime = dependencies.createRuntime ?? createApiRuntime
  const startListening = dependencies.listen ?? listen

  let database: DatabaseClient | undefined
  let runtime: ApiRuntimeWithPlayerRuntime | undefined
  let server: HttpServerHandle | undefined
  let playerRuntimeStarted = false
  let shutdownPromise: Promise<void> | null = null
  const assertNotAborted = (): void => {
    if (signal.aborted) throw new ServiceStartupAborted()
  }
  const closeStartedResources = async (): Promise<void> => {
    const failures: unknown[] = []
    let httpDrain: Promise<void> | undefined
    if (server !== undefined) {
      try {
        server.beginClose()
        httpDrain = drainHttpServer(server)
      } catch (error) {
        failures.push(error)
      }
    }
    if (runtime?.playerRuntime !== undefined) {
      try {
        await runtime.playerRuntime.dispatcher.stop()
      } catch (error) {
        failures.push(error)
      }
      if (playerRuntimeStarted) {
        try {
          await runtime.playerRuntime.worker.stop()
        } catch (error) {
          failures.push(error)
        }
      }
    }
    if (httpDrain !== undefined) {
      try {
        await httpDrain
      } catch (error) {
        failures.push(error)
      }
    }
    if (database !== undefined) {
      try {
        await database.close()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length !== 0) throw new ServiceShutdownError()
  }
  try {
    assertNotAborted()
    const config = loadConfig(environment)
    assertNotAborted()
    const personaCatalog = loadPersonaCatalog()
    assertNotAborted()
    database = await initialize(config)
    assertNotAborted()
    runtime = await createRuntime(config, personaCatalog, database)
    assertNotAborted()
    if (runtime.playerRuntime !== undefined) {
      const restartEffects =
        await runtime.playerRuntime.startupRecovery.recoverAtStartup()
      assertNotAborted()
      const initialRunIds = await runtime.playerRuntime.reconcileInitialTurns()
      assertNotAborted()
      await runtime.playerRuntime.worker.start()
      playerRuntimeStarted = true
      const runIds = [
        ...new Set([...restartEffects.replacementRunIds, ...initialRunIds]),
      ].sort()
      if (runIds.length !== 0)
        runtime.playerRuntime.worker.wake('player', runIds)
      await runtime.playerRuntime.dispatcher.start()
    }
    assertNotAborted()
    const app = createApp(runtime, {
      port: config.port,
      allowedOrigins: createLocalWebOrigins(config.port),
      logRequest: (entry) => console.info(JSON.stringify(entry)),
    })
    server = startListening(config, app)
    let timeout: ReturnType<typeof setTimeout> | undefined
    let rejectAbort!: (reason: unknown) => void
    const abortWait = new Promise<never>((_, reject) => {
      rejectAbort = reject
    })
    const onAbort = (): void => rejectAbort(new ServiceStartupAborted())
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    const waits: Promise<unknown>[] = [server.bound, abortWait]
    if (runtime.playerRuntime !== undefined) {
      waits.push(
        runtime.playerRuntime.worker.fatal.then(() => {
          throw new ServiceStartupError('workerStartFailed')
        }),
        runtime.playerRuntime.dispatcher.fatal.then(() => {
          throw new ServiceStartupError('startupRecoveryFailed')
        }),
      )
    }
    const timeoutWait = new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new ServiceStartupError('httpListenFailed')),
        HTTP_BIND_TIMEOUT_MS,
      )
    })
    try {
      waits.push(timeoutWait)
      await Promise.race(waits)
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
    }
    assertNotAborted()
    const runningFatal = Promise.race([
      server.fatal,
      ...(runtime.playerRuntime === undefined
        ? []
        : [
            runtime.playerRuntime.worker.fatal,
            runtime.playerRuntime.dispatcher.fatal,
          ]),
    ]) as Promise<ServiceRuntimeFatal>
    const shutdown = async (): Promise<void> => {
      if (shutdownPromise !== null) return shutdownPromise
      shutdownPromise = closeStartedResources()
      return shutdownPromise
    }
    return Object.freeze({ fatal: runningFatal, shutdown })
  } catch (error) {
    try {
      await closeStartedResources()
    } catch {
      // The initial startup outcome remains authoritative.
    }
    if (error instanceof ServiceStartupAborted) throw error
    if (error instanceof PlayerRuntimeConfigurationUnavailableError) {
      throw new ServiceStartupError('playerRuntimeConfigurationUnavailable')
    }
    if (
      error instanceof ServerConfigurationError ||
      error instanceof PersonaCatalogValidationError
    ) {
      throw new ServiceStartupError('configurationFailed')
    }
    if (error instanceof StartupError)
      throw new ServiceStartupError('databaseFailed')
    throw error
  }
}
