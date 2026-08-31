import { createHash } from 'node:crypto'
import { z } from 'zod'
import { canonicalJson, type JsonValue } from '../../persisted-json.js'
import { POKER_RULE_SET_VERSION } from '../../poker/poker-rule-set.js'
import {
  StrategyPackReferenceSchema,
  type StrategyPackReference,
} from '../../poker-strategy/strategy-pack.js'
import {
  PlayerVisibleStateDataSchema,
  type PlayerVisibleState,
} from '../../sessions/authoritative-state/player-visible-state.js'
import { isPlayerVisibleState } from '../../sessions/authoritative-state/player-information-boundary-guard.js'
import { Sha256DigestSchema } from '../audit/audit-primitives.js'
import type { RuntimeComponentReference } from '../foundation/runtime-definition.js'
import {
  isRuntimeCommitAuthority,
  type RuntimeCommitAuthority,
} from '../foundation/runtime-ports.js'
import { PlayerDecisionAnalysisBindingSchema } from './player-decision-capabilities.js'
import {
  CandidateOutcomeDataSchema,
  FinalCandidateDataSchema,
  PlayerDecisionPreprocessingResultDataSchema,
} from './player-decision-preprocessing-schema.js'
import {
  isPlayerDecisionPreprocessingResult,
  type PlayerDecisionPreprocessingResult,
} from './player-decision-preprocessor.js'
import {
  FactSourceRefSchema,
  type FactSourceRef,
} from './player-fact-sources.js'
import {
  AgentMemoryPayloadV1Schema,
  hashPlayerSessionMemoryV1,
} from './player-session-memory.js'
import { samePlayerDecisionBinding } from './player-decision-analysis-input.js'

const SafeNonnegativeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
const RuntimeComponentReferenceSchema = z.strictObject({
  id: z.string().trim().min(1).max(128),
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
})

export const MODEL_FACT_REASON_CODES_V1 = [
  'noVersionedOpponentRange',
  'noJointResponseModel',
  'unsupportedStrategySpot',
  'insufficientEvidence',
  'noApprovedExploitBaseline',
  'noCallRequired',
  'preflopCurrentSprUndefined',
  'forcedRunout',
  'noRangeBasedBluffClassification',
  'noBetOnStreet',
  'noFullRaiseOnStreet',
  'noPriorPostflopStreet',
  'noFutureDecisionStreet',
  'pairHasNoRankGap',
  'notCurrentHandCategory',
  'insufficientRanks',
  'bettingRoundRemainsOpen',
  'handComplete',
  'wrongStreet',
  'notCallingAction',
  'notPureBluffCandidate',
  'noAuthorizedCoverage',
  'legalFallbackCandidate',
  'boundedPersonaTransfer',
  'requiredCandidateFamilyMissing',
  'candidateCapReached',
] as const

export const ModelFactReasonCodeV1Schema = z.enum(MODEL_FACT_REASON_CODES_V1)
export type ModelFactReasonCodeV1 = z.infer<typeof ModelFactReasonCodeV1Schema>

export const AuditFactManifestEntryV1Schema = z.strictObject({
  factId: z.string().regex(/^audit\.v1\.[a-z][a-zA-Z0-9]*$/),
  conceptId: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
  auditPath: z.string().trim().min(1).max(256),
  status: z.enum(['available', 'unavailable', 'notApplicable']),
  epistemicKind: z.enum([
    'ruleFact',
    'formulaFact',
    'datasetBaseline',
    'statisticalEvidence',
    'heuristicJudgment',
  ]),
  sourceRefs: z.array(FactSourceRefSchema).max(32),
  asOfEventSeq: SafeNonnegativeIntegerSchema,
  schemaRefs: z.array(RuntimeComponentReferenceSchema).max(8),
  algorithmRefs: z.array(RuntimeComponentReferenceSchema).max(8),
  dataRefs: z.array(RuntimeComponentReferenceSchema).max(8),
  assumptionCodes: z
    .array(
      z.enum([
        'ignoresFutureAction',
        'noVersionedOpponentRange',
        'noJointResponseModel',
        'currentHandEvidenceOnly',
      ]),
    )
    .max(4),
  reasonCode: ModelFactReasonCodeV1Schema.nullable(),
})

