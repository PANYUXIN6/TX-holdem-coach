import { POKER_RULE_SET_VERSION } from '../../poker/poker-rule-set.js'
import { createDecisionAnalysisSchemas } from '../../poker/decision-analysis-schema.js'
import {
  AgentPersonaIdSchema,
  AgentPersonaStyleSchema,
} from '@tx-holdem-coach/contracts'
import { z } from 'zod'
import { canonicalJson, type JsonValue } from '../../persisted-json.js'
import { isLegalCandidateSemanticallyConsistent } from '../../poker/betting-projection.js'
import { PokerCommandSchema } from '../../poker/commands.js'
import {
  parseStrategyPack,
  StrategyPackSchema,
} from '../../poker-strategy/strategy-pack.js'
import type { PlayerVisibleState } from '../../sessions/authoritative-state/player-visible-state.js'
import { Sha256DigestSchema } from '../audit/audit-primitives.js'
import type { CapabilityDefinition } from '../foundation/capability-executor.js'
import type { RuntimeComponentReference } from '../foundation/runtime-definition.js'
import {
  buildPlayerDecisionAnalysisCore,
  isPlayerDecisionAnalysisCore,
} from './player-decision-analysis-core.js'
import { createPlayerDecisionAnalysisBinding } from './player-decision-analysis-input.js'
import { FactSourceRefSchema } from './player-fact-sources.js'
import { buildPlayerOpponentEvidence } from './player-opponent-evidence.js'
import {
  AgentMemoryPayloadV1Schema,
  decodePlayerSessionMemoryV1,
  hashPlayerSessionMemoryV1,
} from './player-session-memory.js'
import { buildPlayerStrategyProjection } from './player-strategy-projection.js'

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
const PlayerDecisionReferenceSchema = z.strictObject({
  sessionId: z.string().uuid(),
  handId: z.string().uuid(),
  actorParticipantId: z.string().uuid(),
  actorSeat: z.number().int().min(1).max(8),
  pokerRuleSetVersion: z.literal(POKER_RULE_SET_VERSION),
  handNumber: SafeNonnegativeIntegerSchema,
  configSnapshotKey: Sha256DigestSchema,
  personaId: AgentPersonaIdSchema,
  personaVersion: z.literal(1),
  personaPolicy: AgentPersonaStyleSchema,
})

export const PlayerDecisionAnalysisBindingSchema = z.strictObject({
  observationSchemaVersion: z.literal(1),
  observationSha256: Sha256DigestSchema,
  sessionId: z.string().uuid(),
  handId: z.string().uuid(),
  stateVersion: SafeNonnegativeIntegerSchema,
  decisionRequestId: z.string().uuid(),
  actorParticipantId: z.string().uuid(),
  actorSeat: z.number().int().min(1).max(8),
  asOfEventSeq: SafeNonnegativeIntegerSchema,
  pokerRuleSetVersion: z.literal(POKER_RULE_SET_VERSION),
})

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

export const {
  NormalizedDecisionSpotSchema,
  HandFeatureAnalysisSchema,
  ContestablePotProjectionSchema,
  DecisionMetricsSchema,
} = createDecisionAnalysisSchemas(FactSourceRefSchema)

export const PlayerComputeDecisionMetricsCapabilityInputSchema = z.strictObject(
  {
    observation: z.unknown(),
    reference: PlayerDecisionReferenceSchema,
  },
)

export const PlayerComputeDecisionMetricsCapabilityOutputSchema =
  z.strictObject({
    binding: PlayerDecisionAnalysisBindingSchema,
    data: z.strictObject({
      normalizedSpot: NormalizedDecisionSpotSchema,
      handFeatures: HandFeatureAnalysisSchema,
      contestablePot: ContestablePotProjectionSchema,
      currentMetrics: DecisionMetricsSchema,
      legalCandidates: z.array(LegalCandidateSchema),
    }),
  })

export const PlayerProjectStrategyCapabilityInputSchema = z.strictObject({
  analysisCore: z.unknown(),
  strategyPack: StrategyPackSchema,
})

const StrategyCandidateWeightSchema = z.strictObject({
  candidateId: z.string().trim().min(1),
  actionFrequencyBasisPoints: z.number().int().min(0).max(10_000),
  betSizePotRatio: z
    .strictObject({
      numerator: SafeNonnegativeIntegerSchema,
      denominator: SafePositiveIntegerSchema,
    })
    .nullable(),
  solverEv: z
    .strictObject({
      valueMilliBigBlinds: z.number().int(),
      sourceRef: z.string().trim().min(1),
    })
    .nullable(),
})

