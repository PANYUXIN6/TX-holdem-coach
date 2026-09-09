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
import { createCompletedHandHistoryFactsRepository } from './persistence/completed-hand-history-repository.js'
import { createCompletedHandHistoryListFactsRepository } from './persistence/completed-hand-history-list-repository.js'
import { createStatisticsFactsRepository } from './persistence/statistics-facts-repository.js'
import { createSessionManagementFactsRepository } from './persistence/session-management-query-repository.js'
import { createAgentCallQueryRepository } from './persistence/agent-call-query-repository.js'
import { SECURE_RANDOM_SOURCE } from './poker/random-source.js'
import type { RandomSource } from './poker/random-source.js'
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
import { createAuthoritativeCompletedHandHistoryReader } from './sessions/hand-history/completed-hand-history-service.js'
import { createCompletedHandHistoryQueryService } from './sessions/hand-history/completed-hand-history-query-service.js'
import { createCompletedHandHistoryListQueryService } from './sessions/hand-history/completed-hand-history-list-query-service.js'
import { createStatisticsQueryService } from './sessions/statistics/statistics-query-service.js'
import { createSessionManagementQueryService } from './sessions/data-management/session-management-query-service.js'
import { createAgentCallQueryService } from './agents/audit/agent-call-query-service.js'
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
import { createActiveSessionCandidateRepository } from './persistence/active-session-candidate-repository.js'
import {
  createServiceStartupRecovery,
  type ServiceStartupRecovery,
} from './sessions/startup-recovery/service-startup-recovery.js'
import {
  StartupRecoveryAborted,
  StartupRecoveryError,
} from './sessions/startup-recovery/errors.js'
import {
  consoleServiceLifecycleDiagnostic,
  type ServiceLifecycleDiagnostic,
  type ServiceLifecycleDiagnosticPort,
  type ServiceStartupFailure,
  type ShutdownResource,
} from './service-lifecycle-diagnostics.js'

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
  readonly lifecycleDiagnostic?: ServiceLifecycleDiagnosticPort
  readonly randomSource?: RandomSource
}