export type AuditFactManifestEntryV1 = Readonly<
  z.infer<typeof AuditFactManifestEntryV1Schema>
>

const PLAYER_FACT_MANIFEST_ENTRIES_V1 = [
  ['spotIdentity', 'preprocessing.normalizedSpot.data.spotKey', 'spot.street'],
  [
    'spotParticipants',
    'preprocessing.normalizedSpot.data.playerCounts',
    'spot.playerCounts',
  ],
  [
    'spotActionLine',
    'preprocessing.normalizedSpot.data.actionLine',
    'spot.actionLineCode',
  ],
  [
    'spotInitiative',
    'preprocessing.normalizedSpot.data.initiative',
    'spot.heroHasCurrentStreetInitiative',
  ],
  ['handVisibleCards', 'observation.hand', 'hand.heroHoleCards'],
  ['handMadeStructure', 'preprocessing.handFeatures.data', 'hand'],
  [
    'handDrawStructure',
    'preprocessing.handFeatures.data.structuralOutCards',
    'hand.structuralOutSummary',
  ],
  [
    'handAbsoluteNuts',
    'preprocessing.handFeatures.data.absoluteNuts',
    'hand.absoluteNuts',
  ],
  [
    'handCounterfeitRisk',
    'preprocessing.handFeatures.data.counterfeitRiskFacts',
    'hand.counterfeitRiskSummary',
  ],
  [
    'potContestable',
    'preprocessing.contestablePot.data.heroContestablePotBefore',
    'metrics.heroContestablePotBefore',
  ],
  [
    'metricsAmounts',
    'preprocessing.currentMetrics.data.amounts',
    'metrics.amountToCall',
  ],
  [
    'metricsPotOdds',
    'preprocessing.currentMetrics.data.potOdds',
    'metrics.potOdds',
  ],
  [
    'metricsCurrentSpr',
    'preprocessing.currentMetrics.data.currentSpr',
    'metrics.currentSpr',
  ],
  [
    'strategyPolicy',
    'preprocessing.strategyProjection.data',
    'policies.strategy',
  ],
  ['personaPolicy', 'preprocessing.personaAdjustment.data', 'policies.persona'],
  [
    'opponentEvidence',
    'preprocessing.opponentEvidence.data',
    'policies.opponentEvidence.status',
  ],
  [
    'exploitPolicy',
    'preprocessing.exploitAdjustment.data',
    'policies.opponentEvidence.exploitAdjustmentBasisPoints',
  ],
  ['candidateCatalog', 'preprocessing.candidates.data[]', 'candidates[]'],
  [
    'candidateWeights',
    'preprocessing.candidates.data[].exploitAdjustedWeightBasisPoints',
    'candidates[].exploitAdjustedWeightBasisPoints',
  ],
  [
    'candidateRiskBands',
    'preprocessing.candidates.data[].commitmentRiskBand',
    'candidates[].commitmentRiskBand',
  ],
  [
    'candidateAmountRisk',
    'preprocessing.candidateOutcomes.data[].amountActuallyAtRisk',
    'candidates[].outcome.amountActuallyAtRisk',
  ],
  [
    'candidateContestablePot',
    'preprocessing.candidateOutcomes.data[].heroContestablePotAfterAction',
    'candidates[].outcome.heroContestablePotAfterAction',
  ],
  [
    'candidateStackAfter',
    'preprocessing.candidateOutcomes.data[].heroStackAfterAction',
    'candidates[].outcome.heroStackAfterAction',
  ],
  [
    'candidateTerminalEffects',
    'preprocessing.candidateOutcomes.data[].handEndsByFold',
    'candidates[].outcome.booleanFlags',
  ],
  [
    'candidateResponders',
    'preprocessing.candidateOutcomes.data[].responders',
    'candidates[].outcome.responderCount',
  ],
  [
    'candidateRaiseResponders',
    'preprocessing.candidateOutcomes.data[].canRaiseSeats',
    'candidates[].outcome.canRaiseResponderCount',
  ],
  [
    'candidateProjectedSpr',
    'preprocessing.candidateOutcomes.data[].projectedFlopSpr',
    'candidates[].outcome.projectedFlopMaximumOpponentSpr',
  ],
  [
    'candidateCallThreshold',
    'preprocessing.candidateOutcomes.data[].minimumRequiredEquityForCall',
    'candidates[].outcome.minimumRequiredEquityForCall',
  ],
  [
    'candidateBluffThreshold',
    'preprocessing.candidateOutcomes.data[].pureBluffBreakEvenFoldRate',
    'candidates[].outcome.pureBluffBreakEvenFoldRate',
  ],
  [
    'candidateRangeEquityLimitation',
    'preprocessing.candidateOutcomes.data[].rangeConditionalEquity',
    'candidateLimitations.rangeConditionalEquity',
  ],
  [
    'candidateResponseLimitation',
    'preprocessing.candidateOutcomes.data[].opponentResponseProbability',
    'candidateLimitations.opponentResponseProbability',
  ],
  [
    'candidateValueLimitations',
    'preprocessing.candidateOutcomes.data[].expectedValue',
    'candidateLimitations.expectedValue',
  ],
] as const