export const StrategyProjectionDataSchema = z.discriminatedUnion('status', [
  z.strictObject({
    strategyProjectionSchemaVersion: z.literal(1),
    status: z.literal('unsupported'),
    reasonCode: z.literal('noAuthorizedCoverage'),
    datasetId: z.string().trim().min(1),
    datasetVersion: SafePositiveIntegerSchema,
    candidateWeights: z.tuple([]),
  }),
  z.strictObject({
    strategyProjectionSchemaVersion: z.literal(1),
    status: z.enum(['exact', 'referenceOnly']),
    recordId: z.string().trim().min(1),
    datasetId: z.string().trim().min(1),
    datasetVersion: SafePositiveIntegerSchema,
    authorizationRef: z.string().trim().min(1),
    abstractionLossCodes: z.array(z.literal('boardTextureCollapsed')),
    candidateWeights: z.array(StrategyCandidateWeightSchema).min(1),
  }),
])

export const PlayerProjectStrategyCapabilityOutputSchema = z.strictObject({
  binding: PlayerDecisionAnalysisBindingSchema,
  data: StrategyProjectionDataSchema,
})

export const PlayerReadSessionMemoryCapabilityInputSchema = z.strictObject({
  binding: PlayerDecisionAnalysisBindingSchema,
  revision: SafeNonnegativeIntegerSchema.positive(),
  payloadVersion: z.literal(1),
  payload: AgentMemoryPayloadV1Schema,
  sha256: Sha256DigestSchema,
  asOfEventSeq: SafeNonnegativeIntegerSchema,
})

export const PlayerReadSessionMemoryCapabilityOutputSchema =
  PlayerReadSessionMemoryCapabilityInputSchema

export const PlayerProjectOpponentFeaturesCapabilityInputSchema =
  z.strictObject({
    observation: z.unknown(),
    reference: PlayerDecisionReferenceSchema,
    sessionMemory: PlayerReadSessionMemoryCapabilityOutputSchema,
  })

export const OpponentRateEvidenceSchema = z.strictObject({
  metric: z.enum([
    'preflopVoluntaryParticipation',
    'preflopFullRaise',
    'facingAggressionFold',
    'facingAggressionCall',
    'facingAggressionRaise',
    'currentStreetAggression',
  ]),
  numerator: SafeNonnegativeIntegerSchema,
  denominator: SafeNonnegativeIntegerSchema,
  distinctHandCount: SafeNonnegativeIntegerSchema,
  source: z.literal('currentHandAndSessionMemory'),
  memoryRevision: SafeNonnegativeIntegerSchema.positive(),
  historyAsOfEventSeq: SafeNonnegativeIntegerSchema,
  currentHandAsOfEventSeq: SafeNonnegativeIntegerSchema,
  confidence: z.enum(['insufficient', 'low', 'medium', 'high']),
  filterCode: z.string().trim().min(1),
  firstEventSeq: SafeNonnegativeIntegerSchema.nullable(),
  lastEventSeq: SafeNonnegativeIntegerSchema.nullable(),
})

export const OpponentEvidenceProjectionDataSchema = z.strictObject({
  opponentEvidenceSchemaVersion: z.literal(1),
  sourceScope: z.literal('currentHandAndSessionMemory'),
  memoryRevision: SafeNonnegativeIntegerSchema.positive(),
  historyAsOfEventSeq: SafeNonnegativeIntegerSchema,
  asOfEventSeq: SafeNonnegativeIntegerSchema,
  evidenceId: Sha256DigestSchema,
  status: z.enum(['insufficientEvidence', 'available']),
  reasonCode: z.literal('insufficientEvidence').nullable(),
  opponents: z.array(
    z.strictObject({
      participantId: z.string().uuid(),
      seatNumber: z.number().int().min(0).max(8),
      evidence: z.array(OpponentRateEvidenceSchema),
    }),
  ),
})

export const PlayerProjectOpponentFeaturesCapabilityOutputSchema =
  z.strictObject({
    binding: PlayerDecisionAnalysisBindingSchema,
    data: OpponentEvidenceProjectionDataSchema,
  })

export const PLAYER_COMPUTE_DECISION_METRICS_CAPABILITY = Object.freeze({
  id: 'player.compute-decision-metrics',
  version: 1,
} as const satisfies RuntimeComponentReference)

