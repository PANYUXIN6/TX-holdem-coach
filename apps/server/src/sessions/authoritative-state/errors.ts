export class AuthoritativeStateValidationError extends Error {
  public constructor() {
    super('权威状态无效。')
    this.name = 'AuthoritativeStateValidationError'
  }
}

export type CurrentPayloadVersionTarget =
  | 'snapshotRowVersion'
  | 'snapshotEnvelopeVersion'
  | 'eventRowVersion'
  | 'eventEnvelopeVersion'

export class CurrentPayloadVersionError extends Error {
  public constructor(public readonly target: CurrentPayloadVersionTarget) {
    super('当前持久化载荷版本不受支持。')
    this.name = 'CurrentPayloadVersionError'
  }
}

export class CurrentPayloadValidationError extends Error {
  public constructor() {
    super('当前持久化载荷无效。')
    this.name = 'CurrentPayloadValidationError'
  }
}