export const PLAYER_FACT_MANIFEST_DESCRIPTOR_V1 = Object.freeze({
  descriptorVersion: 1,
  entries: Object.freeze(
    PLAYER_FACT_MANIFEST_ENTRIES_V1.map(([conceptId, auditPath, modelPath]) =>
      Object.freeze({ conceptId, auditPath, modelPath }),
    ),
  ),
})

export const PLAYER_FACT_CONCEPTS_V1 = Object.freeze(
  PLAYER_FACT_MANIFEST_DESCRIPTOR_V1.entries.map(({ conceptId }) => conceptId),
)

if (PLAYER_FACT_CONCEPTS_V1.length !== 32) {
  throw new TypeError('Player v1 事实目录必须精确包含 32 个概念。')
}

export const PlayerCandidateSetSnapshotV1Schema = z.strictObject({
  candidateSetSchemaVersion: z.literal(1),
  binding: PlayerDecisionAnalysisBindingSchema,
  candidateSource: z.enum(['strategy', 'heuristic']),
  candidates: z.array(FinalCandidateDataSchema).min(1).max(7),
  outcomes: z.array(CandidateOutcomeDataSchema).min(1).max(7),
  candidateSetSha256: Sha256DigestSchema,
})

export type PlayerCandidateSetSnapshotV1 = Readonly<
  z.infer<typeof PlayerCandidateSetSnapshotV1Schema>
>

export const PlayerSessionMemorySnapshotV1Schema = z
  .strictObject({
    memoryRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    payloadVersion: z.literal(1),
    payload: AgentMemoryPayloadV1Schema,
    memorySha256: Sha256DigestSchema,
    sourceAgentRunId: z.string().uuid(),
    sourceHandId: z.string().uuid(),
    sourceStateVersion: SafeNonnegativeIntegerSchema,
    decisionRequestId: z.string().uuid(),
    asOfEventSeq: SafeNonnegativeIntegerSchema,
  })
  .superRefine((memory, context) => {
    if (hashPlayerSessionMemoryV1(memory.payload) !== memory.memorySha256) {
      context.addIssue({
        code: 'custom',
        path: ['memorySha256'],
        message: 'Memory 审计快照摘要与 payload 不一致。',
      })
    }
  })

export type PlayerSessionMemorySnapshotV1 = Readonly<
  z.infer<typeof PlayerSessionMemorySnapshotV1Schema>
>

export const DecisionAuditSnapshotV1Schema = z.strictObject({
  decisionAuditSnapshotSchemaVersion: z.literal(1),
  binding: PlayerDecisionAnalysisBindingSchema,
  pokerRuleSetVersion: z.literal(POKER_RULE_SET_VERSION),
  observation: PlayerVisibleStateDataSchema,
  observationSha256: Sha256DigestSchema,
  preprocessing: PlayerDecisionPreprocessingResultDataSchema,
  preprocessingSha256: Sha256DigestSchema,
  strategyPackRef: StrategyPackReferenceSchema,
  personaRef: z.strictObject({
    configSnapshotKey: Sha256DigestSchema,
    personaId: z.string().trim().min(1).max(128),
    personaVersion: z.literal(1),
  }),
  opponentEvidenceRef: z.strictObject({
    evidenceSchemaVersion: z.literal(1),
    evidenceId: Sha256DigestSchema,
    asOfEventSeq: SafeNonnegativeIntegerSchema,
  }),
  sessionMemory: PlayerSessionMemorySnapshotV1Schema,
  candidates: PlayerCandidateSetSnapshotV1Schema,
  fullFactManifest: z
    .array(AuditFactManifestEntryV1Schema)
    .length(PLAYER_FACT_CONCEPTS_V1.length),
  snapshotSha256: Sha256DigestSchema,
})

