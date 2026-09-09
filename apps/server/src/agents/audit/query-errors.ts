export class HandQueryNotFoundError extends Error {
  public constructor() {
    super('手牌不存在。')
    this.name = 'HandQueryNotFoundError'
  }
}

export class AgentRunQueryNotFoundError extends Error {
  public constructor() {
    super('Agent Run 不存在。')
    this.name = 'AgentRunQueryNotFoundError'
  }
}
