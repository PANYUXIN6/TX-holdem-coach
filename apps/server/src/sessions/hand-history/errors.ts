export class CompletedHandHistoryInvariantError extends Error {
  public constructor() {
    super('完成手历史事实不一致。')
    this.name = 'CompletedHandHistoryInvariantError'
  }
}