export type DecisionAuditSnapshotV1Data = Readonly<
  z.infer<typeof DecisionAuditSnapshotV1Schema>
>

declare const decisionAuditSnapshotBrand: unique symbol
export type DecisionAuditSnapshotV1 = DecisionAuditSnapshotV1Data & {
  readonly [decisionAuditSnapshotBrand]: never
}

const certifiedSnapshots = new WeakSet<object>()

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

function sha256(value: JsonValue): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

function algorithmRef(id: string): RuntimeComponentReference {
  return Object.freeze({ id, version: 1 })
}

function sourceRefsForConcept(
  concept: (typeof PLAYER_FACT_CONCEPTS_V1)[number],
  preprocessing: DecisionAuditSnapshotV1Data['preprocessing'],
): readonly FactSourceRef[] {
  if (concept.startsWith('hand')) {
    return preprocessing.handFeatures.data.sourceRefs
  }
  if (concept.startsWith('pot')) {
    return preprocessing.contestablePot.data.sourceRefs
  }
  if (concept.startsWith('metrics')) {
    return preprocessing.currentMetrics.data.sourceRefs
  }
  if (concept === 'opponentEvidence' || concept === 'exploitPolicy') {
    return (
      preprocessing.candidates.data[0]?.sourceRefs.filter(
        ({ kind }) => kind === 'opponentEvidence' || kind === 'exploitPolicy',
      ) ?? []
    )
  }
  if (concept === 'strategyPolicy') {
    return (
      preprocessing.candidates.data[0]?.sourceRefs.filter(
        ({ kind }) => kind === 'strategyRecord' || kind === 'strategyPack',
      ) ?? []
    )
  }
  if (concept === 'personaPolicy') {
    return (
      preprocessing.candidates.data[0]?.sourceRefs.filter(
        ({ kind }) => kind === 'personaSnapshot' || kind === 'heuristicPolicy',
      ) ?? []
    )
  }
  if (concept.startsWith('candidate')) {
    return preprocessing.candidates.data[0]?.sourceRefs ?? []
  }
  return [
    {
      kind: 'observationField',
      observationSha256: preprocessing.binding.observationSha256,
      path: 'hand.publicActions',
      eventSeq: null,
    },
    { kind: 'algorithm', algorithmId: 'spotNormalizer', version: 1 },
  ]
}

type ManifestFactState = {
  readonly status: 'available' | 'unavailable' | 'notApplicable'
  readonly reasonCode?: string
  readonly epistemicKind?:
    | 'ruleFact'
    | 'formulaFact'
    | 'datasetBaseline'
    | 'statisticalEvidence'
    | 'heuristicJudgment'
  readonly sourceRefs?: readonly FactSourceRef[]
  readonly assumptionCodes?: readonly string[]
}

