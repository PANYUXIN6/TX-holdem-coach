export class OwnerScopeResolutionError extends Error {
  public constructor() {
    super('Owner 持久化范围无法解析。')
    this.name = 'OwnerScopeResolutionError'
  }
}

export class RepositoryInputValidationError extends Error {
  public constructor() {
    super('Repository 输入无效。')
    this.name = 'RepositoryInputValidationError'
  }
}

export type PayloadKind =
  | 'personaConfig'
  | 'agentMemory'
  | 'commandResponse'
  | 'handStartCheckpoint'
  | 'completedHandResult'
  | 'agentRunConfiguration'
  | 'agentExecutionBudget'
  | 'agentAttempt'

export class UnknownPayloadVersionError extends Error {
  public constructor(public readonly payloadKind: PayloadKind) {
    super('持久化载荷版本不受支持。')
    this.name = 'UnknownPayloadVersionError'
  }
}

export type DataCorruptionKind =
  | 'invalidPayload'
  | 'mirrorMismatch'
  | 'snapshotKeyMismatch'
  | 'invalidRoster'
  | 'invalidInitialMemory'
  | 'invalidCommandLedger'
  | 'invalidSessionMutationState'
  | 'invalidPublicProjectionFacts'
  | 'invalidPublicEventReplay'
  | 'invalidHandAudit'
  | 'invalidAgentRunAudit'
  | 'invalidAgentAttemptAudit'
  | 'invalidCapabilityInvocationAudit'

export class PersistenceDataCorruptionError extends Error {
  public constructor(public readonly corruption: DataCorruptionKind) {
    super('持久化数据损坏。')
    this.name = 'PersistenceDataCorruptionError'
  }
}

export class ResourceNotFoundError extends Error {
  public constructor() {
    super('目标资源未找到。')
    this.name = 'ResourceNotFoundError'
  }
}

export class ActiveModelConfigurationError extends Error {
  public constructor(
    public readonly seatNumber: number,
    public readonly personaId: string,
  ) {
    super('阵容包含当前不可用的人物模型配置。')
    this.name = 'ActiveModelConfigurationError'
  }
}

export class ActiveSessionConflictError extends Error {
  public constructor() {
    super('当前 Owner 已存在活动场次。')
    this.name = 'ActiveSessionConflictError'
  }
}

export class CommandPayloadConflictError extends Error {
  public constructor() {
    super('命令标识已绑定到不同负载。')
    this.name = 'CommandPayloadConflictError'
  }
}

export class CommandLedgerTransitionError extends Error {
  public constructor() {
    super('命令账本状态无法推进。')
    this.name = 'CommandLedgerTransitionError'
  }
}

export class SessionMutationTransitionError extends Error {
  public constructor() {
    super('场次持久化状态无法推进。')
    this.name = 'SessionMutationTransitionError'
  }
}

export class SessionRecoveryTransitionError extends Error {
  public constructor() {
    super('场次恢复状态无法推进。')
    this.name = 'SessionRecoveryTransitionError'
  }
}

export class SessionDeletionTransitionError extends Error {
  public constructor() {
    super('场次删除状态无法推进。')
    this.name = 'SessionDeletionTransitionError'
  }
}

export class SessionCreationTransitionError extends Error {
  public constructor() {
    super('场次创建状态无法推进。')
    this.name = 'SessionCreationTransitionError'
  }
}

export class RosterSourceChangedError extends Error {
  public constructor() {
    super('历史阵容来源已变化，请重新提交。')
    this.name = 'RosterSourceChangedError'
  }
}

export class HandAuditTransitionError extends Error {
  public constructor() {
    super('手牌审计状态无法推进。')
    this.name = 'HandAuditTransitionError'
  }
}

export class AgentAttemptAuditTransitionError extends Error {
  public constructor() {
    super('Agent Attempt 审计状态无法推进。')
    this.name = 'AgentAttemptAuditTransitionError'
  }
}

export class DatabaseOperationError extends Error {
  public constructor() {
    super('数据库操作失败。')
    this.name = 'DatabaseOperationError'
  }
}

export function isRepositoryDomainError(error: unknown): error is Error {
  return (
    error instanceof OwnerScopeResolutionError ||
    error instanceof RepositoryInputValidationError ||
    error instanceof UnknownPayloadVersionError ||
    error instanceof PersistenceDataCorruptionError ||
    error instanceof ResourceNotFoundError ||
    error instanceof ActiveModelConfigurationError ||
    error instanceof ActiveSessionConflictError ||
    error instanceof CommandPayloadConflictError ||
    error instanceof CommandLedgerTransitionError ||
    error instanceof SessionMutationTransitionError ||
    error instanceof SessionRecoveryTransitionError ||
    error instanceof SessionDeletionTransitionError ||
    error instanceof SessionCreationTransitionError ||
    error instanceof RosterSourceChangedError ||
    error instanceof HandAuditTransitionError ||
    error instanceof AgentAttemptAuditTransitionError ||
    error instanceof DatabaseOperationError
  )
}
