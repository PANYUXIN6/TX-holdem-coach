import { createHash } from 'node:crypto'
import { AgentPersonaIdSchema } from '@tx-holdem-coach/contracts'
import { z } from 'zod'
import { canonicalJson, type JsonValue } from '../../persisted-json.js'
import { isLegalCandidateSemanticallyConsistent } from '../../poker/betting-projection.js'
import { PokerCommandSchema } from '../../poker/commands.js'
import { M45AssumptionCodeSchema } from '../../poker/decision-analysis-types.js'
import { StrategyPackReferenceSchema } from '../../poker-strategy/strategy-pack.js'
import { Sha256DigestSchema } from '../audit/audit-primitives.js'
import {
  ContestablePotProjectionSchema,
  DecisionMetricsSchema,
  HandFeatureAnalysisSchema,
  NormalizedDecisionSpotSchema,
  OpponentEvidenceProjectionDataSchema,
  PlayerDecisionAnalysisBindingSchema,
  StrategyProjectionDataSchema,
} from './player-decision-capabilities.js'
import {
  FactSourceRefSchema,
  type FactSourceRef,
} from './player-fact-sources.js'

const SafeNonnegativeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
const SafePositiveIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
const BasisPointsSchema = z.number().int().min(0).max(10_000)
const SeatNumberSchema = z.number().int().min(0).max(8)
const ActionTypeSchema = z.enum([
  'fold',
  'check',
  'call',
  'bet',
  'raise',
  'allIn',
])
const ExactRatioSchema = z.strictObject({
  numerator: SafeNonnegativeIntegerSchema,
  denominator: SafePositiveIntegerSchema,
  basisPoints: SafeNonnegativeIntegerSchema,
})

const PolicyCandidateShape = {
  candidateId: z.string().trim().min(1),
  action: PokerCommandSchema.shape.action,
  targetStreetCommitment: SafeNonnegativeIntegerSchema.nullable(),
  contributionDelta: SafeNonnegativeIntegerSchema,
}

const WeightedPolicyCandidateSchema = z.strictObject({
  ...PolicyCandidateShape,
  weightBasisPoints: BasisPointsSchema,
  commitmentRiskBand: z
    .enum(['zero', 'low', 'medium', 'high', 'allIn'])
    .optional(),
})

export const HeuristicCandidateResultSchema = z.strictObject({
  heuristicCandidatePolicyVersion: z.literal(1),
  confidence: z.literal('low'),
  reasonCode: z.literal('legalFallbackCandidate'),
  unsupportedReasonCode: z.literal('noAuthorizedCoverage'),
  candidates: z.array(
    z.strictObject({
      ...PolicyCandidateShape,
      weightBasisPoints: BasisPointsSchema,
      commitmentRiskBand: z.enum(['zero', 'low', 'medium', 'high', 'allIn']),
    }),
  ),
})

const PersonaAdjustmentResultSchema = z.strictObject({
  personaDeviationPolicyVersion: z.literal(1),
  candidates: z.array(WeightedPolicyCandidateSchema),
  adjustments: z.array(
    z.strictObject({
      ruleId: z.string().trim().min(1),
      fromCandidateId: z.string().trim().min(1).nullable(),
      toCandidateId: z.string().trim().min(1).nullable(),
      transferredBasisPoints: BasisPointsSchema,
      status: z.enum(['applied', 'notApplicable']),
      reasonCode: z.string().trim().min(1),
    }),
  ),
})

const ExploitAdjustmentResultSchema = z.strictObject({
  exploitAdjustmentPolicyVersion: z.literal(1),
  evidenceId: Sha256DigestSchema,
  asOfEventSeq: SafeNonnegativeIntegerSchema,
  status: z.literal('insufficientEvidence'),
  reasonCode: z.literal('crossHandEvidenceUnavailable'),
  candidates: z.array(WeightedPolicyCandidateSchema),
})

export const FinalCandidateDataSchema = z.strictObject({
  ...PolicyCandidateShape,
  weightBasisPoints: BasisPointsSchema,
  source: z.enum(['strategy', 'heuristic']),
  baseWeightBasisPoints: BasisPointsSchema,
  personaAdjustedWeightBasisPoints: BasisPointsSchema,
  exploitAdjustedWeightBasisPoints: BasisPointsSchema,
  commitmentRiskBand: z
    .enum(['zero', 'low', 'medium', 'high', 'allIn'])
    .nullable(),
  sourceRefs: z.array(FactSourceRefSchema).min(4),
})

