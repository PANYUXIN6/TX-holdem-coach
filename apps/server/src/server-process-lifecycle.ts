import {
  bootstrap,
  ServiceShutdownError,
  ServiceStartupAborted,
  type RunningServiceHandle,
} from './bootstrap.js'

export interface ServerProcessPort {
  exitCode?: number
  once(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
}

export interface ServerProcessLifecycleDependencies {
  readonly bootstrap?: (input: {
    readonly signal: AbortSignal
  }) => Promise<RunningServiceHandle>
  readonly process?: ServerProcessPort
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
  const shutdownController = new AbortController()
  let running: RunningServiceHandle | undefined
  let shutdownRequested = false
  const latchFailureExitCode = (): void => {
    processPort.exitCode = 1
  }

  const shutdownRunningService = (): void => {
    if (running === undefined) return
    void running.shutdown().catch(latchFailureExitCode)
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
        .then(() => {
          latchFailureExitCode()
          return handle.shutdown()
        })
        .catch(latchFailureExitCode)
    })
    .catch((error: unknown) => {
      if (error instanceof ServiceStartupAborted) return
      if (error instanceof ServiceShutdownError) {
        latchFailureExitCode()
        return
      }
      latchFailureExitCode()
    })
}
