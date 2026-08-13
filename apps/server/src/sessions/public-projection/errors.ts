export class PublicProjectionInvariantError extends Error {
  public constructor() {
    super('公开场次投影不可用。')
    this.name = 'PublicProjectionInvariantError'
  }
}

export class SessionReadonlyDiagnosticError extends Error {
  public readonly code = 'SESSION_READONLY_DIAGNOSTIC'

  public constructor() {
    super('场次处于只读诊断状态。')
    this.name = 'SessionReadonlyDiagnosticError'
  }
}
