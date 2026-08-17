export type AgentRunCreationFailure =
  | 'invalid_agent_run_input'
  | 'agent_run_idempotency_conflict'
  | 'active_player_run_conflict'
  | 'runtime_snapshot_unavailable'

export class AgentRunCreationError extends Error {
  public constructor(public readonly failure: AgentRunCreationFailure) {
    super('AgentRun 创建失败。')
    this.name = 'AgentRunCreationError'
  }
}

export type AgentRunTransitionFailure =
  | 'agent_run_transition_rejected'
  | 'agent_run_fencing_rejected'
  | 'agent_run_already_terminal'
  | 'agent_run_checkpoint_rejected'

export class AgentRunTransitionError extends Error {
  public constructor(public readonly failure: AgentRunTransitionFailure) {
    super('AgentRun 生命周期转换被拒绝。')
    this.name = 'AgentRunTransitionError'
  }
}

export type AgentWorkerFailure =
  | 'worker_already_started'
  | 'worker_start_failed'
  | 'player_worker_terminated_unexpectedly'
  | 'coach_worker_terminated_unexpectedly'

export class AgentWorkerError extends Error {
  public constructor(public readonly failure: AgentWorkerFailure) {
    super('Agent Worker 生命周期操作失败。')
    this.name = 'AgentWorkerError'
  }
}
