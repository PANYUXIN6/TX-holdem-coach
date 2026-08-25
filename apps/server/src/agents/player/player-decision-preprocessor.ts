import { createHash } from 'node:crypto'
import type { JsonValue } from '../../persisted-json.js'
import { canonicalJson } from '../../persisted-json.js'
import {
  projectCandidateOutcomes,
  type CandidateOutcomeData,
} from '../../poker/candidate-outcomes.js'
import type { StrategyPackReference } from '../../poker-strategy/strategy-pack.js'
import type { PlayerVisibleState } from '../../sessions/authoritative-state/player-visible-state.js'
import {
  applyExploitAdjustmentPolicyV1,
  applyPersonaDeviationPolicy,
  generateHeuristicCandidates,
  type HeuristicCandidateResult,
  type PolicyCandidate,
  type WeightedPolicyCandidate,
} from './player-decision-policies.js'
import {
  createPlayerDecisionAnalysisInput,
  samePlayerDecisionBinding,
  type BoundAnalysis,
  type PlayerDecisionAnalysisBinding,
} from './player-decision-analysis-input.js'
import {
  isPlayerDecisionAnalysisCore,
  type PlayerDecisionAnalysisCore,
  type PlayerDecisionAnalysisCoreData,
} from './player-decision-analysis-core.js'
import type { PlayerDecisionReference } from './player-decision-reference.js'
import {
  mapCoreFactSourcesToPlayer,
  type FactSourceRef,
  type PlayerSourced,
} from './player-fact-sources.js'
import {
  isPlayerOpponentEvidence,
  type PlayerOpponentEvidence,
} from './player-opponent-evidence.js'
import {
  isPlayerStrategyProjection,
  type PlayerStrategyProjection,
} from './player-strategy-projection.js'
import {
  decodeCurrentPlayerDecisionPreprocessingResult,
  FinalCandidateDataSchema,
  HeuristicCandidateResultSchema,
} from './player-decision-preprocessing-schema.js'

export interface FinalCandidateData extends PolicyCandidate {
  readonly source: 'strategy' | 'heuristic'
  readonly baseWeightBasisPoints: number
  readonly personaAdjustedWeightBasisPoints: number
  readonly exploitAdjustedWeightBasisPoints: number
  readonly weightBasisPoints: number
  readonly commitmentRiskBand:
    HeuristicCandidateResult['candidates'][number]['commitmentRiskBand'] | null
  readonly sourceRefs: readonly FactSourceRef[]
}

export interface PlayerDecisionPreprocessingResultData {
  readonly binding: PlayerDecisionAnalysisBinding
  readonly preprocessingResultSchemaVersion: 1
  readonly preprocessingPipelineVersion: 1
  readonly configSnapshotKey: string
  readonly personaId: PlayerDecisionReference['personaId']
  readonly personaVersion: PlayerDecisionReference['personaVersion']
  readonly strategyPackRef: StrategyPackReference
  readonly normalizedSpot: BoundAnalysis<
    PlayerDecisionAnalysisCoreData['normalizedSpot']
  >
  readonly handFeatures: BoundAnalysis<
    PlayerDecisionAnalysisCoreData['handFeatures']
  >
  readonly contestablePot: BoundAnalysis<
    PlayerDecisionAnalysisCoreData['contestablePot']
  >
  readonly currentMetrics: BoundAnalysis<
    PlayerDecisionAnalysisCoreData['currentMetrics']
  >
  readonly strategyProjection: PlayerStrategyProjection
  readonly candidateSource: 'strategy' | 'heuristic'
  readonly heuristicCandidateResult: BoundAnalysis<HeuristicCandidateResult | null>
  readonly personaAdjustment: BoundAnalysis<
    ReturnType<typeof applyPersonaDeviationPolicy>
  >
  readonly opponentEvidence: PlayerOpponentEvidence
  readonly exploitAdjustment: BoundAnalysis<
    ReturnType<typeof applyExploitAdjustmentPolicyV1>
  >
  readonly candidates: BoundAnalysis<readonly FinalCandidateData[]>
  readonly candidateOutcomes: BoundAnalysis<
    readonly PlayerSourced<CandidateOutcomeData<FactSourceRef>>[]
  >
  readonly preprocessingSha256: string
}