type PolicyCandidateLike = {
  readonly candidateId: string
  readonly action: z.infer<typeof PokerCommandSchema>['action']
  readonly targetStreetCommitment: number | null
  readonly contributionDelta: number
}

function samePolicyCandidate(
  left: PolicyCandidateLike,
  right: PolicyCandidateLike,
): boolean {
  return (
    left.candidateId === right.candidateId &&
    canonicalJson(left.action as JsonValue) ===
      canonicalJson(right.action as JsonValue) &&
    left.targetStreetCommitment === right.targetStreetCommitment &&
    left.contributionDelta === right.contributionDelta
  )
}

function sameUniqueSourceSet(
  actual: readonly FactSourceRef[],
  expected: readonly FactSourceRef[],
): boolean {
  const actualKeys = actual.map((source) => canonicalJson(source as JsonValue))
  const expectedKeys = expected.map((source) =>
    canonicalJson(source as JsonValue),
  )
  const actualSet = new Set(actualKeys)
  const expectedSet = new Set(expectedKeys)
  return (
    actual.length === expected.length &&
    actualSet.size === actual.length &&
    expectedSet.size === expected.length &&
    expectedKeys.every((source) => actualSet.has(source))
  )
}

function projectedTargetMatches(
  targetStreetCommitment: number | null,
  projectedTarget:
    | { readonly status: 'available'; readonly value: number }
    | { readonly status: 'notApplicable'; readonly reasonCode: 'noTarget' },
): boolean {
  return targetStreetCommitment === null
    ? projectedTarget.status === 'notApplicable'
    : projectedTarget.status === 'available' &&
        projectedTarget.value === targetStreetCommitment
}

const LegalCandidateSchema = z
  .strictObject({
    candidateSchemaVersion: z.literal(1),
    candidateId: z.string().trim().min(1),
    action: PokerCommandSchema.shape.action,
    targetStreetCommitment: SafeNonnegativeIntegerSchema.nullable(),
    targetKind: z.enum([
      'minimum',
      'halfPot',
      'twoThirdsPot',
      'pot',
      'call',
      'allIn',
      'notApplicable',
    ]),
  })
  .superRefine((candidate, context) => {
    if (!isLegalCandidateSemanticallyConsistent(candidate)) {
      context.addIssue({
        code: 'custom',
        path: ['candidateId'],
        message: '候选 ID 必须与 action、target 和 targetKind 语义一致。',
      })
    }
  })

const CandidateSprProjectionSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('available'),
    value: z.array(
      z.strictObject({
        opponentSeatNumber: SeatNumberSchema,
        effectiveStack: SafeNonnegativeIntegerSchema,
        spr: ExactRatioSchema,
      }),
    ),
    sourceRefs: z.array(FactSourceRefSchema),
  }),
  z.strictObject({
    status: z.literal('notApplicable'),
    reasonCode: z.enum([
      'forcedRunout',
      'bettingRoundRemainsOpen',
      'handComplete',
      'wrongStreet',
      'noFutureDecisionStreet',
    ]),
    sourceRefs: z.array(FactSourceRefSchema),
  }),
])

const CandidateThresholdFactSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('available'),
    value: ExactRatioSchema,
    epistemicKind: z.literal('formulaFact'),
    sourceRefs: z.array(FactSourceRefSchema),
    assumptionCodes: z.tuple([z.literal('ignoresFutureAction')]),
  }),
  z.strictObject({
    status: z.literal('unavailable'),
    reasonCode: z.literal('noJointResponseModel'),
    sourceRefs: z.array(FactSourceRefSchema),
    assumptionCodes: z.tuple([z.literal('noJointResponseModel')]),
  }),
  z.strictObject({
    status: z.literal('notApplicable'),
    reasonCode: z.enum(['notCallingAction', 'notPureBluffCandidate']),
    sourceRefs: z.array(FactSourceRefSchema),
    assumptionCodes: z.tuple([]),
  }),
])

const UnavailableOutcomeFactSchema = z.strictObject({
  status: z.literal('unavailable'),
  reasonCode: z.enum(['noVersionedOpponentRange', 'noJointResponseModel']),
  sourceRefs: z.array(FactSourceRefSchema),
  assumptionCodes: z.array(M45AssumptionCodeSchema),
})

