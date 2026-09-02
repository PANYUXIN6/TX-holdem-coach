import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { createSensitiveValueScanner } from '../../src/agents/model-gateway/sensitive-value-scanner.js'
import { productionRuntimeRegistry } from '../../src/agents/production-runtime-registry.js'
import { prepareContextEnvelope } from '../../src/agents/foundation/context-envelope.js'
import { prepareModelRequest } from '../../src/agents/foundation/prompt-module.js'
import { buildPlayerDecisionAnalysisCore } from '../../src/agents/player/player-decision-analysis-core.js'
import { buildDecisionAuditSnapshotV1 } from '../../src/agents/player/player-decision-audit.js'
import {
  createPlayerBoundedChoiceValidator,
  PlayerBoundedChoiceSchema,
} from '../../src/agents/player/player-bounded-choice.js'
import {
  playerContextPolicy,
  PLAYER_DECISION_CONTEXT_SECTION_REFERENCE,
} from '../../src/agents/player/player-context-policy.js'
import { certifyPlayerDecisionPacketV1 } from '../../src/agents/player/player-decision-packet-leak-guard.js'
import type { PlayerDecisionReference } from '../../src/agents/player/player-decision-reference.js'
import { composePlayerDecisionPreprocessingResult } from '../../src/agents/player/player-decision-preprocessor.js'
import { buildPlayerOpponentEvidence } from '../../src/agents/player/player-opponent-evidence.js'
import { createFrozenPlayerModelInputV1 } from '../../src/agents/player/player-frozen-model-input.js'
import { PLAYER_MODEL_INPUT_LIMITS } from '../../src/agents/player/player-model-input-limits.js'
import {
  certifyPlayerPreparedGenerationBundleV1,
  PLAYER_OUTPUT_SCHEMA_REFERENCE,
  PLAYER_VALIDATOR_REFERENCE,
} from '../../src/agents/player/player-model-adapter-boundary-guard.js'
import {
  createPlayerPromptInvocations,
  playerPromptModules,
} from '../../src/agents/player/player-prompt-modules.js'
import { buildPlayerStrategyProjection } from '../../src/agents/player/player-strategy-projection.js'
import { playerModelRoutePolicy } from '../../src/agents/player/route-policy.js'
import { playerRuntimeDefinition } from '../../src/agents/player/foundation-definition.js'
import { certifyPlayerVisibleState } from '../../src/sessions/authoritative-state/player-information-boundary-guard.js'
import { buildPlayerObservationDraft } from '../../src/sessions/authoritative-state/player-observation-builder.js'
import {
  createConfigSnapshotKey,
  PERSONA_CONFIG_PAYLOAD_VERSION,
} from '../../src/personas/config.js'
import { loadAndValidatePersonaCatalog } from '../../src/personas/catalog.js'
import { EMPTY_AUTHORIZED_STRATEGY_PACK } from '../../src/poker-strategy/strategy-pack-repository.js'
import { gradeDeterministicPlayerScenario } from './graders/deterministic-grader.js'
import { gradePlayerSafety } from './graders/safety-grader.js'
import {
  executePlayerEvalScenario,
  buildPlayerEvalSessionMemory,
  readPlayerEvalScenarios,
} from './player-eval-scenarios.js'

const directory = dirname(fileURLToPath(import.meta.url))
const manifestSource = readFileSync(
  join(directory, 'player-eval-manifest-v1.json'),
  'utf8',
)
const ManifestSchema = z.strictObject({
  manifestVersion: z.literal(1),
  fingerprintSchemaVersion: z.literal(1),
  datasetVersion: z.literal('player-fixed-scenarios-v1'),
  graderVersion: z.literal('deterministic-v1'),
  pokerRuleSetVersion: z.literal('nlhe-cash-6to9-10-20-v1'),
  scenarioCount: z.literal(12),
})

