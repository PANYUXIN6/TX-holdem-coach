import { canonicalJson, type JsonValue } from '../../persisted-json.js'
import {
  parseStrategyPack,
  type StrategyPack,
} from '../../poker-strategy/strategy-pack.js'
import type { PlayerVisibleState } from '../../sessions/authoritative-state/player-visible-state.js'
import type {
  CapabilityExecutionControlPort,
  CapabilityExecutor,
} from '../foundation/capability-executor.js'
import { FoundationProtocolError } from '../foundation/errors.js'
import type { RuntimeCommitAuthority } from '../foundation/runtime-ports.js'
import type { RuntimeComponentReference } from '../foundation/runtime-definition.js'
import {
  PLAYER_COMPUTE_DECISION_METRICS_CAPABILITY,
  PLAYER_PROJECT_OPPONENT_FEATURES_CAPABILITY,
  PLAYER_PROJECT_STRATEGY_CAPABILITY,
  PLAYER_READ_SESSION_MEMORY_CAPABILITY,
  PlayerReadSessionMemoryCapabilityOutputSchema,
} from './player-decision-capabilities.js'
import type { CertifiedPlayerMemoryRevisionV1 } from '../../persistence/player-memory-repository.js'
import {
  buildPlayerDecisionAnalysisCore,
  type PlayerDecisionAnalysisCore,
} from './player-decision-analysis-core.js'
import {
  createPlayerDecisionAnalysisBinding,
  samePlayerDecisionBinding,
  type PlayerDecisionAnalysisBinding,
} from './player-decision-analysis-input.js'
import {
  composePlayerDecisionPreprocessingResult,
  type PlayerDecisionPreprocessingResult,
} from './player-decision-preprocessor.js'
import {
  buildPlayerOpponentEvidence,
  type PlayerOpponentEvidence,
} from './player-opponent-evidence.js'
import type { PlayerDecisionReference } from './player-decision-reference.js'
import {
  buildPlayerStrategyProjection,
  type PlayerStrategyProjection,
} from './player-strategy-projection.js'

export const PLAYER_DECISION_PREPROCESSING_CAPABILITY_ORDER = Object.freeze([
  PLAYER_READ_SESSION_MEMORY_CAPABILITY,
  PLAYER_COMPUTE_DECISION_METRICS_CAPABILITY,
  PLAYER_PROJECT_STRATEGY_CAPABILITY,
  PLAYER_PROJECT_OPPONENT_FEATURES_CAPABILITY,
] as const satisfies readonly RuntimeComponentReference[])

export interface ExecutePlayerDecisionPreprocessingPlanInput {
  readonly executor: CapabilityExecutor<'player'>
  readonly authority: RuntimeCommitAuthority<'player'>
  readonly control: CapabilityExecutionControlPort
  readonly signal: AbortSignal
  readonly observation: PlayerVisibleState
  readonly reference: PlayerDecisionReference
  readonly strategyPack: StrategyPack
  readonly sessionMemory: CertifiedPlayerMemoryRevisionV1
}

export interface PlayerDecisionPreprocessingPlan {
  readonly runtimeType: 'player'
  readonly capabilityOrder: typeof PLAYER_DECISION_PREPROCESSING_CAPABILITY_ORDER
  execute(
    input: ExecutePlayerDecisionPreprocessingPlanInput,
  ): Promise<PlayerDecisionPreprocessingResult>
}

interface BoundCapabilityResult {
  readonly binding: PlayerDecisionAnalysisBinding
  readonly data: unknown
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new FoundationProtocolError('capabilityCancelled')
  }
}

function assertCanonicalEqual(left: unknown, right: unknown): void {
  let leftJson: string
  let rightJson: string
  try {
    leftJson = canonicalJson(left as JsonValue)
    rightJson = canonicalJson(right as JsonValue)
  } catch {
    throw new RangeError('Capability 结果不是规范 JSON。')
  }
  if (leftJson !== rightJson) {
    throw new RangeError('Capability 结果与本次认证输入重建结果不一致。')
  }
}