export const CandidateOutcomeDataSchema = z.strictObject({
  candidateOutcomeSchemaVersion: z.literal(1),
  projectorVersion: z.literal(1),
  sourceRefs: z.array(FactSourceRefSchema),
  candidate: LegalCandidateSchema,
  amountToCall: SafeNonnegativeIntegerSchema,
  contributionDelta: SafeNonnegativeIntegerSchema,
  targetStreetCommitment: z.discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('available'),
      value: SafeNonnegativeIntegerSchema,
    }),
    z.strictObject({
      status: z.literal('notApplicable'),
      reasonCode: z.literal('noTarget'),
    }),
  ]),
  streetContributionAfter: SafeNonnegativeIntegerSchema,
  totalContributionAfter: SafeNonnegativeIntegerSchema,
  guaranteedUncalledReturn: SafeNonnegativeIntegerSchema,
  amountActuallyAtRisk: SafeNonnegativeIntegerSchema,
  contestableAmountAdded: SafeNonnegativeIntegerSchema,
  potAfterAction: SafeNonnegativeIntegerSchema,
  heroContestablePotAfterAction: SafeNonnegativeIntegerSchema,
  marginalContestablePot: z.strictObject({
    amountActuallyAtRisk: SafeNonnegativeIntegerSchema,
    contestableAmountAdded: SafeNonnegativeIntegerSchema,
  }),
  actionScale: z.strictObject({
    contributionDeltaToPotBefore: z.strictObject({
      ratioKind: z.literal('contributionDeltaToPotBefore'),
      value: ExactRatioSchema,
    }),
    targetStreetCommitmentToPotBefore: z.discriminatedUnion('status', [
      z.strictObject({
        status: z.literal('available'),
        ratioKind: z.literal('targetStreetCommitmentToPotBefore'),
        value: ExactRatioSchema,
      }),
      z.strictObject({
        status: z.literal('notApplicable'),
        reasonCode: z.literal('noTarget'),
      }),
    ]),
  }),
  heroStackAfterAction: SafeNonnegativeIntegerSchema,
  effectiveStacksByOpponentAfterAction: z.array(
    z.strictObject({
      opponentSeatNumber: SeatNumberSchema,
      currentEffectiveStack: SafeNonnegativeIntegerSchema,
      maximumAdditionalMatchedContribution: SafeNonnegativeIntegerSchema,
    }),
  ),
  isAllIn: z.boolean(),
  handEndsByFold: z.boolean(),
  forcesRunout: z.boolean(),
  remainingStreetsToDeal: SafeNonnegativeIntegerSchema,
  furtherBettingPossible: z.boolean(),
  showdownForced: z.boolean(),
  responders: z.array(SeatNumberSchema),
  canRaiseSeats: z.array(SeatNumberSchema),
  heroActionCompletes: z.literal(true),
  bettingRoundClosesImmediately: z.boolean(),
  canFaceFurtherAction: z.boolean(),
  legalSuccessorSpace: z.strictObject({
    nextActorSeatNumber: SeatNumberSchema.nullable(),
    possibleActionTypes: z.array(ActionTypeSchema),
    mayReturnToHero: z.boolean(),
  }),
  projectedFlopSpr: CandidateSprProjectionSchema,
  nextStreetSpr: CandidateSprProjectionSchema,
  minimumRequiredEquityForCall: CandidateThresholdFactSchema,
  pureBluffBreakEvenFoldRate: CandidateThresholdFactSchema,
  rangeConditionalEquity: UnavailableOutcomeFactSchema,
  opponentResponseProbability: UnavailableOutcomeFactSchema,
  expectedValue: UnavailableOutcomeFactSchema,
  futureStreetValue: UnavailableOutcomeFactSchema,
  impliedOdds: UnavailableOutcomeFactSchema,
  foldEquity: UnavailableOutcomeFactSchema,
})

function bound<Value extends z.ZodType>(data: Value) {
  return z.strictObject({
    binding: PlayerDecisionAnalysisBindingSchema,
    data,
  })
}

