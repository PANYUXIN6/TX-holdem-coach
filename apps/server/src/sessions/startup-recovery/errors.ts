export class PlayerRestartRecoveryContractError extends Error {
  public constructor() {
    super('Player 重启恢复端口返回了无效结果。')
    this.name = 'PlayerRestartRecoveryContractError'
  }
}
