import type {
  CoreFactSourceRef,
  DecisionAnalysisInputPath,
  M45AlgorithmId,
  M45AssumptionCode,
  PokerRuleFactId,
} from '../../poker/decision-analysis-types.js'
import type { PokerRuleSetVersion } from '../../poker/poker-rule-set.js'
import { z } from 'zod'
import { POKER_RULE_SET_VERSION } from '../../poker/poker-rule-set.js'
import { Sha256DigestSchema } from '../audit/audit-primitives.js'
import type { PlayerDecisionAnalysisBinding } from './player-decision-analysis-input.js'

export type PlayerVisibleFactPath =
  | 'table.buttonSeatNumber'
  | 'table.seats'
  | 'hand.street'
  | 'hand.positions'
  | 'hand.startingStacks'
  | 'hand.heroHoleCards'
  | 'hand.board'
  | 'hand.pot'
  | 'hand.bettingRound'
  | 'hand.legalActions'
  | 'hand.publicActions'

export type FactSourceRef =
  | {
      readonly kind: 'observationField'
      readonly observationSha256: string
      readonly path: PlayerVisibleFactPath
      readonly eventSeq: number | null
    }
  | {
      readonly kind: 'ruleSet'
      readonly pokerRuleSetVersion: PokerRuleSetVersion
      readonly factId: PokerRuleFactId
    }
  | {
      readonly kind: 'algorithm'
      readonly algorithmId: M45AlgorithmId
      readonly version: 1
    }
  | {
      readonly kind: 'strategyRecord'
      readonly datasetId: string
      readonly datasetVersion: number
      readonly recordId: string
      readonly authorizationRef: string
    }
  | {
      readonly kind: 'strategyPack'
      readonly datasetId: string
      readonly datasetVersion: number
      readonly status: 'unsupported'
      readonly reasonCode: 'noAuthorizedCoverage'
    }
  | {
      readonly kind: 'heuristicPolicy'
      readonly policyVersion: 1
      readonly confidence: 'low'
      readonly reasonCode: 'legalFallbackCandidate'
      readonly unsupportedReasonCode: 'noAuthorizedCoverage'
    }
  | {
      readonly kind: 'personaSnapshot'
      readonly configSnapshotKey: string
      readonly personaId: string
      readonly personaVersion: 1
    }
  | {
      readonly kind: 'opponentEvidence'
      readonly evidenceSchemaVersion: 1
      readonly evidenceId: string
      readonly asOfEventSeq: number
    }
  | {
      readonly kind: 'exploitPolicy'
      readonly policyVersion: 1
      readonly evidenceId: string
      readonly asOfEventSeq: number
      readonly status: 'insufficientEvidence'
      readonly reasonCode: 'crossHandEvidenceUnavailable'
    }

const SafePositiveIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
const SafeNonnegativeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)

