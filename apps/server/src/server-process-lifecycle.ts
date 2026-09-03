import {
  bootstrap,
  ServiceShutdownError,
  ServiceStartupAborted,
  ServiceStartupError,
  type RunningServiceHandle,
} from './bootstrap.js'
import {
  consoleServiceLifecycleDiagnostic,
  type ServiceLifecycleDiagnostic,
} from './service-lifecycle-diagnostics.js'

export interface ServerProcessPort {
  exitCode?: number
  once(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
}

export interface ServerProcessLifecycleDependencies {
  readonly bootstrap?: (input: {
    readonly signal: AbortSignal
  }) => Promise<RunningServiceHandle>
  readonly process?: ServerProcessPort
  readonly onDiagnostic?: (event: ServiceLifecycleDiagnostic) => void
}

function runtimeFatalResource(
  fatal: unknown,
): 'httpServer' | 'playerTurnDispatcher' | 'playerWorker' {
  if (
    typeof fatal === 'object' &&
    fatal !== null &&
    'category' in fatal &&
    fatal.category === 'httpServerTerminatedUnexpectedly'
  ) {
    return 'httpServer'
  }
  if (
    typeof fatal === 'object' &&
    fatal !== null &&
    'category' in fatal &&
    fatal.category === 'playerTurnDispatcherTerminatedUnexpectedly'
  ) {
    return 'playerTurnDispatcher'
  }
  return 'playerWorker'
}

/**
 * 进程层只负责信号与退出语义；资源关闭仍完全由 bootstrap 持有。
 * Runtime fatal 无论 cleanup 是否成功都必须保留失败退出码。
 */
export function startServiceProcess(
  dependencies: ServerProcessLifecycleDependencies = {},
): void {
  const processPort = dependencies.process ?? process
  const bootstrapService = dependencies.bootstrap ?? bootstrap
  const diagnose = (event: ServiceLifecycleDiagnostic): void => {
    try {
      if (dependencies.onDiagnostic === undefined) {
        consoleServiceLifecycleDiagnostic.record(event)
      } else {
        dependencies.onDiagnostic(event)
      }
    } catch {
      // Diagnostics cannot change process lifecycle behavior.
    }
  }
  const shutdownController = new AbortController()
  let running: RunningServiceHandle | undefined
  let shutdownRequested = false
  const latchFailureExitCode = (): void => {
    processPort.exitCode = 1
  }

  const shutdownRunningService = (): void => {
    if (running === undefined) return
    void running.shutdown().catch((error: unknown) => {
      if (error instanceof ServiceShutdownError) {
        diagnose({
          category: 'service_shutdown_resource_failed',
          resources: error.resources,
        })
      }
      latchFailureExitCode()
    })
  }

  const requestShutdown = (): void => {
    if (shutdownRequested) return
    shutdownRequested = true
    shutdownController.abort()
    shutdownRunningService()
  }

  processPort.once('SIGINT', requestShutdown)
  processPort.once('SIGTERM', requestShutdown)

  void bootstrapService({ signal: shutdownController.signal })
    .then((handle) => {
      running = handle
      if (shutdownRequested) {
        shutdownRunningService()
        return
      }
      void handle.fatal
        .then((fatal) => {
          diagnose({
            category: 'service_runtime_resource_failed',
            resource: runtimeFatalResource(fatal),
          })
          latchFailureExitCode()
          return handle.shutdown()
        })
        .catch((error: unknown) => {
          if (error instanceof ServiceShutdownError) {
            diagnose({
              category: 'service_shutdown_resource_failed',
              resources: error.resources,
            })
          }
          latchFailureExitCode()
        })
    })
    .catch((error: unknown) => {
      if (error instanceof ServiceStartupAborted) return
      if (error instanceof ServiceStartupError) {
        diagnose({
          category: 'service_startup_failed',
          failure: error.failure,
        })
      } else if (!(error instanceof ServiceShutdownError)) {
        diagnose({
          category: 'service_startup_failed',
          failure: 'unexpectedStartupFailure',
        })
      }
      if (error instanceof ServiceShutdownError) {
        latchFailureExitCode()
        return
      }
      latchFailureExitCode()
    })
}
