export type HandAuditPayloadVersionTarget =
  | 'checkpointRowVersion'
  | 'checkpointEnvelopeVersion'
  | 'completedResultRowVersion'
  | 'completedResultEnvelopeVersion'

export class HandAuditPayloadVersionError extends Error {
  public constructor(public readonly target: HandAuditPayloadVersionTarget) {
    super('手牌审计载荷版本不受支持。')
    this.name = 'HandAuditPayloadVersionError'
  }
}

export class HandAuditPayloadValidationError extends Error {
  public constructor() {
    super('手牌审计载荷无效。')
    this.name = 'HandAuditPayloadValidationError'
  }
}

export class HandAuditVersionRegistryConfigurationError extends Error {
  public constructor() {
    super('手牌审计版本注册表配置无效。')
    this.name = 'HandAuditVersionRegistryConfigurationError'
  }
}
