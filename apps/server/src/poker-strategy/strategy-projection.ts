import type {
  StrategyAbstractionLossCodeV1,
  StrategyAssumptionCodeV1,
  StrategyPack,
} from './strategy-pack.js'

export type StrategyProjection =
  | {
      readonly strategyProjectionSchemaVersion: 1
      readonly status: 'unsupported'
      readonly reasonCode: 'noAuthorizedCoverage'
      readonly datasetId: string
      readonly datasetVersion: number
      readonly candidateWeights: readonly []
    }
  | {
      readonly strategyProjectionSchemaVersion: 1
      readonly status: 'exact' | 'referenceOnly'
      readonly recordId: string
      readonly datasetId: string
      readonly datasetVersion: number
      readonly authorizationRef: string
      readonly abstractionLossCodes: readonly StrategyAbstractionLossCodeV1[]
      readonly candidateWeights: readonly {
        readonly candidateId: string
        readonly actionFrequencyBasisPoints: number
        readonly betSizePotRatio: {
          readonly numerator: number
          readonly denominator: number
        } | null
        readonly solverEv: {
          readonly valueMilliBigBlinds: number
          readonly sourceRef: string
        } | null
      }[]
    }

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

export function projectStrategy(input: {
  readonly pack: StrategyPack
  readonly spotKey: string
  readonly exactHandAbstractionKey: string
  readonly referenceHandAbstractionKey: string
  readonly assumptionCodes: readonly StrategyAssumptionCodeV1[]
  readonly legalCandidateIds: readonly string[]
  readonly aggressiveCandidateIds: readonly string[]
}): StrategyProjection {
  if (input.pack.status === 'revoked') {
    throw new RangeError('已撤销策略包不得投影。')
  }
  const assumptionKey = JSON.stringify([...input.assumptionCodes].sort())
  const eligible = input.pack.records.filter(
    (record) =>
      record.spotKey === input.spotKey &&
      JSON.stringify([...record.assumptionCodes].sort()) === assumptionKey,
  )
  const exactMatches = eligible.filter(
    (record) =>
      record.matchKind === 'exact' &&
      record.handAbstractionKey === input.exactHandAbstractionKey,
  )
  const referenceMatches = eligible.filter(
    (record) =>
      record.matchKind === 'referenceOnly' &&
      record.handAbstractionKey === input.referenceHandAbstractionKey,
  )
  const matches = exactMatches.length > 0 ? exactMatches : referenceMatches
  if (matches.length === 0) {
    return deepFreeze({
      strategyProjectionSchemaVersion: 1,
      status: 'unsupported',
      reasonCode: 'noAuthorizedCoverage',
      datasetId: input.pack.datasetId,
      datasetVersion: input.pack.datasetVersion,
      candidateWeights: [] as const,
    })
  }
  if (matches.length !== 1) throw new RangeError('策略命中必须唯一。')
  const record = matches[0]!
  const legalCandidateIds = new Set(input.legalCandidateIds)
  const aggressiveCandidateIds = new Set(input.aggressiveCandidateIds)
  if (
    [...aggressiveCandidateIds].some(
      (candidateId) => !legalCandidateIds.has(candidateId),
    ) ||
    new Set(record.actions.map((action) => action.candidateId)).size !==
      record.actions.length ||
    record.actions.some((action) => !legalCandidateIds.has(action.candidateId))
  ) {
    throw new RangeError('策略记录引用了非法候选。')
  }
  if (
    record.actions.some(
      (action) =>
        (action.betSizePotRatio !== null) !==
        aggressiveCandidateIds.has(action.candidateId),
    )
  ) {
    throw new RangeError('策略记录下注尺度与当前候选语义不一致。')
  }
  return deepFreeze({
    strategyProjectionSchemaVersion: 1,
    status: record.matchKind,
    recordId: record.recordId,
    datasetId: input.pack.datasetId,
    datasetVersion: input.pack.datasetVersion,
    authorizationRef: record.licenseOrAuthorizationRef,
    abstractionLossCodes: [...record.abstractionLossCodes],
    candidateWeights: record.actions.map((action) => ({ ...action })),
  })
}