const FINGERPRINT_FILES = [
  'player-eval-manifest-v1.json',
  'scenarios/player-fixed-scenarios-v1.json',
  'player-eval-scenarios.ts',
  'player-deterministic-eval-runner.ts',
  'graders/deterministic-grader.ts',
  'graders/safety-grader.ts',
  '../../src/poker/poker-rule-set.ts',
  '../../src/poker/decision-spot.ts',
  '../../src/poker/hand-features.ts',
  '../../src/poker/decision-metrics.ts',
  '../../src/poker/candidate-outcomes.ts',
  '../../src/poker/contestable-pot.ts',
  '../../src/poker/decision-analysis-core.ts',
  '../../src/poker/decision-analysis-input.ts',
  '../../src/poker/decision-candidates.ts',
  '../../src/poker/betting-projection.ts',
  '../../src/poker/poker-engine.ts',
  '../../src/sessions/authoritative-state/player-observation-builder.ts',
  '../../src/sessions/authoritative-state/player-information-boundary-guard.ts',
  '../../src/agents/foundation/model-route-policy.ts',
  '../../src/agents/foundation/model-gateway.ts',
  '../../src/agents/player/foundation-definition.ts',
  '../../src/agents/player/player-decision-analysis-core.ts',
  '../../src/agents/player/player-decision-policies.ts',
  '../../src/agents/player/player-decision-preprocessor.ts',
  '../../src/agents/player/player-strategy-projection.ts',
  '../../src/agents/player/player-opponent-evidence.ts',
  '../../src/agents/player/player-decision-audit.ts',
  '../../src/agents/player/player-model-projection.ts',
  '../../src/agents/player/player-decision-packet-leak-guard.ts',
  '../../src/agents/player/player-context-policy.ts',
  '../../src/agents/player/player-prompt-modules.ts',
  '../../src/agents/player/player-bounded-choice.ts',
  '../../src/agents/player/player-model-adapter-boundary-guard.ts',
  '../../src/agents/player/route-policy.ts',
  '../../src/agents/player/player-frozen-model-input.ts',
  '../../src/agents/player/player-session-memory.ts',
  '../../src/agents/player/player-commit-gate.ts',
  '../../src/agents/player/player-decision-validator.ts',
  '../../src/agents/model-gateway/model-pricing-policy.ts',
  '../../src/personas/catalog-definitions.ts',
  '../../src/personas/catalog.ts',
  '../../src/personas/config.ts',
  '../../src/poker-strategy/strategy-pack.ts',
  '../../src/poker-strategy/strategy-pack-repository.ts',
  '../../src/poker-strategy/strategy-projection.ts',
  '../../src/persistence/player-commit-gate-repository.ts',
  '../../src/sessions/command-execution/session-command-executor.ts',
] as const

function executionFingerprint(): string {
  const hash = createHash('sha256')
  for (const file of [...FINGERPRINT_FILES].sort()) {
    hash.update(file, 'utf8')
    hash.update('\0', 'utf8')
    hash.update(readFileSync(join(directory, file), 'utf8'), 'utf8')
    hash.update('\0', 'utf8')
  }
  return hash.digest('hex')
}

function referenceFor(
  observation: ReturnType<typeof certifyPlayerVisibleState>,
): PlayerDecisionReference {
  const persona = loadAndValidatePersonaCatalog().list()[0]
  if (persona === undefined) {
    throw new Error('player_deterministic_eval_persona_missing')
  }
  return Object.freeze({
    sessionId: observation.identity.sessionId,
    handId: observation.identity.handId,
    actorParticipantId: observation.identity.actorParticipantId,
    actorSeat: observation.identity.actorSeat,
    pokerRuleSetVersion: 'nlhe-cash-6to9-10-20-v1',
    handNumber: observation.hand.handNumber,
    configSnapshotKey: createConfigSnapshotKey(
      PERSONA_CONFIG_PAYLOAD_VERSION,
      persona,
    ),
    personaId: persona.personaId,
    personaVersion: 1,
    personaPolicy: { ...persona.style },
  })
}

export interface PlayerDeterministicEvalResult {
  readonly scenarioCount: number
  readonly fingerprint: string
  readonly scenarios: readonly {
    readonly scenarioId: string
    readonly passed: true
  }[]
}

