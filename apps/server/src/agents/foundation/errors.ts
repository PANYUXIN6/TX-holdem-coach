export type RuntimeRegistryConfigurationFailure =
  | 'invalidDefinition'
  | 'duplicateRuntimeVersion'
  | 'missingCurrentRuntime'
  | 'unknownCurrentVersion'
  | 'crossRuntimeReference'
  | 'invalidStateMachine'

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
  | 'contextEnvelopeInvalid'
  | 'contextBudgetExceeded'
  | 'contextSensitiveContentRejected'
  | 'runtimeTransitionRejected'
  | 'runtimeCheckpointRejected'

export class FoundationProtocolError extends Error {
  public constructor(public readonly failure: FoundationProtocolFailure) {
    super('Agent Foundation 协议校验失败。')
    this.name = 'FoundationProtocolError'
  }
}