function factStatesForConcept(
  concept: (typeof PLAYER_FACT_CONCEPTS_V1)[number],
  preprocessing: DecisionAuditSnapshotV1Data['preprocessing'],
): readonly ManifestFactState[] {
  const hand = preprocessing.handFeatures.data
  const outcomes = preprocessing.candidateOutcomes.data
  switch (concept) {
    case 'handDrawStructure':
      return hand.kind === 'postflop'
        ? [hand.structuralOutCards]
        : [
            {
              status: 'notApplicable',
              reasonCode: 'wrongStreet',
              sourceRefs: hand.sourceRefs,
              assumptionCodes: [],
            },
          ]
    case 'handAbsoluteNuts':
      return hand.kind === 'postflop'
        ? [hand.absoluteNuts]
        : [
            {
              status: 'notApplicable',
              reasonCode: 'wrongStreet',
              sourceRefs: hand.sourceRefs,
              assumptionCodes: [],
            },
          ]
    case 'handCounterfeitRisk':
      return hand.kind === 'postflop'
        ? [hand.counterfeitRiskFacts]
        : [
            {
              status: 'notApplicable',
              reasonCode: 'wrongStreet',
              sourceRefs: hand.sourceRefs,
              assumptionCodes: [],
            },
          ]
    case 'metricsPotOdds':
      return [preprocessing.currentMetrics.data.potOdds]
    case 'metricsCurrentSpr':
      return [preprocessing.currentMetrics.data.currentSpr]
    case 'strategyPolicy':
      return preprocessing.strategyProjection.data.status === 'unsupported'
        ? [
            {
              status: 'unavailable',
              reasonCode: 'noAuthorizedCoverage',
              assumptionCodes: [],
            },
          ]
        : [
            {
              status: 'available',
              epistemicKind: 'datasetBaseline',
              assumptionCodes: [],
            },
          ]
    case 'opponentEvidence':
      return preprocessing.opponentEvidence.data.status === 'available'
        ? [
            {
              status: 'available',
              epistemicKind: 'statisticalEvidence',
              assumptionCodes: [],
            },
          ]
        : [
            {
              status: 'unavailable',
              reasonCode: 'insufficientEvidence',
              epistemicKind: 'statisticalEvidence',
              assumptionCodes: [],
            },
          ]
    case 'exploitPolicy':
      return [
        {
          status: 'unavailable',
          reasonCode: 'noApprovedExploitBaseline',
          epistemicKind: 'statisticalEvidence',
          assumptionCodes: [],
        },
      ]
    case 'candidateProjectedSpr':
      return outcomes.flatMap((outcome) => [
        outcome.projectedFlopSpr,
        outcome.nextStreetSpr,
      ])
    case 'candidateCallThreshold':
      return outcomes.map((outcome) => outcome.minimumRequiredEquityForCall)
    case 'candidateBluffThreshold':
      return outcomes.map((outcome) => outcome.pureBluffBreakEvenFoldRate)
    case 'candidateRangeEquityLimitation':
      return outcomes.map((outcome) => outcome.rangeConditionalEquity)
    case 'candidateResponseLimitation':
      return outcomes.map((outcome) => outcome.opponentResponseProbability)
    case 'candidateValueLimitations':
      return outcomes.flatMap((outcome) => [
        outcome.expectedValue,
        outcome.futureStreetValue,
        outcome.impliedOdds,
        outcome.foldEquity,
      ])
    default:
      return []
  }
}

function defaultEpistemicKind(
  concept: (typeof PLAYER_FACT_CONCEPTS_V1)[number],
): AuditFactManifestEntryV1['epistemicKind'] {
  if (concept === 'strategyPolicy') return 'datasetBaseline'
  if (concept === 'opponentEvidence' || concept === 'exploitPolicy') {
    return 'statisticalEvidence'
  }
  if (concept === 'personaPolicy') return 'heuristicJudgment'
  return 'formulaFact'
}

function selectManifestFactState(
  states: readonly ManifestFactState[],
): ManifestFactState | undefined {
  return (
    states.find(({ status }) => status === 'available') ??
    states.find(({ status }) => status === 'unavailable') ??
    states[0]
  )
}

function createFullFactManifest(
  preprocessing: DecisionAuditSnapshotV1Data['preprocessing'],
): readonly AuditFactManifestEntryV1[] {
  const asOfEventSeq = preprocessing.binding.asOfEventSeq
  const manifest = PLAYER_FACT_MANIFEST_DESCRIPTOR_V1.entries.map(
    ({ conceptId, auditPath }) => {
      const state = selectManifestFactState(
        factStatesForConcept(conceptId, preprocessing),
      )
      const status = state?.status ?? 'available'
      const reasonCode = status === 'available' ? null : state?.reasonCode
      if (status !== 'available' && reasonCode === undefined) {
        throw new RangeError('Player 事实状态缺少原因。')
      }
      return {
        factId: `audit.v1.${conceptId}`,
        conceptId,
        auditPath,
        status,
        epistemicKind: state?.epistemicKind ?? defaultEpistemicKind(conceptId),
        sourceRefs: [
          ...(state?.sourceRefs ??
            sourceRefsForConcept(conceptId, preprocessing)),
        ],
        asOfEventSeq,
        schemaRefs: [algorithmRef('player.decision-audit-snapshot')],
        algorithmRefs: [
          algorithmRef(
            conceptId.startsWith('candidate')
              ? 'player.candidate-outcome-projector'
              : conceptId.startsWith('hand')
                ? 'player.hand-feature-analyzer'
                : 'player.decision-preprocessing',
          ),
        ],
        dataRefs:
          conceptId === 'strategyPolicy'
            ? [
                algorithmRef(
                  `strategy-pack.${preprocessing.strategyPackRef.datasetId}`,
                ),
              ]
            : [],
        assumptionCodes: [...(state?.assumptionCodes ?? [])],
        reasonCode,
      }
    },
  )
  return deepFreeze(z.array(AuditFactManifestEntryV1Schema).parse(manifest))
}