export const PlayerDecisionPreprocessingResultDataSchema = z
  .strictObject({
    binding: PlayerDecisionAnalysisBindingSchema,
    preprocessingResultSchemaVersion: z.literal(1),
    preprocessingPipelineVersion: z.literal(1),
    configSnapshotKey: Sha256DigestSchema,
    personaId: AgentPersonaIdSchema,
    personaVersion: z.literal(1),
    strategyPackRef: StrategyPackReferenceSchema,
    normalizedSpot: bound(NormalizedDecisionSpotSchema),
    handFeatures: bound(HandFeatureAnalysisSchema),
    contestablePot: bound(ContestablePotProjectionSchema),
    currentMetrics: bound(DecisionMetricsSchema),
    strategyProjection: bound(StrategyProjectionDataSchema),
    candidateSource: z.enum(['strategy', 'heuristic']),
    heuristicCandidateResult: bound(HeuristicCandidateResultSchema.nullable()),
    personaAdjustment: bound(PersonaAdjustmentResultSchema),
    opponentEvidence: bound(OpponentEvidenceProjectionDataSchema),
    exploitAdjustment: bound(ExploitAdjustmentResultSchema),
    candidates: bound(z.array(FinalCandidateDataSchema).min(1)),
    candidateOutcomes: bound(z.array(CandidateOutcomeDataSchema).min(1)),
    preprocessingSha256: Sha256DigestSchema,
  })
  .superRefine((result, context) => {
    const rootBinding = canonicalJson(result.binding as JsonValue)
    for (const [field, value] of Object.entries({
      normalizedSpot: result.normalizedSpot,
      handFeatures: result.handFeatures,
      contestablePot: result.contestablePot,
      currentMetrics: result.currentMetrics,
      strategyProjection: result.strategyProjection,
      heuristicCandidateResult: result.heuristicCandidateResult,
      personaAdjustment: result.personaAdjustment,
      opponentEvidence: result.opponentEvidence,
      exploitAdjustment: result.exploitAdjustment,
      candidates: result.candidates,
      candidateOutcomes: result.candidateOutcomes,
    })) {
      if (canonicalJson(value.binding as JsonValue) !== rootBinding) {
        context.addIssue({
          code: 'custom',
          path: [field, 'binding'],
          message: '预处理组件 binding 必须与聚合根一致。',
        })
      }
    }

    const candidates = result.candidates.data
    const candidateIds = candidates.map(({ candidateId }) => candidateId)
    const candidateIdSet = new Set(candidateIds)
    const sum = (
      field: keyof Pick<
        (typeof candidates)[number],
        | 'baseWeightBasisPoints'
        | 'personaAdjustedWeightBasisPoints'
        | 'exploitAdjustedWeightBasisPoints'
      >,
    ) => candidates.reduce((total, candidate) => total + candidate[field], 0)
    if (
      candidateIdSet.size !== candidates.length ||
      sum('baseWeightBasisPoints') !== 10_000 ||
      sum('personaAdjustedWeightBasisPoints') !== 10_000 ||
      sum('exploitAdjustedWeightBasisPoints') !== 10_000 ||
      candidates.some(
        (candidate) =>
          candidate.weightBasisPoints !==
          candidate.exploitAdjustedWeightBasisPoints,
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['candidates', 'data'],
        message: '最终候选三阶段权重必须逐阶段守恒。',
      })
    }

    if (
      (result.candidateSource === 'heuristic') !==
      (result.heuristicCandidateResult.data !== null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['heuristicCandidateResult', 'data'],
        message: 'Heuristic 元数据与候选来源不一致。',
      })
    }

    if (
      (result.candidateSource === 'heuristic') !==
      (result.strategyProjection.data.status === 'unsupported')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['candidateSource'],
        message: '聚合候选来源必须与策略投影状态一致。',
      })
    }
    if (
      result.strategyPackRef.datasetId !==
        result.strategyProjection.data.datasetId ||
      result.strategyPackRef.datasetVersion !==
        result.strategyProjection.data.datasetVersion
    ) {
      context.addIssue({
        code: 'custom',
        path: ['strategyPackRef'],
        message: '策略包引用必须与策略投影数据集一致。',
      })
    }
    if (
      result.opponentEvidence.data.asOfEventSeq !==
        result.binding.asOfEventSeq ||
      result.exploitAdjustment.data.evidenceId !==
        result.opponentEvidence.data.evidenceId ||
      result.exploitAdjustment.data.asOfEventSeq !==
        result.opponentEvidence.data.asOfEventSeq ||
      result.exploitAdjustment.data.status !==
        result.opponentEvidence.data.status ||
      result.exploitAdjustment.data.reasonCode !==
        result.opponentEvidence.data.reasonCode
    ) {
      context.addIssue({
        code: 'custom',
        path: ['exploitAdjustment', 'data'],
        message: '利用调整必须与绑定时点及对手证据一致。',
      })
    }

    const strategySource: FactSourceRef =
      result.strategyProjection.data.status === 'unsupported'
        ? {
            kind: 'strategyPack',
            datasetId: result.strategyProjection.data.datasetId,
            datasetVersion: result.strategyProjection.data.datasetVersion,
            status: result.strategyProjection.data.status,
            reasonCode: result.strategyProjection.data.reasonCode,
          }
        : {
            kind: 'strategyRecord',
            datasetId: result.strategyProjection.data.datasetId,
            datasetVersion: result.strategyProjection.data.datasetVersion,
            recordId: result.strategyProjection.data.recordId,
            authorizationRef: result.strategyProjection.data.authorizationRef,
          }
    const expectedDirectSources: FactSourceRef[] = [strategySource]
    if (result.heuristicCandidateResult.data !== null) {
      expectedDirectSources.push({
        kind: 'heuristicPolicy',
        policyVersion:
          result.heuristicCandidateResult.data.heuristicCandidatePolicyVersion,
        confidence: result.heuristicCandidateResult.data.confidence,
        reasonCode: result.heuristicCandidateResult.data.reasonCode,
        unsupportedReasonCode:
          result.heuristicCandidateResult.data.unsupportedReasonCode,
      })
    }
    expectedDirectSources.push(
      {
        kind: 'personaSnapshot',
        configSnapshotKey: result.configSnapshotKey,
        personaId: result.personaId,
        personaVersion: result.personaVersion,
      },
      {
        kind: 'opponentEvidence',
        evidenceSchemaVersion:
          result.opponentEvidence.data.opponentEvidenceSchemaVersion,
        evidenceId: result.opponentEvidence.data.evidenceId,
        asOfEventSeq: result.opponentEvidence.data.asOfEventSeq,
      },
      {
        kind: 'exploitPolicy',
        policyVersion:
          result.exploitAdjustment.data.exploitAdjustmentPolicyVersion,
        evidenceId: result.exploitAdjustment.data.evidenceId,
        asOfEventSeq: result.exploitAdjustment.data.asOfEventSeq,
        status: result.exploitAdjustment.data.status,
        reasonCode: result.exploitAdjustment.data.reasonCode,
      },
    )
    if (
      candidates.some(
        (candidate) =>
          !sameUniqueSourceSet(candidate.sourceRefs, expectedDirectSources),
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['candidates', 'data'],
        message: '最终候选直接政策来源必须与各权威阶段唯一且逐值一致。',
      })
    }

    const stageCandidateIds = [
      result.personaAdjustment.data.candidates,
      result.exploitAdjustment.data.candidates,
      result.candidateOutcomes.data.map(({ candidate }) => candidate),
      ...(result.heuristicCandidateResult.data === null
        ? []
        : [result.heuristicCandidateResult.data.candidates]),
    ].map((entries) => entries.map(({ candidateId }) => candidateId))
    if (
      stageCandidateIds.some(
        (ids) =>
          ids.length !== candidateIds.length ||
          ids.some((id, index) => id !== candidateIds[index]),
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['candidates', 'data'],
        message: '预处理各阶段候选集合或顺序不一致。',
      })
    }

    const personaById = new Map(
      result.personaAdjustment.data.candidates.map((candidate) => [
        candidate.candidateId,
        candidate,
      ]),
    )
    const exploitById = new Map(
      result.exploitAdjustment.data.candidates.map((candidate) => [
        candidate.candidateId,
        candidate,
      ]),
    )
    const heuristicById = new Map(
      (result.heuristicCandidateResult.data?.candidates ?? []).map(
        (candidate) => [candidate.candidateId, candidate],
      ),
    )
    const strategyWeights =
      result.strategyProjection.data.status === 'unsupported'
        ? []
        : result.strategyProjection.data.candidateWeights
    const strategyWeightById = new Map(
      strategyWeights.map((candidate) => [
        candidate.candidateId,
        candidate.actionFrequencyBasisPoints,
      ]),
    )
    const strategyWeightsInvalid =
      result.candidateSource === 'strategy' &&
      (strategyWeightById.size !== strategyWeights.length ||
        strategyWeights.some(
          ({ candidateId }) => !candidateIdSet.has(candidateId),
        ) ||
        strategyWeights.reduce(
          (total, candidate) => total + candidate.actionFrequencyBasisPoints,
          0,
        ) !== 10_000)
    const candidateStageMismatch = candidates.some((candidate) => {
      const personaCandidate = personaById.get(candidate.candidateId)
      const exploitCandidate = exploitById.get(candidate.candidateId)
      const heuristicCandidate = heuristicById.get(candidate.candidateId)
      const expectedBaseWeight =
        result.candidateSource === 'heuristic'
          ? heuristicCandidate?.weightBasisPoints
          : (strategyWeightById.get(candidate.candidateId) ?? 0)
      const expectedRiskBand =
        result.candidateSource === 'heuristic'
          ? heuristicCandidate?.commitmentRiskBand
          : null
      return (
        candidate.source !== result.candidateSource ||
        candidate.baseWeightBasisPoints !== expectedBaseWeight ||
        candidate.personaAdjustedWeightBasisPoints !==
          personaCandidate?.weightBasisPoints ||
        candidate.exploitAdjustedWeightBasisPoints !==
          exploitCandidate?.weightBasisPoints ||
        candidate.weightBasisPoints !== exploitCandidate?.weightBasisPoints ||
        candidate.commitmentRiskBand !== expectedRiskBand ||
        personaCandidate === undefined ||
        exploitCandidate === undefined ||
        !samePolicyCandidate(candidate, personaCandidate) ||
        !samePolicyCandidate(candidate, exploitCandidate) ||
        (result.candidateSource === 'heuristic' &&
          (heuristicCandidate === undefined ||
            !samePolicyCandidate(candidate, heuristicCandidate) ||
            personaCandidate.commitmentRiskBand !== expectedRiskBand ||
            exploitCandidate.commitmentRiskBand !== expectedRiskBand)) ||
        (result.candidateSource === 'strategy' &&
          (personaCandidate.commitmentRiskBand !== undefined ||
            exploitCandidate.commitmentRiskBand !== undefined))
      )
    })
    if (strategyWeightsInvalid || candidateStageMismatch) {
      context.addIssue({
        code: 'custom',
        path: ['candidates', 'data'],
        message: '最终候选必须按 candidateId 与基础、人物及利用阶段逐项一致。',
      })
    }

    const outcomeById = new Map(
      result.candidateOutcomes.data.map((outcome) => [
        outcome.candidate.candidateId,
        outcome,
      ]),
    )
    if (
      candidates.some((candidate) => {
        const outcome = outcomeById.get(candidate.candidateId)
        return (
          outcome === undefined ||
          canonicalJson(candidate.action as JsonValue) !==
            canonicalJson(outcome.candidate.action as JsonValue) ||
          candidate.targetStreetCommitment !==
            outcome.candidate.targetStreetCommitment ||
          !projectedTargetMatches(
            candidate.targetStreetCommitment,
            outcome.targetStreetCommitment,
          ) ||
          candidate.contributionDelta !== outcome.contributionDelta
        )
      })
    ) {
      context.addIssue({
        code: 'custom',
        path: ['candidateOutcomes', 'data'],
        message:
          '最终候选 action、嵌套及投影 target 与 contributionDelta 必须按 candidateId 与 CandidateOutcome 一致。',
      })
    }

    const { preprocessingSha256, ...withoutHash } = result
    const expectedHash = createHash('sha256')
      .update(canonicalJson(withoutHash as JsonValue), 'utf8')
      .digest('hex')
    if (preprocessingSha256 !== expectedHash) {
      context.addIssue({
        code: 'custom',
        path: ['preprocessingSha256'],
        message: '预处理聚合哈希不匹配。',
      })
    }
  })

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

export type DecodedPlayerDecisionPreprocessingResult = Readonly<
  z.infer<typeof PlayerDecisionPreprocessingResultDataSchema>
>

export function decodeCurrentPlayerDecisionPreprocessingResult(
  input: unknown,
): DecodedPlayerDecisionPreprocessingResult {
  return deepFreeze(PlayerDecisionPreprocessingResultDataSchema.parse(input))
}