export const FactSourceRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('observationField'),
    observationSha256: Sha256DigestSchema,
    path: z.enum([
      'table.buttonSeatNumber',
      'table.seats',
      'hand.street',
      'hand.positions',
      'hand.startingStacks',
      'hand.heroHoleCards',
      'hand.board',
      'hand.pot',
      'hand.bettingRound',
      'hand.legalActions',
      'hand.publicActions',
    ]),
    eventSeq: SafeNonnegativeIntegerSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal('ruleSet'),
    pokerRuleSetVersion: z.literal(POKER_RULE_SET_VERSION),
    factId: z.enum([
      'nominalBlinds',
      'standard52CardUnknownUniverse',
      'bettingRoundProgression',
      'contributionLayering',
    ]),
  }),
  z.strictObject({
    kind: z.literal('algorithm'),
    algorithmId: z.enum([
      'spotNormalizer',
      'handFeatureAnalyzer',
      'contestablePotProjector',
      'decisionMetricsEngine',
      'legalCandidateFactory',
      'candidateOutcomeProjector',
    ]),
    version: z.literal(1),
  }),
  z.strictObject({
    kind: z.literal('strategyRecord'),
    datasetId: z.string().trim().min(1),
    datasetVersion: SafePositiveIntegerSchema,
    recordId: z.string().trim().min(1),
    authorizationRef: z.string().trim().min(1),
  }),
  z.strictObject({
    kind: z.literal('strategyPack'),
    datasetId: z.string().trim().min(1),
    datasetVersion: SafePositiveIntegerSchema,
    status: z.literal('unsupported'),
    reasonCode: z.literal('noAuthorizedCoverage'),
  }),
  z.strictObject({
    kind: z.literal('heuristicPolicy'),
    policyVersion: z.literal(1),
    confidence: z.literal('low'),
    reasonCode: z.literal('legalFallbackCandidate'),
    unsupportedReasonCode: z.literal('noAuthorizedCoverage'),
  }),
  z.strictObject({
    kind: z.literal('personaSnapshot'),
    configSnapshotKey: Sha256DigestSchema,
    personaId: z.string().trim().min(1),
    personaVersion: z.literal(1),
  }),
  z.strictObject({
    kind: z.literal('opponentEvidence'),
    evidenceSchemaVersion: z.literal(1),
    evidenceId: Sha256DigestSchema,
    asOfEventSeq: SafeNonnegativeIntegerSchema,
  }),
  z.strictObject({
    kind: z.literal('exploitPolicy'),
    policyVersion: z.literal(1),
    evidenceId: Sha256DigestSchema,
    asOfEventSeq: SafeNonnegativeIntegerSchema,
    status: z.literal('insufficientEvidence'),
    reasonCode: z.literal('crossHandEvidenceUnavailable'),
  }),
])

export interface PlayerDerivedFactShape {
  readonly assumptionCodes: readonly M45AssumptionCode[]
  readonly sourceRefs: readonly FactSourceRef[]
}

export type PlayerSourced<Value> = Value extends CoreFactSourceRef
  ? FactSourceRef
  : Value extends readonly (infer Item)[]
    ? readonly PlayerSourced<Item>[]
    : Value extends object
      ? { readonly [Key in keyof Value]: PlayerSourced<Value[Key]> }
      : Value

const PLAYER_PATH_BY_ANALYSIS_PATH = {
  'table.buttonSeatNumber': 'table.buttonSeatNumber',
  'table.seats': 'table.seats',
  'hand.street': 'hand.street',
  'hand.positions': 'hand.positions',
  'hand.startingStacks': 'hand.startingStacks',
  'hand.heroHoleCards': 'hand.heroHoleCards',
  'hand.board': 'hand.board',
  'hand.pot': 'hand.pot',
  'hand.bettingRound': 'hand.bettingRound',
  'hand.legalActions': 'hand.legalActions',
  'hand.publicActions': 'hand.publicActions',
} as const satisfies Record<DecisionAnalysisInputPath, PlayerVisibleFactPath>

export function mapCoreFactSource(
  source: CoreFactSourceRef,
  binding: PlayerDecisionAnalysisBinding,
): FactSourceRef {
  if (source.kind === 'analysisInputField') {
    const path = PLAYER_PATH_BY_ANALYSIS_PATH[source.path]
    if (path === undefined) {
      throw new RangeError('共享事实来源缺少 Player 白名单映射。')
    }
    return Object.freeze({
      kind: 'observationField',
      observationSha256: binding.observationSha256,
      path,
      eventSeq: source.eventSeq,
    })
  }
  return Object.freeze({ ...source })
}

function isCoreSourceRef(value: unknown): value is CoreFactSourceRef {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const kind = (value as { readonly kind?: unknown }).kind
  return (
    kind === 'analysisInputField' || kind === 'ruleSet' || kind === 'algorithm'
  )
}

export function mapCoreFactSourcesToPlayer<Value>(
  value: Value,
  binding: PlayerDecisionAnalysisBinding,
): PlayerSourced<Value> {
  const map = (current: unknown): unknown => {
    if (isCoreSourceRef(current)) return mapCoreFactSource(current, binding)
    if (Array.isArray(current)) return current.map(map)
    if (current !== null && typeof current === 'object') {
      return Object.fromEntries(
        Object.entries(current).map(([key, nested]) => [key, map(nested)]),
      )
    }
    return current
  }
  return map(value) as PlayerSourced<Value>
}
