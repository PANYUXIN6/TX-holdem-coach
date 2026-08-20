import type {
  AgentRunClaimInput,
  AgentRunClaimResult,
  AgentRunExecutionDisposition,
  LeasedAgentRun,
} from './agent-run-types.js'
import type { RuntimeCommitAuthority } from './runtime-ports.js'
import type { RuntimeType } from './runtime-definition.js'

export interface AgentRunWorkerControl {
  claimNext(input: AgentRunClaimInput): Promise<AgentRunClaimResult>
  markRunning(authority: RuntimeCommitAuthority): Promise<LeasedAgentRun>
  renewLease(authority: RuntimeCommitAuthority): Promise<LeasedAgentRun>
  inspectSettlement(
    authority: RuntimeCommitAuthority,
  ): Promise<'terminal' | 'authorityLost' | 'activeUnsettled'>
  classifyExecutionSettlement(input: {
    readonly runtimeType: RuntimeType
    readonly executorOutcome: 'resolved' | 'rejected'
    readonly persisted: 'terminal' | 'authorityLost' | 'activeUnsettled'
  }): AgentRunExecutionDisposition
}

export interface RuntimeExecutionPort<TRuntime extends RuntimeType> {
  readonly runtimeType: TRuntime
  execute(run: LeasedAgentRun<TRuntime>, signal: AbortSignal): Promise<void>
}

export interface AgentWorkerFatal {
  readonly category:
    'playerWorkerTerminatedUnexpectedly' | 'coachWorkerTerminatedUnexpectedly'
}

export interface AgentWorkerLifecyclePort {
  readonly fatal: Promise<AgentWorkerFatal>
  start(): Promise<void>
  wake(runtimeType: RuntimeType, runIds: readonly string[]): void
  stop(): Promise<void>
}
