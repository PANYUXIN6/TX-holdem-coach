export type RuntimeRegistryConfigurationFailure =
  'invalidDefinition' | 'crossRuntimeReference'

export class RuntimeRegistryConfigurationError extends Error {
  public constructor(
    public readonly failure: RuntimeRegistryConfigurationFailure,
  ) {
    super('Agent Runtime 注册表配置无效。')
    this.name = 'RuntimeRegistryConfigurationError'
  }
}

export type RuntimeResolutionFailure =
  'unsupportedRuntime' | 'unknownRuntimeVersion'

export class RuntimeResolutionError extends Error {
  public constructor(public readonly failure: RuntimeResolutionFailure) {
    super('Agent Runtime 定义无法解析。')
    this.name = 'RuntimeResolutionError'
  }
}

export type FoundationProtocolFailure =
  | 'invalidExecutionBudget'
  | 'executionBudgetExhausted'
  | 'capabilityNotDeclared'
  | 'capabilityRuntimeMismatch'
  | 'commitGateNotExecutableAsCapability'
  | 'invalidContextEnvelope'
  | 'contextRuntimeMismatch'
  | 'contextPolicyMismatch'
  | 'contextSectionMismatch'
  | 'contextSchemaRejected'
  | 'contextSizeExhausted'
  | 'contextTokenExhausted'
  | 'sensitiveContextRejected'
  | 'invalidPromptModule'
  | 'promptRuntimeMismatch'
  | 'promptSizeExhausted'
  | 'capabilitySchemaRejected'
  | 'capabilityBudgetExhausted'
  | 'capabilityTimeout'
  | 'capabilityCancelled'
  | 'capabilityExecutionFailed'
  | 'capabilityDeadlineExhausted'
  | 'capabilityAuthorityLost'

export class FoundationProtocolError extends Error {
  public constructor(public readonly failure: FoundationProtocolFailure) {
    super('Agent Foundation 协议校验失败。')
    this.name = 'FoundationProtocolError'
  }
}

export type ModelGatewayFailure =
  | 'provider_billing_unavailable'
  | 'provider_network_error'
  | 'provider_timeout'
  | 'provider_service_unavailable'
  | 'provider_auth_error'
  | 'provider_rate_limited'
  | 'provider_unknown_error'
  | 'provider_usage_unavailable'
  | 'response_parse_error'
  | 'response_schema_error'
  | 'response_semantic_invalid'
  | 'content_correction_exhausted'
  | 'execution_budget_exhausted'
  | 'execution_deadline_exhausted'
  | 'runtime_cancelled'
  | 'runtime_authority_lost'
  | 'sensitive_projection_rejected'
  | 'local_persistence_error'

export class ModelGatewayProtocolError extends Error {
  public constructor(public readonly failure: ModelGatewayFailure) {
    super('模型网关执行失败。')
    this.name = 'ModelGatewayProtocolError'
  }
}