function assertFullFactManifestMatchesDescriptor(
  manifest: readonly AuditFactManifestEntryV1[],
  preprocessing: DecisionAuditSnapshotV1Data['preprocessing'],
): void {
  const expected = createFullFactManifest(preprocessing)
  if (
    canonicalJson(manifest as unknown as JsonValue) !==
    canonicalJson(expected as unknown as JsonValue)
  ) {
    throw new RangeError('Player 完整事实清单与 descriptor 或真实状态不一致。')
  }
}

function assertCandidateSet(candidateSet: PlayerCandidateSetSnapshotV1): void {
  const ids = candidateSet.candidates.map(({ candidateId }) => candidateId)
  const outcomes = candidateSet.outcomes.map(
    ({ candidate }) => candidate.candidateId,
  )
  const sum = (
    field:
      | 'baseWeightBasisPoints'
      | 'personaAdjustedWeightBasisPoints'
      | 'exploitAdjustedWeightBasisPoints',
  ) => candidateSet.candidates.reduce((total, item) => total + item[field], 0)
  if (
    new Set(ids).size !== ids.length ||
    ids.length !== outcomes.length ||
    ids.some((id, index) => id !== outcomes[index]) ||
    sum('baseWeightBasisPoints') !== 10_000 ||
    sum('personaAdjustedWeightBasisPoints') !== 10_000 ||
    sum('exploitAdjustedWeightBasisPoints') !== 10_000
  ) {
    throw new RangeError('Player 候选审计快照不一致。')
  }
}