function assertBoundResult(
  expectedBinding: PlayerDecisionAnalysisBinding,
  output: unknown,
): asserts output is BoundCapabilityResult {
  if (
    output === null ||
    typeof output !== 'object' ||
    Array.isArray(output) ||
    !('binding' in output) ||
    !('data' in output) ||
    !samePlayerDecisionBinding(
      expectedBinding,
      (output as { readonly binding: PlayerDecisionAnalysisBinding }).binding,
    )
  ) {
    throw new RangeError('Capability 结果 binding 与本次观察不一致。')
  }
  assertCanonicalEqual(
    (output as BoundCapabilityResult).binding,
    expectedBinding,
  )
}

function candidateCatalogOf(output: BoundCapabilityResult): unknown {
  if (
    output.data === null ||
    typeof output.data !== 'object' ||
    Array.isArray(output.data) ||
    !('legalCandidates' in output.data)
  ) {
    throw new RangeError('Capability 分析结果缺少候选目录。')
  }
  return (output.data as { readonly legalCandidates: unknown }).legalCandidates
}

function assertCompleteCandidateCatalog(
  expected: PlayerDecisionAnalysisCore['data']['legalCandidates'],
  actual: unknown,
): void {
  if (!Array.isArray(actual)) {
    throw new RangeError('Capability 候选目录无效。')
  }
  const candidateIds = new Set<unknown>()
  for (const candidate of actual) {
    if (
      candidate === null ||
      typeof candidate !== 'object' ||
      Array.isArray(candidate) ||
      !('candidateId' in candidate) ||
      candidateIds.has(candidate.candidateId)
    ) {
      throw new RangeError('Capability 候选目录存在无效或重复候选。')
    }
    candidateIds.add(candidate.candidateId)
  }
  assertCanonicalEqual(actual, expected)
}

function certifyComputeResult(input: {
  readonly expectedBinding: PlayerDecisionAnalysisBinding
  readonly output: unknown
  readonly rebuild: () => PlayerDecisionAnalysisCore
}): PlayerDecisionAnalysisCore {
  assertBoundResult(input.expectedBinding, input.output)
  const rebuilt = input.rebuild()
  assertCompleteCandidateCatalog(
    rebuilt.data.legalCandidates,
    candidateCatalogOf(input.output),
  )
  assertCanonicalEqual(input.output, rebuilt)
  return rebuilt
}

function certifyStrategyResult(input: {
  readonly expectedBinding: PlayerDecisionAnalysisBinding
  readonly expectedCatalog: PlayerDecisionAnalysisCore['data']['legalCandidates']
  readonly output: unknown
  readonly rebuild: () => PlayerStrategyProjection
}): PlayerStrategyProjection {
  assertBoundResult(input.expectedBinding, input.output)
  const rebuilt = input.rebuild()
  const weights = rebuilt.data.candidateWeights
  const legalIds = new Set<string>(
    input.expectedCatalog.map(({ candidateId }) => candidateId),
  )
  if (
    new Set(weights.map(({ candidateId }) => candidateId)).size !==
      weights.length ||
    weights.some(({ candidateId }) => !legalIds.has(candidateId))
  ) {
    throw new RangeError('Capability 策略结果引用了无效候选目录。')
  }
  assertCanonicalEqual(input.output, rebuilt)
  return rebuilt
}

function certifyOpponentResult(input: {
  readonly expectedBinding: PlayerDecisionAnalysisBinding
  readonly output: unknown
  readonly rebuild: () => PlayerOpponentEvidence
}): PlayerOpponentEvidence {
  assertBoundResult(input.expectedBinding, input.output)
  const rebuilt = input.rebuild()
  assertCanonicalEqual(input.output, rebuilt)
  return rebuilt
}

