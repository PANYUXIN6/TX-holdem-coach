export class SessionManagementInvariantError extends Error {
  public constructor() {
    super('场次管理查询事实无效。')
    this.name = 'SessionManagementInvariantError'
  }
}