declare const playerDecisionPreprocessingResultBrand: unique symbol

export type PlayerDecisionPreprocessingResult =
  PlayerDecisionPreprocessingResultData & {
    readonly [playerDecisionPreprocessingResultBrand]: never
  }

const certifiedPreprocessingResults = new WeakSet<object>()

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

function assertSameBinding(
  binding: PlayerDecisionAnalysisBinding,
  values: readonly { readonly binding: PlayerDecisionAnalysisBinding }[],
): void {
  if (
    values.some((value) => !samePlayerDecisionBinding(binding, value.binding))
  ) {
    throw new RangeError('Player 预处理组件绑定不一致。')
  }
}

function assertWeightConservation(
  stage: string,
  candidates: readonly {
    readonly candidateId: string
    readonly weightBasisPoints: number
  }[],
): void {
  if (
    candidates.length === 0 ||
    new Set(candidates.map(({ candidateId }) => candidateId)).size !==
      candidates.length ||
    candidates.some(
      ({ weightBasisPoints }) =>
        !Number.isInteger(weightBasisPoints) ||
        weightBasisPoints < 0 ||
        weightBasisPoints > 10_000,
    ) ||
    candidates.reduce(
      (total, { weightBasisPoints }) => total + weightBasisPoints,
      0,
    ) !== 10_000
  ) {
    throw new RangeError(`${stage}候选权重未精确闭合。`)
  }
}

function sourceRefsForCandidate(input: {
  readonly reference: PlayerDecisionReference
  readonly strategyProjection: PlayerStrategyProjection
  readonly heuristicCandidateResult: HeuristicCandidateResult | null
  readonly opponentEvidence: PlayerOpponentEvidence
}): readonly FactSourceRef[] {
  const strategySource: FactSourceRef =
    input.strategyProjection.data.status === 'unsupported'
      ? {
          kind: 'strategyPack',
          datasetId: input.strategyProjection.data.datasetId,
          datasetVersion: input.strategyProjection.data.datasetVersion,
          status: 'unsupported',
          reasonCode: input.strategyProjection.data.reasonCode,
        }
      : {
          kind: 'strategyRecord',
          datasetId: input.strategyProjection.data.datasetId,
          datasetVersion: input.strategyProjection.data.datasetVersion,
          recordId: input.strategyProjection.data.recordId,
          authorizationRef: input.strategyProjection.data.authorizationRef,
        }
  const policySources: FactSourceRef[] = [strategySource]
  if (input.heuristicCandidateResult !== null) {
    policySources.push({
      kind: 'heuristicPolicy',
      policyVersion:
        input.heuristicCandidateResult.heuristicCandidatePolicyVersion,
      confidence: input.heuristicCandidateResult.confidence,
      reasonCode: input.heuristicCandidateResult.reasonCode,
      unsupportedReasonCode:
        input.heuristicCandidateResult.unsupportedReasonCode,
    })
  }
  policySources.push(
    {
      kind: 'personaSnapshot',
      configSnapshotKey: input.reference.configSnapshotKey,
      personaId: input.reference.personaId,
      personaVersion: input.reference.personaVersion,
    },
    {
      kind: 'opponentEvidence',
      evidenceSchemaVersion:
        input.opponentEvidence.data.opponentEvidenceSchemaVersion,
      evidenceId: input.opponentEvidence.data.evidenceId,
      asOfEventSeq: input.opponentEvidence.data.asOfEventSeq,
    },
    {
      kind: 'exploitPolicy',
      policyVersion: 1,
      evidenceId: input.opponentEvidence.data.evidenceId,
      asOfEventSeq: input.opponentEvidence.data.asOfEventSeq,
      status: 'insufficientEvidence',
      reasonCode: 'crossHandEvidenceUnavailable',
    },
  )
  return policySources
}