export async function executePlayerDecisionPreprocessingPlan(
  input: ExecutePlayerDecisionPreprocessingPlanInput,
): Promise<PlayerDecisionPreprocessingResult> {
  throwIfAborted(input.signal)
  const strategyPack = parseStrategyPack(input.strategyPack)
  const expectedBinding = createPlayerDecisionAnalysisBinding({
    observation: input.observation,
    reference: input.reference,
  })

  const memoryOutput = await input.executor.invoke<JsonValue>({
    runtimeType: 'player',
    authority: input.authority,
    capability: PLAYER_READ_SESSION_MEMORY_CAPABILITY,
    payload: {
      binding: expectedBinding,
      revision: input.sessionMemory.revision,
      payloadVersion: input.sessionMemory.payloadVersion,
      payload: input.sessionMemory.payload,
      sha256: input.sessionMemory.sha256,
      asOfEventSeq: input.sessionMemory.asOfEventSeq,
    },
    signal: input.signal,
    control: input.control,
  })
  throwIfAborted(input.signal)
  const parsedMemory =
    PlayerReadSessionMemoryCapabilityOutputSchema.safeParse(memoryOutput)
  if (
    !parsedMemory.success ||
    !samePlayerDecisionBinding(expectedBinding, parsedMemory.data.binding) ||
    parsedMemory.data.revision !== input.sessionMemory.revision ||
    parsedMemory.data.sha256 !== input.sessionMemory.sha256
  ) {
    throw new RangeError(
      'Session Memory Capability 返回值与本次 revision 不一致。',
    )
  }

  const computeOutput = await input.executor.invoke<JsonValue>({
    runtimeType: 'player',
    authority: input.authority,
    capability: PLAYER_COMPUTE_DECISION_METRICS_CAPABILITY,
    payload: { observation: input.observation, reference: input.reference },
    signal: input.signal,
    control: input.control,
  })
  throwIfAborted(input.signal)
  const analysisCore = certifyComputeResult({
    expectedBinding,
    output: computeOutput,
    rebuild: () =>
      buildPlayerDecisionAnalysisCore({
        observation: input.observation,
        reference: input.reference,
      }),
  })

  const strategyOutput = await input.executor.invoke<JsonValue>({
    runtimeType: 'player',
    authority: input.authority,
    capability: PLAYER_PROJECT_STRATEGY_CAPABILITY,
    payload: { analysisCore, strategyPack },
    signal: input.signal,
    control: input.control,
  })
  throwIfAborted(input.signal)
  const strategyProjection = certifyStrategyResult({
    expectedBinding,
    expectedCatalog: analysisCore.data.legalCandidates,
    output: strategyOutput,
    rebuild: () =>
      buildPlayerStrategyProjection({ analysisCore, strategyPack }),
  })

  const opponentOutput = await input.executor.invoke<JsonValue>({
    runtimeType: 'player',
    authority: input.authority,
    capability: PLAYER_PROJECT_OPPONENT_FEATURES_CAPABILITY,
    payload: {
      observation: input.observation,
      reference: input.reference,
      sessionMemory: parsedMemory.data,
    },
    signal: input.signal,
    control: input.control,
  })
  throwIfAborted(input.signal)
  const opponentEvidence = certifyOpponentResult({
    expectedBinding,
    output: opponentOutput,
    rebuild: () =>
      buildPlayerOpponentEvidence({
        observation: input.observation,
        reference: input.reference,
        sessionMemory: parsedMemory.data,
      }),
  })

  return composePlayerDecisionPreprocessingResult({
    observation: input.observation,
    reference: input.reference,
    strategyPackRef: {
      datasetId: strategyPack.datasetId,
      datasetVersion: strategyPack.datasetVersion,
    },
    analysisCore,
    strategyProjection,
    opponentEvidence,
  })
}

export const playerDecisionPreprocessingPlan = Object.freeze({
  runtimeType: 'player',
  capabilityOrder: PLAYER_DECISION_PREPROCESSING_CAPABILITY_ORDER,
  execute: executePlayerDecisionPreprocessingPlan,
} as const satisfies PlayerDecisionPreprocessingPlan)
