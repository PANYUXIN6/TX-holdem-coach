export type StartupRecoveryFailure =
  | 'candidateScanFailed'
  | 'startupRecoveryFailed'
  | 'playerRestartRecoveryContractInvalid'

export class StartupRecoveryError extends Error {
  public constructor(public readonly failure: StartupRecoveryFailure) {
    super('服务启动恢复失败。')
    this.name = 'StartupRecoveryError'
  }
}

export class StartupRecoveryAborted extends Error {
  public constructor() {
    super('服务启动恢复已取消。')
    this.name = 'StartupRecoveryAborted'
  }
}