export function buildDecisionAuditSnapshotV1(input: {
  readonly observation: PlayerVisibleState
  readonly preprocessing: PlayerDecisionPreprocessingResult
  readonly strategyPackRef: StrategyPackReference
  readonly sessionMemory: PlayerSessionMemorySnapshotV1
}): DecisionAuditSnapshotV1 {
  if (
    !isPlayerVisibleState(input.observation) ||
    !isPlayerDecisionPreprocessingResult(input.preprocessing) ||
    !samePlayerDecisionBinding(
      input.preprocessing.binding,
      input.preprocessing.normalizedSpot.binding,
    ) ||
    input.observation.observationSha256 !==
      input.preprocessing.binding.observationSha256 ||
    input.strategyPackRef.datasetId !==
      input.preprocessing.strategyPackRef.datasetId ||
    input.strategyPackRef.datasetVersion !==
      input.preprocessing.strategyPackRef.datasetVersion ||
    input.sessionMemory.sourceHandId !== input.preprocessing.binding.handId ||
    input.sessionMemory.sourceStateVersion !==
      input.preprocessing.binding.stateVersion ||
    input.sessionMemory.decisionRequestId !==
      input.preprocessing.binding.decisionRequestId ||
    input.sessionMemory.asOfEventSeq !==
      input.preprocessing.binding.asOfEventSeq
  ) {
    throw new RangeError('Player 决策审计输入绑定不一致。')
  }
  const { observationSha256: certifiedObservationSha256, ...observationData } =
    input.observation
  const observation = PlayerVisibleStateDataSchema.parse(observationData)
  const preprocessing = PlayerDecisionPreprocessingResultDataSchema.parse(
    input.preprocessing,
  )
  const candidateWithoutHash = {
    candidateSetSchemaVersion: 1 as const,
    binding: preprocessing.binding,
    candidateSource: preprocessing.candidateSource,
    candidates: preprocessing.candidates.data,
    outcomes: preprocessing.candidateOutcomes.data,
  }
  const candidates = PlayerCandidateSetSnapshotV1Schema.parse({
    ...candidateWithoutHash,
    candidateSetSha256: sha256(candidateWithoutHash as unknown as JsonValue),
  })
  assertCandidateSet(candidates)
  const withoutHash = {
    decisionAuditSnapshotSchemaVersion: 1 as const,
    binding: preprocessing.binding,
    pokerRuleSetVersion: POKER_RULE_SET_VERSION,
    observation,
    observationSha256: certifiedObservationSha256,
    preprocessing,
    preprocessingSha256: preprocessing.preprocessingSha256,
    strategyPackRef: StrategyPackReferenceSchema.parse(input.strategyPackRef),
    personaRef: {
      configSnapshotKey: preprocessing.configSnapshotKey,
      personaId: preprocessing.personaId,
      personaVersion: preprocessing.personaVersion,
    },
    opponentEvidenceRef: {
      evidenceSchemaVersion:
        preprocessing.opponentEvidence.data.opponentEvidenceSchemaVersion,
      evidenceId: preprocessing.opponentEvidence.data.evidenceId,
      asOfEventSeq: preprocessing.opponentEvidence.data.asOfEventSeq,
    },
    sessionMemory: PlayerSessionMemorySnapshotV1Schema.parse(
      input.sessionMemory,
    ),
    candidates,
    fullFactManifest: createFullFactManifest(preprocessing),
  }
  const decoded = DecisionAuditSnapshotV1Schema.parse({
    ...withoutHash,
    snapshotSha256: sha256(withoutHash as unknown as JsonValue),
  })
  assertFullFactManifestMatchesDescriptor(
    decoded.fullFactManifest,
    decoded.preprocessing,
  )
  const result = deepFreeze(decoded as DecisionAuditSnapshotV1)
  certifiedSnapshots.add(result)
  return result
}

export function isDecisionAuditSnapshotV1(
  value: unknown,
): value is DecisionAuditSnapshotV1 {
  return (
    typeof value === 'object' && value !== null && certifiedSnapshots.has(value)
  )
}

export function certifyPersistedDecisionAuditSnapshotV1(input: {
  readonly snapshot: unknown
  readonly authority: RuntimeCommitAuthority<'player'>
  readonly expected: {
    readonly sessionId: string
    readonly handId: string
    readonly participantId: string
    readonly sourceStateVersion: number
    readonly decisionRequestId: string
  }
}): DecisionAuditSnapshotV1 {
  if (!isRuntimeCommitAuthority(input.authority, 'player')) {
    throw new RangeError('Player Decision 恢复 authority 无效。')
  }
  const decoded = DecisionAuditSnapshotV1Schema.parse(input.snapshot)
  const { candidateSetSha256, ...candidateWithoutHash } = decoded.candidates
  const { snapshotSha256, ...snapshotWithoutHash } = decoded
  assertFullFactManifestMatchesDescriptor(
    decoded.fullFactManifest,
    decoded.preprocessing,
  )
  if (
    decoded.binding.sessionId !== input.expected.sessionId ||
    decoded.binding.handId !== input.expected.handId ||
    decoded.binding.actorParticipantId !== input.expected.participantId ||
    decoded.binding.stateVersion !== input.expected.sourceStateVersion ||
    decoded.binding.decisionRequestId !== input.expected.decisionRequestId ||
    decoded.sessionMemory.sourceHandId !== input.expected.handId ||
    decoded.sessionMemory.sourceStateVersion !==
      input.expected.sourceStateVersion ||
    decoded.sessionMemory.decisionRequestId !==
      input.expected.decisionRequestId ||
    decoded.sessionMemory.asOfEventSeq !== decoded.binding.asOfEventSeq ||
    candidateSetSha256 !==
      sha256(candidateWithoutHash as unknown as JsonValue) ||
    snapshotSha256 !== sha256(snapshotWithoutHash as unknown as JsonValue)
  ) {
    throw new RangeError('Player Decision 持久化审计恢复认证失败。')
  }
  const certified = deepFreeze(decoded as DecisionAuditSnapshotV1)
  certifiedSnapshots.add(certified)
  return certified
}