export async function createApiRuntime(
  config: ServerConfig,
  personaCatalog: PersonaCatalog,
  database: DatabaseClient,
  dependencies: ApiRuntimeCompositionDependencies = {},
): Promise<ApiRuntimeWithPlayerRuntime> {
  const lifecycleDiagnostic =
    dependencies.lifecycleDiagnostic ?? consoleServiceLifecycleDiagnostic
  const randomSource = dependencies.randomSource ?? SECURE_RANDOM_SOURCE
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
    randomSource,
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
        randomSource,
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
  const candidateReader = createActiveSessionCandidateRepository({
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
      session: { ...sessionDependencies, handlers },
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
        onDiagnostic: (event) => lifecycleDiagnostic.record(event),
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
  const handHistory = createCompletedHandHistoryQueryService({
    reader: createAuthoritativeCompletedHandHistoryReader({
      factsReader: createCompletedHandHistoryFactsRepository({
        sql: database.sql,
        owner,
      }),
    }),
  })
  const handHistoryList = createCompletedHandHistoryListQueryService({
    reader: createCompletedHandHistoryListFactsRepository({
      sql: database.sql,
      owner,
    }),
  })
  const statistics = createStatisticsQueryService({
    reader: createStatisticsFactsRepository({ sql: database.sql, owner }),
  })
  const sessionManagement = createSessionManagementQueryService({
    reader: createSessionManagementFactsRepository({
      sql: database.sql,
      owner,
    }),
  })
  const agentCalls = createAgentCallQueryService({
    reader: createAgentCallQueryRepository({ sql: database.sql, owner }),
  })
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
    handHistory,
    handHistoryList,
    statistics,
    sessionManagement,
    agentCalls,
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
  readonly onDiagnostic?: ServiceLifecycleDiagnosticPort['record']
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

export type { ServiceStartupFailure, ShutdownResource }

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
  public constructor(public readonly resources: readonly ShutdownResource[]) {
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
  if (result.kind === 'timedOut') {
    server.forceClose()
    await server.waitForClose()
  }
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
  const lifecycleDiagnostic: ServiceLifecycleDiagnosticPort = Object.freeze({
    record(event: ServiceLifecycleDiagnostic) {
      try {
        if (dependencies.onDiagnostic === undefined) {
          consoleServiceLifecycleDiagnostic.record(event)
        } else {
          dependencies.onDiagnostic(event)
        }
      } catch {
        // Diagnostics must never change a startup or shutdown outcome.
      }
    },
  })

  let database: DatabaseClient | undefined
  let runtime: ApiRuntimeWithPlayerRuntime | undefined
  let server: HttpServerHandle | undefined
  let workerStartAttempted = false
  let shutdownPromise: Promise<void> | null = null
  const assertNotAborted = (): void => {
    if (signal.aborted) throw new ServiceStartupAborted()
  }
  const closeStartedResources = async (): Promise<void> => {
    const failedResources = new Set<ShutdownResource>()
    let httpDrain: Promise<void> | undefined
    if (server !== undefined) {
      try {
        server.beginClose()
        httpDrain = drainHttpServer(server)
      } catch {
        failedResources.add('httpServer')
      }
    }
    if (runtime?.playerRuntime !== undefined) {
      try {
        await runtime.playerRuntime.dispatcher.stop()
      } catch {
        failedResources.add('playerTurnDispatcher')
      }
      if (workerStartAttempted) {
        try {
          await runtime.playerRuntime.worker.stop()
        } catch {
          failedResources.add('playerWorker')
        }
      }
    }
    if (httpDrain !== undefined) {
      try {
        await httpDrain
      } catch {
        failedResources.add('httpServer')
      }
    }
    if (database !== undefined) {
      try {
        await database.close()
      } catch {
        failedResources.add('database')
      }
    }
    const resources = [
      'httpServer',
      'playerTurnDispatcher',
      'playerWorker',
      'database',
    ].filter((resource) =>
      failedResources.has(resource as ShutdownResource),
    ) as ShutdownResource[]
    if (resources.length !== 0) {
      const error = new ServiceShutdownError(Object.freeze(resources))
      lifecycleDiagnostic.record({
        category: 'service_shutdown_resource_failed',
        resources: error.resources,
      })
      throw error
    }
  }

  const waitForHttpReady = async (): Promise<void> => {
    if (server === undefined) throw new ServiceStartupError('httpListenFailed')
    type StartupWaitResult =
      | 'bound'
      | 'boundFailed'
      | 'aborted'
      | 'timedOut'
      | 'httpFatal'
      | 'workerFatal'
      | 'dispatcherFatal'
    let timeout: ReturnType<typeof setTimeout> | undefined
    let abortListener: (() => void) | undefined
    const abortWait = new Promise<StartupWaitResult>((resolve) => {
      abortListener = () => resolve('aborted')
      signal.addEventListener('abort', abortListener, { once: true })
      if (signal.aborted) abortListener()
    })
    const fatalWaits: Promise<StartupWaitResult>[] = [
      server.fatal.then(
        () => 'httpFatal' as const,
        () => 'httpFatal' as const,
      ),
    ]
    if (runtime?.playerRuntime !== undefined) {
      fatalWaits.push(
        runtime.playerRuntime.worker.fatal.then(
          () => 'workerFatal' as const,
          () => 'workerFatal' as const,
        ),
        runtime.playerRuntime.dispatcher.fatal.then(
          () => 'dispatcherFatal' as const,
          () => 'dispatcherFatal' as const,
        ),
      )
    }
    const waits: Promise<StartupWaitResult>[] = [
      ...fatalWaits,
      abortWait,
      server.bound.then(
        () => 'bound' as const,
        () => 'boundFailed' as const,
      ),
      new Promise<StartupWaitResult>((resolve) => {
        timeout = setTimeout(() => resolve('timedOut'), HTTP_BIND_TIMEOUT_MS)
      }),
    ]
    let result: StartupWaitResult
    try {
      result = await Promise.race(waits)
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
      if (abortListener !== undefined) {
        signal.removeEventListener('abort', abortListener)
      }
    }
    if (signal.aborted || result === 'aborted')
      throw new ServiceStartupAborted()
    switch (result) {
      case 'bound':
        return
      case 'boundFailed':
      case 'timedOut':
        throw new ServiceStartupError('httpListenFailed')
      case 'httpFatal':
        throw new ServiceStartupError('httpServerTerminatedUnexpectedly')
      case 'workerFatal':
        throw new ServiceStartupError('playerWorkerTerminatedUnexpectedly')
      case 'dispatcherFatal':
        throw new ServiceStartupError(
          'playerTurnDispatcherTerminatedUnexpectedly',
        )
    }
  }

  try {
    assertNotAborted()
    const config = loadConfig(environment)
    assertNotAborted()
    const personaCatalog = loadPersonaCatalog()
    assertNotAborted()
    database = await initialize(config)
    assertNotAborted()
    runtime = await createRuntime(config, personaCatalog, database, {
      lifecycleDiagnostic,
    })
    assertNotAborted()
    if (runtime.playerRuntime !== undefined) {
      let restartEffects: Awaited<
        ReturnType<ServiceStartupRecovery['recoverAtStartup']>
      >
      try {
        restartEffects =
          await runtime.playerRuntime.startupRecovery.recoverAtStartup({
            signal,
          })
      } catch (error) {
        if (error instanceof StartupRecoveryAborted || signal.aborted) {
          throw new ServiceStartupAborted()
        }
        if (error instanceof StartupRecoveryError) {
          throw new ServiceStartupError(error.failure)
        }
        throw new ServiceStartupError('startupRecoveryFailed')
      }
      assertNotAborted()
      let initialRunIds: readonly string[]
      try {
        initialRunIds = await runtime.playerRuntime.reconcileInitialTurns()
      } catch {
        if (signal.aborted) throw new ServiceStartupAborted()
        throw new ServiceStartupError('initialPlayerTurnReconciliationFailed')
      }
      assertNotAborted()
      workerStartAttempted = true
      try {
        await runtime.playerRuntime.worker.start()
      } catch {
        if (signal.aborted) throw new ServiceStartupAborted()
        throw new ServiceStartupError('workerStartFailed')
      }
      assertNotAborted()
      const runIds = [
        ...new Set([...restartEffects.replacementRunIds, ...initialRunIds]),
      ].sort()
      if (runIds.length !== 0) {
        try {
          runtime.playerRuntime.worker.wake('player', runIds)
        } catch {
          lifecycleDiagnostic.record({ category: 'startup_worker_wake_failed' })
        }
      }
      assertNotAborted()
      try {
        await runtime.playerRuntime.dispatcher.start()
      } catch {
        if (signal.aborted) throw new ServiceStartupAborted()
        throw new ServiceStartupError('dispatcherStartFailed')
      }
    }
    assertNotAborted()
    const app = createApp(runtime, {
      port: config.port,
      allowedOrigins: createLocalWebOrigins(config.port),
      logRequest: (entry) => console.info(JSON.stringify(entry)),
    })
    try {
      server = startListening(config, app)
    } catch {
      throw new ServiceStartupError('httpListenFailed')
    }
    await waitForHttpReady()
    const runningFatal = Promise.race([
      server.fatal.then(
        (fatal) => fatal,
        () => ({ category: 'httpServerTerminatedUnexpectedly' as const }),
      ),
      ...(runtime.playerRuntime === undefined
        ? []
        : [
            runtime.playerRuntime.worker.fatal.then(
              (fatal) => fatal,
              () => ({
                category: 'playerWorkerTerminatedUnexpectedly' as const,
              }),
            ),
            runtime.playerRuntime.dispatcher.fatal.then(
              (fatal) => fatal,
              () => ({
                category: 'playerTurnDispatcherTerminatedUnexpectedly' as const,
              }),
            ),
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
    const startupError =
      error instanceof ServiceStartupError
        ? error
        : error instanceof PlayerRuntimeConfigurationUnavailableError
          ? new ServiceStartupError('playerRuntimeConfigurationUnavailable')
          : error instanceof ServerConfigurationError ||
              error instanceof PersonaCatalogValidationError
            ? new ServiceStartupError('configurationFailed')
            : error instanceof StartupError
              ? new ServiceStartupError('databaseFailed')
              : new ServiceStartupError('unexpectedStartupFailure')
    lifecycleDiagnostic.record({
      category: 'service_startup_failed',
      failure: startupError.failure,
    })
    throw startupError
  }
}
