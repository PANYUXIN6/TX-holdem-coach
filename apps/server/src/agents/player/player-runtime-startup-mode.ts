export class PlayerRuntimeConfigurationUnavailableError extends Error {
  public constructor() {
    super('Player 运行时配置不可用，服务未启动。')
    this.name = 'PlayerRuntimeConfigurationUnavailableError'
  }
}