export function composePlayerDecisionPreprocessingResult(input: {
  readonly observation: PlayerVisibleState
  readonly reference: PlayerDecisionReference
  readonly strategyPackRef: StrategyPackReference
  readonly analysisCore: PlayerDecisionAnalysisCore
  readonly strategyProjection: PlayerStrategyProjection
  readonly opponentEvidence: PlayerOpponentEvidence
}): PlayerDecisionPreprocessingResult {
  if (
    !isPlayerDecisionAnalysisCore(input.analysisCore) ||
    !isPlayerStrategyProjection(input.strategyProjection) ||
    !isPlayerOpponentEvidence(input.opponentEvidence)
  ) {
    throw new RangeError('Player 预处理只接受已认证阶段结果。')
  }
  const prepared = createPlayerDecisionAnalysisInput({
    observation: input.observation,
    reference: input.reference,
  })
  const binding = prepared.binding
  assertSameBinding(binding, [
    input.analysisCore,
    input.strategyProjection,
    input.opponentEvidence,
  ])
  if (
    input.strategyPackRef.datasetId !==
      input.strategyProjection.data.datasetId ||
    input.strategyPackRef.datasetVersion !==
      input.strategyProjection.data.datasetVersion
  ) {
    throw new RangeError('策略包引用与认证策略投影的数据集不一致。')
  }
  const catalog = input.analysisCore.data.legalCandidates
  const hero = prepared.analysisInput.seats.find(
    (seat) => seat.seatNumber === prepared.analysisInput.heroSeatNumber,
  )
  if (hero === undefined || hero.stack <= 0) {
    throw new RangeError('Player 预处理缺少可行动 Hero。')
  }
  const policyCandidates = catalog.map((candidate) => ({
    candidateId: candidate.candidateId,
    action: candidate.action,
    targetStreetCommitment: candidate.targetStreetCommitment,
    contributionDelta:
      candidate.action.type === 'call'
        ? input.analysisCore.data.currentMetrics.amounts.amountToCall
        : candidate.action.type === 'bet' || candidate.action.type === 'raise'
          ? candidate.action.targetStreetCommitment - hero.streetContribution
          : candidate.action.type === 'allIn'
            ? hero.stack
            : 0,
  }))
  let weighted: readonly WeightedPolicyCandidate[]
  let candidateSource: 'strategy' | 'heuristic'
  let heuristicCandidateResult: HeuristicCandidateResult | null
  if (input.strategyProjection.data.status === 'unsupported') {
    candidateSource = 'heuristic'
    heuristicCandidateResult = generateHeuristicCandidates({
      candidates: policyCandidates,
      heroStackBefore: hero.stack,
      unsupportedReasonCode: input.strategyProjection.data.reasonCode,
    })
    weighted = heuristicCandidateResult.candidates
  } else {
    candidateSource = 'strategy'
    heuristicCandidateResult = null
    const weightById = new Map(
      input.strategyProjection.data.candidateWeights.map((entry) => [
        entry.candidateId,
        entry.actionFrequencyBasisPoints,
      ]),
    )
    weighted = policyCandidates.map((candidate) => ({
      ...candidate,
      weightBasisPoints: weightById.get(candidate.candidateId) ?? 0,
    }))
  }
  assertWeightConservation('基础', weighted)
  const personaAdjustment = applyPersonaDeviationPolicy({
    personaPolicy: input.reference.personaPolicy,
    candidates: weighted,
  })
  const exploitAdjustment = applyExploitAdjustmentPolicyV1({
    evidenceId: input.opponentEvidence.data.evidenceId,
    asOfEventSeq: input.opponentEvidence.data.asOfEventSeq,
    candidates: personaAdjustment.candidates,
  })
  assertWeightConservation('人物调整后', personaAdjustment.candidates)
  assertWeightConservation('利用调整后', exploitAdjustment.candidates)
  const baseById = new Map(
    weighted.map(({ candidateId, weightBasisPoints }) => [
      candidateId,
      weightBasisPoints,
    ]),
  )
  const personaById = new Map(
    personaAdjustment.candidates.map(({ candidateId, weightBasisPoints }) => [
      candidateId,
      weightBasisPoints,
    ]),
  )
  const heuristicRiskById = new Map(
    (heuristicCandidateResult?.candidates ?? []).map(
      ({ candidateId, commitmentRiskBand }) => [
        candidateId,
        commitmentRiskBand,
      ],
    ),
  )
  const directSourceRefs = sourceRefsForCandidate({
    reference: input.reference,
    strategyProjection: input.strategyProjection,
    heuristicCandidateResult,
    opponentEvidence: input.opponentEvidence,
  })
  if (
    exploitAdjustment.candidates.length !== weighted.length ||
    exploitAdjustment.candidates.some(
      ({ candidateId }) =>
        !baseById.has(candidateId) || !personaById.has(candidateId),
    )
  ) {
    throw new RangeError('候选政策阶段集合不一致。')
  }
  const coreOutcomes = projectCandidateOutcomes({
    analysisInput: prepared.analysisInput,
    candidateCatalog: catalog,
  })
  const playerOutcomes = mapCoreFactSourcesToPlayer(coreOutcomes, binding)
  const bind = <Value>(data: Value): BoundAnalysis<Value> =>
    deepFreeze({ binding, data })
  const finalCandidates = FinalCandidateDataSchema.array().parse(
    exploitAdjustment.candidates.map((candidate) => ({
      ...candidate,
      source: candidateSource,
      baseWeightBasisPoints: baseById.get(candidate.candidateId)!,
      personaAdjustedWeightBasisPoints: personaById.get(candidate.candidateId)!,
      exploitAdjustedWeightBasisPoints: candidate.weightBasisPoints,
      commitmentRiskBand: heuristicRiskById.get(candidate.candidateId) ?? null,
      sourceRefs: directSourceRefs.map((sourceRef) => ({ ...sourceRef })),
    })),
  )
  assertWeightConservation(
    '最终',
    finalCandidates.map((candidate) => ({
      ...candidate,
      weightBasisPoints: candidate.exploitAdjustedWeightBasisPoints,
    })),
  )
  const withoutHash = {
    binding,
    preprocessingResultSchemaVersion: 1 as const,
    preprocessingPipelineVersion: 1 as const,
    configSnapshotKey: input.reference.configSnapshotKey,
    personaId: input.reference.personaId,
    personaVersion: input.reference.personaVersion,
    strategyPackRef: { ...input.strategyPackRef },
    normalizedSpot: bind(input.analysisCore.data.normalizedSpot),
    handFeatures: bind(input.analysisCore.data.handFeatures),
    contestablePot: bind(input.analysisCore.data.contestablePot),
    currentMetrics: bind(input.analysisCore.data.currentMetrics),
    strategyProjection: input.strategyProjection,
    candidateSource,
    heuristicCandidateResult: bind(
      heuristicCandidateResult === null
        ? null
        : HeuristicCandidateResultSchema.parse(heuristicCandidateResult),
    ),
    personaAdjustment: bind(personaAdjustment),
    opponentEvidence: input.opponentEvidence,
    exploitAdjustment: bind(exploitAdjustment),
    candidates: bind(finalCandidates),
    candidateOutcomes: bind(playerOutcomes),
  }
  const preprocessingSha256 = createHash('sha256')
    .update(canonicalJson(withoutHash as unknown as JsonValue), 'utf8')
    .digest('hex')
  const decoded = decodeCurrentPlayerDecisionPreprocessingResult({
    ...withoutHash,
    preprocessingSha256,
  })
  const result = deepFreeze(
    decoded as unknown as PlayerDecisionPreprocessingResult,
  )
  certifiedPreprocessingResults.add(result)
  return result
}

export function isPlayerDecisionPreprocessingResult(
  value: unknown,
): value is PlayerDecisionPreprocessingResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    certifiedPreprocessingResults.has(value)
  )
}