export function runPlayerDeterministicEval(): PlayerDeterministicEvalResult {
  const manifest = ManifestSchema.parse(JSON.parse(manifestSource))
  const scenarios = readPlayerEvalScenarios()
  if (manifest.scenarioCount !== scenarios.length) {
    throw new Error('player_deterministic_eval_manifest_mismatch')
  }
  const scanner = createSensitiveValueScanner()
  const budget = playerRuntimeDefinition.budgetPolicy.createSnapshot({
    runtimeType: 'player',
    attemptTimeoutSeconds: 15,
    decisionDeadlineSeconds: 45,
  })
  const results = scenarios.map((scenario) => {
    const scenarioExecution = executePlayerEvalScenario(scenario)
    const observation = certifyPlayerVisibleState(
      buildPlayerObservationDraft(scenarioExecution.observation),
    )
    const reference = referenceFor(observation)
    const analysisCore = buildPlayerDecisionAnalysisCore({
      observation,
      reference,
    })
    const strategyProjection = buildPlayerStrategyProjection({
      analysisCore,
      strategyPack: EMPTY_AUTHORIZED_STRATEGY_PACK,
    })
    const memory = buildPlayerEvalSessionMemory(
      scenario,
      observation.identity.asOfEventSeq,
    )
    const opponentEvidence = buildPlayerOpponentEvidence({
      observation,
      reference,
      sessionMemory: memory,
    })
    const preprocessing = composePlayerDecisionPreprocessingResult({
      observation,
      reference,
      strategyPackRef: {
        datasetId: EMPTY_AUTHORIZED_STRATEGY_PACK.datasetId,
        datasetVersion: EMPTY_AUTHORIZED_STRATEGY_PACK.datasetVersion,
      },
      analysisCore,
      strategyProjection,
      opponentEvidence,
    })
    gradeDeterministicPlayerScenario({
      scenario,
      observation,
      preprocessing,
      forcedRunout: scenarioExecution.forcedRunout,
      sessionMemory: memory,
    })
    const snapshot = buildDecisionAuditSnapshotV1({
      observation,
      preprocessing,
      strategyPackRef: preprocessing.strategyPackRef,
      sessionMemory: {
        memoryRevision: memory.revision,
        payloadVersion: memory.payloadVersion,
        payload: memory.payload,
        memorySha256: memory.sha256,
        sourceAgentRunId: '11111111-1111-4111-8111-111111111149',
        sourceHandId: observation.identity.handId,
        sourceStateVersion: observation.identity.stateVersion,
        decisionRequestId: observation.identity.decisionRequestId,
        asOfEventSeq: memory.asOfEventSeq,
      },
    })
    const packet = certifyPlayerDecisionPacketV1({
      snapshot,
      decisionRecordId: '11111111-1111-4111-8111-111111111150',
    })
    const context = prepareContextEnvelope({
      envelope: {
        runtimeType: 'player',
        runtimeDefinitionVersion: 1,
        contextSchemaVersion: 1,
        contextKind: 'decision',
        promptModules: playerRuntimeDefinition.promptModules,
        sourceVersions: [
          {
            source: PLAYER_DECISION_CONTEXT_SECTION_REFERENCE,
            contentVersion: packet.projectionSha256,
          },
        ],
        sections: [
          {
            sectionId: 'playerDecision',
            schema: PLAYER_DECISION_CONTEXT_SECTION_REFERENCE,
            payload: packet,
          },
        ],
      },
      policy: playerContextPolicy,
      registry: productionRuntimeRegistry,
      budget,
      scanner,
    })
    const request = prepareModelRequest({
      runtimeType: 'player',
      runtimeDefinitionVersion: 1,
      context,
      modules: playerPromptModules,
      invocations: createPlayerPromptInvocations(),
      registry: productionRuntimeRegistry,
      scanner,
      maximumRequestBytes: PLAYER_MODEL_INPUT_LIMITS.maximumRequestBytes,
      maximumInputTokens: budget.maxInputTokens,
    })
    const validate = createPlayerBoundedChoiceValidator({ packet, scanner })
    certifyPlayerPreparedGenerationBundleV1({
      packet,
      context,
      request,
      outputSchemaReference: PLAYER_OUTPUT_SCHEMA_REFERENCE,
      outputSchema: PlayerBoundedChoiceSchema,
      validatorReference: PLAYER_VALIDATOR_REFERENCE,
      validate,
    })
    createFrozenPlayerModelInputV1({
      contextSha256: context.sha256,
      messages: request.messages,
      maximumRequestBytes: request.maximumRequestBytes,
      estimatedInputTokens: request.estimatedInputTokens,
      routePolicy: {
        policy: playerModelRoutePolicy.policy,
        pricingPolicy: playerModelRoutePolicy.pricingPolicy,
        provider: playerModelRoutePolicy.provider,
        maximumContentCorrections:
          playerModelRoutePolicy.maximumContentCorrections,
      },
      modelSelection: {
        modelId: 'deepseek-v4-flash',
        temperature: 0.2,
        maxOutputTokens: 256,
        thinkingMode: 'disabled',
      },
      outputSchema: PLAYER_OUTPUT_SCHEMA_REFERENCE,
      validator: PLAYER_VALIDATOR_REFERENCE,
    })
    gradePlayerSafety({ packet, context, request, validate })
    return Object.freeze({
      scenarioId: scenario.scenarioId,
      passed: true as const,
    })
  })
  return Object.freeze({
    scenarioCount: results.length,
    fingerprint: executionFingerprint(),
    scenarios: Object.freeze(results),
  })
}
