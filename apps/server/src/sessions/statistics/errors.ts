export class StatisticsInvariantError extends Error {
  public constructor() {
    super('统计事实或查询不满足固定契约。')
    this.name = 'StatisticsInvariantError'
  }
}
