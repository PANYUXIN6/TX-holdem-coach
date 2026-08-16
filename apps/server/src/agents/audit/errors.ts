export type AgentAuditPayloadVersionTarget =
  | 'runConfigurationRowVersion'
  | 'executionBudgetRowVersion'
  | 'attemptAuditRowVersion'

export class AgentAuditPayloadVersionError extends Error {
  public constructor(public readonly target: AgentAuditPayloadVersionTarget) {
    super('Agent 审计载荷版本不受支持。')
    this.name = 'AgentAuditPayloadVersionError'
  }
}

export class AgentAuditPayloadValidationError extends Error {
  public constructor() {
    super('Agent 审计载荷无效。')
    this.name = 'AgentAuditPayloadValidationError'
  }
}

export class AgentAuditVersionRegistryConfigurationError extends Error {
  public constructor() {
    super('Agent 审计版本注册表配置无效。')
    this.name = 'AgentAuditVersionRegistryConfigurationError'
  }
}
