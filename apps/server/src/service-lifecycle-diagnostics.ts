export type ServiceStartupFailure =
  | 'configurationFailed'
  | 'databaseFailed'
  | 'playerRuntimeConfigurationUnavailable'
  | 'candidateScanFailed'
  | 'startupRecoveryFailed'
  | 'playerRestartRecoveryContractInvalid'
  | 'initialPlayerTurnReconciliationFailed'
  | 'workerStartFailed'
  | 'dispatcherStartFailed'
  | 'playerWorkerTerminatedUnexpectedly'
  | 'playerTurnDispatcherTerminatedUnexpectedly'
  | 'httpListenFailed'
  | 'httpServerTerminatedUnexpectedly'
  | 'unexpectedStartupFailure'

export type ShutdownResource =
  'httpServer' | 'playerTurnDispatcher' | 'playerWorker' | 'database'

export type ServiceLifecycleDiagnostic =
  | { readonly category: 'startup_worker_wake_failed' }
  | { readonly category: 'startup_committed_event_publish_failed' }
  | { readonly category: 'startup_restart_run_event_publish_failed' }
  | {
      readonly category: 'service_startup_failed'
      readonly failure: ServiceStartupFailure
    }
  | {
      readonly category: 'service_runtime_resource_failed'
      readonly resource: 'httpServer' | 'playerTurnDispatcher' | 'playerWorker'
    }
  | {
      readonly category: 'service_shutdown_resource_failed'
      readonly resources: readonly ShutdownResource[]
    }

export interface ServiceLifecycleDiagnosticPort {
  record(event: ServiceLifecycleDiagnostic): void
}

export const consoleServiceLifecycleDiagnostic: ServiceLifecycleDiagnosticPort =
  Object.freeze({
    record(event: ServiceLifecycleDiagnostic) {
      console.error(JSON.stringify(event))
    },
  })