export const PLAYER_READ_SESSION_MEMORY_CAPABILITY = Object.freeze({
  id: 'player.read-session-memory',
  version: 1,
} as const satisfies RuntimeComponentReference)

export const PLAYER_PROJECT_STRATEGY_CAPABILITY = Object.freeze({
  id: 'player.project-strategy',
  version: 1,
} as const satisfies RuntimeComponentReference)

export const PLAYER_PROJECT_OPPONENT_FEATURES_CAPABILITY = Object.freeze({
  id: 'player.project-opponent-features',
  version: 1,
} as const satisfies RuntimeComponentReference)

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

function canonical<Value>(value: Value): Value {
  canonicalJson(value as unknown as JsonValue)
  return value
}

function parseObservationInput(input: unknown): JsonValue {
  const parsed = PlayerComputeDecisionMetricsCapabilityInputSchema.parse(input)
  const observation = parsed.observation as PlayerVisibleState
  const reference = deepFreeze(parsed.reference)
  createPlayerDecisionAnalysisBinding({ observation, reference })
  return canonical(
    deepFreeze({ observation, reference }) as unknown as JsonValue,
  )
}

function parseMemoryInput(input: unknown): JsonValue {
  const parsed = PlayerReadSessionMemoryCapabilityInputSchema.parse(input)
  if (hashPlayerSessionMemoryV1(parsed.payload) !== parsed.sha256) {
    throw new RangeError('Session Memory digest 与 payload 不一致。')
  }
  return canonical(deepFreeze(parsed) as unknown as JsonValue)
}

function parseOpponentInput(input: unknown): JsonValue {
  const parsed = PlayerProjectOpponentFeaturesCapabilityInputSchema.parse(input)
  const observation = parsed.observation as PlayerVisibleState
  const reference = deepFreeze(parsed.reference)
  createPlayerDecisionAnalysisBinding({ observation, reference })
  if (
    hashPlayerSessionMemoryV1(parsed.sessionMemory.payload) !==
    parsed.sessionMemory.sha256
  ) {
    throw new RangeError('Session Memory digest 与 payload 不一致。')
  }
  return canonical(
    deepFreeze({
      observation,
      reference,
      sessionMemory: parsed.sessionMemory,
    }) as unknown as JsonValue,
  )
}

function parseStrategyInput(input: unknown): JsonValue {
  const parsed = PlayerProjectStrategyCapabilityInputSchema.parse(input)
  if (!isPlayerDecisionAnalysisCore(parsed.analysisCore)) {
    throw new RangeError('策略能力只接受 Plan 重新认证的分析核心。')
  }
  const strategyPack = parseStrategyPack(parsed.strategyPack)
  const analysisCore = parsed.analysisCore
  return canonical(
    deepFreeze({ analysisCore, strategyPack }) as unknown as JsonValue,
  )
}

function parseOutput(
  schema:
    | typeof PlayerComputeDecisionMetricsCapabilityOutputSchema
    | typeof PlayerProjectStrategyCapabilityOutputSchema
    | typeof PlayerProjectOpponentFeaturesCapabilityOutputSchema
    | typeof PlayerReadSessionMemoryCapabilityOutputSchema,
  input: unknown,
): JsonValue {
  return canonical(schema.parse(input) as unknown as JsonValue)
}

export const playerReadSessionMemoryCapabilityDefinition = Object.freeze({
  runtimeType: 'player',
  capability: PLAYER_READ_SESSION_MEMORY_CAPABILITY,
  mode: 'readOnly',
  inputSchema: Object.freeze({
    id: 'player.capability.read-session-memory.input',
    version: 1,
  }),
  outputSchema: Object.freeze({
    id: 'player.capability.read-session-memory.output',
    version: 1,
  }),
  timeoutMs: 1_000,
  parseInput: parseMemoryInput,
  parseOutput: (input: unknown) =>
    parseOutput(PlayerReadSessionMemoryCapabilityOutputSchema, input),
  execute: async (input: JsonValue, signal: AbortSignal) => {
    throwIfAborted(signal)
    const parsed = PlayerReadSessionMemoryCapabilityInputSchema.parse(input)
    const payload = decodePlayerSessionMemoryV1(parsed.payload)
    if (hashPlayerSessionMemoryV1(payload) !== parsed.sha256) {
      throw new RangeError('Session Memory digest 与 payload 不一致。')
    }
    throwIfAborted(signal)
    return parsed as unknown as JsonValue
  },
} as const satisfies CapabilityDefinition<'player'>)

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('player_capability_cancelled')
}

export const playerComputeDecisionMetricsCapabilityDefinition = Object.freeze({
  runtimeType: 'player',
  capability: PLAYER_COMPUTE_DECISION_METRICS_CAPABILITY,
  mode: 'deterministicCompute',
  inputSchema: Object.freeze({
    id: 'player.capability.compute-decision-metrics.input',
    version: 1,
  }),
  outputSchema: Object.freeze({
    id: 'player.capability.compute-decision-metrics.output',
    version: 1,
  }),
  timeoutMs: 2_000,
  parseInput: parseObservationInput,
  parseOutput: (input: unknown) =>
    parseOutput(PlayerComputeDecisionMetricsCapabilityOutputSchema, input),
  execute: async (input: JsonValue, signal: AbortSignal) => {
    throwIfAborted(signal)
    const parsed = input as unknown as z.infer<
      typeof PlayerComputeDecisionMetricsCapabilityInputSchema
    >
    const output = buildPlayerDecisionAnalysisCore({
      observation: parsed.observation as PlayerVisibleState,
      reference: parsed.reference,
    })
    throwIfAborted(signal)
    return output as unknown as JsonValue
  },
} as const satisfies CapabilityDefinition<'player'>)

export const playerProjectStrategyCapabilityDefinition = Object.freeze({
  runtimeType: 'player',
  capability: PLAYER_PROJECT_STRATEGY_CAPABILITY,
  mode: 'deterministicCompute',
  inputSchema: Object.freeze({
    id: 'player.capability.project-strategy.input',
    version: 1,
  }),
  outputSchema: Object.freeze({
    id: 'player.capability.project-strategy.output',
    version: 1,
  }),
  timeoutMs: 1_000,
  parseInput: parseStrategyInput,
  parseOutput: (input: unknown) =>
    parseOutput(PlayerProjectStrategyCapabilityOutputSchema, input),
  execute: async (input: JsonValue, signal: AbortSignal) => {
    throwIfAborted(signal)
    const parsed = input as unknown as {
      readonly analysisCore: Parameters<
        typeof buildPlayerStrategyProjection
      >[0]['analysisCore']
      readonly strategyPack: Parameters<
        typeof buildPlayerStrategyProjection
      >[0]['strategyPack']
    }
    const output = buildPlayerStrategyProjection(parsed)
    if (
      output.data.datasetId !== parsed.strategyPack.datasetId ||
      output.data.datasetVersion !== parsed.strategyPack.datasetVersion
    ) {
      throw new RangeError('策略能力输出未绑定本次策略包。')
    }
    throwIfAborted(signal)
    return output as unknown as JsonValue
  },
} as const satisfies CapabilityDefinition<'player'>)

export const playerProjectOpponentFeaturesCapabilityDefinition = Object.freeze({
  runtimeType: 'player',
  capability: PLAYER_PROJECT_OPPONENT_FEATURES_CAPABILITY,
  mode: 'deterministicCompute',
  inputSchema: Object.freeze({
    id: 'player.capability.project-opponent-features.input',
    version: 1,
  }),
  outputSchema: Object.freeze({
    id: 'player.capability.project-opponent-features.output',
    version: 1,
  }),
  timeoutMs: 1_000,
  parseInput: parseOpponentInput,
  parseOutput: (input: unknown) =>
    parseOutput(PlayerProjectOpponentFeaturesCapabilityOutputSchema, input),
  execute: async (input: JsonValue, signal: AbortSignal) => {
    throwIfAborted(signal)
    const parsed = input as unknown as z.infer<
      typeof PlayerProjectOpponentFeaturesCapabilityInputSchema
    >
    const output = buildPlayerOpponentEvidence({
      observation: parsed.observation as PlayerVisibleState,
      reference: parsed.reference,
      sessionMemory: parsed.sessionMemory,
    })
    throwIfAborted(signal)
    return output as unknown as JsonValue
  },
} as const satisfies CapabilityDefinition<'player'>)

export const playerDecisionCapabilityDefinitions = Object.freeze([
  playerReadSessionMemoryCapabilityDefinition,
  playerComputeDecisionMetricsCapabilityDefinition,
  playerProjectStrategyCapabilityDefinition,
  playerProjectOpponentFeaturesCapabilityDefinition,
] as const satisfies readonly CapabilityDefinition<'player'>[])
