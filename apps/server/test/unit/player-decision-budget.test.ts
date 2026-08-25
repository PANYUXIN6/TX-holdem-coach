import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { canonicalJson, type JsonValue } from '../../src/persisted-json.js'
import {
  TOKEN_ESTIMATOR_REFERENCE,
  createContextPolicyDefinition,
  prepareContextEnvelope,
} from '../../src/agents/foundation/context-envelope.js'
import { createModelGateway } from '../../src/agents/foundation/model-gateway.js'
import type {
  ModelAttemptControlPort,
  ModelProviderAdapter,
} from '../../src/agents/foundation/model-gateway-protocol.js'
import { prepareModelRequest } from '../../src/agents/foundation/prompt-module.js'
import { issueRuntimeCommitAuthority } from '../../src/agents/foundation/runtime-ports.js'
import { createSensitiveValueScanner } from '../../src/agents/model-gateway/sensitive-value-scanner.js'
import { deepSeekPricingPolicy } from '../../src/agents/model-gateway/model-pricing-policy.js'
import { productionRuntimeRegistry } from '../../src/agents/production-runtime-registry.js'
import { PERSONA_MODEL_BUNDLE_DEFAULTS } from '../../src/personas/config.js'
import {
  createPlayerBoundedChoiceValidator,
  PlayerBoundedChoiceSchema,
  type PlayerBoundedChoiceV1,
} from '../../src/agents/player/player-bounded-choice.js'
import {
  PLAYER_CONTEXT_POLICY_REFERENCE,
  PLAYER_DECISION_CONTEXT_SECTION_REFERENCE,
  playerContextPolicy,
} from '../../src/agents/player/player-context-policy.js'
import {
  PLAYER_OUTPUT_SCHEMA_REFERENCE,
  PLAYER_VALIDATOR_REFERENCE,
  certifyPlayerPreparedGenerationBundleV1,
} from '../../src/agents/player/player-model-adapter-boundary-guard.js'
import {
  PlayerDecisionContextSectionV1Schema,
  buildPlayerModelProjectionV1,
  hashPlayerModelProjectionV1,
} from '../../src/agents/player/player-model-projection.js'
import { PLAYER_MODEL_INPUT_LIMITS } from '../../src/agents/player/player-model-input-limits.js'
import { certifyPlayerDecisionPacketV1 } from '../../src/agents/player/player-decision-packet-leak-guard.js'
import {
  playerRuntimeDefinition,
  playerRuntimeBudgetPolicy,
} from '../../src/agents/player/foundation-definition.js'
import {
  createPlayerPromptInvocations,
  playerPromptModules,
} from '../../src/agents/player/player-prompt-modules.js'
import { playerModelRoutePolicy } from '../../src/agents/player/route-policy.js'
import {
  createPlayerDecisionAuditFixture,
  createPlayerDecisionProjectionWorstCaseFixtureV1,
  createPlayerDecisionProjectionRepresentationalUpperBoundFixtureV1,
} from '../helpers/player-decision-packet-fixture.js'

const DECISION_ID = '90000000-0000-4000-8000-000000000001'
const budget = playerRuntimeBudgetPolicy.createSnapshot({
  runtimeType: 'player',
  attemptTimeoutSeconds: 15,
  decisionDeadlineSeconds: 45,
})

function prepareCorrectionBudgetFixture() {
  const { snapshot } = createPlayerDecisionAuditFixture({
    actorSeat: 3,
    actorStack: 1,
    withPublicAction: false,
  })
  const projection = buildPlayerModelProjectionV1(snapshot)
  const packet = certifyPlayerDecisionPacketV1({
    snapshot,
    decisionRecordId: DECISION_ID,
    projection,
  })
  const scanner = createSensitiveValueScanner()
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
          payload: packet as unknown as JsonValue,
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
  const bundle = certifyPlayerPreparedGenerationBundleV1({
    packet,
    context,
    request,
    outputSchemaReference: PLAYER_OUTPUT_SCHEMA_REFERENCE,
    outputSchema: PlayerBoundedChoiceSchema,
    validatorReference: PLAYER_VALIDATOR_REFERENCE,
    validate,
  })
  return { packet, scanner, bundle }
}

function hashMessages(
  messages: readonly { readonly role: string; readonly content: string }[],
): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        messages: messages.map((message) => ({ ...message })),
      }),
      'utf8',
    )
    .digest('hex')
}

function byteLengthMessages(
  messages: readonly { readonly role: string; readonly content: string }[],
): number {
  return Buffer.byteLength(
    canonicalJson({
      messages: messages.map((message) => ({ ...message })),
    }),
    'utf8',
  )
}

describe('M4.6 Player projection budget fixtures', () => {
  test('keeps the simultaneous-field-maximum worst-case under the input gates', () => {
    const prepareBudget = (
      projection: ReturnType<
        typeof createPlayerDecisionProjectionWorstCaseFixtureV1
      >,
    ) => {
      const projectionSha256 = hashPlayerModelProjectionV1(projection)
      const section = PlayerDecisionContextSectionV1Schema.parse({
        sectionSchemaVersion: 1,
        projection,
        projectionSha256,
      })
      const fixturePolicy = createContextPolicyDefinition({
        runtimeType: 'player',
        policy: PLAYER_CONTEXT_POLICY_REFERENCE,
        tokenEstimator: TOKEN_ESTIMATOR_REFERENCE,
        maximumSerializedBytes: PLAYER_MODEL_INPUT_LIMITS.maximumContextBytes,
        kinds: [
          {
            contextKind: 'decision',
            sections: [
              {
                sectionId: 'playerDecision',
                schema: PLAYER_DECISION_CONTEXT_SECTION_REFERENCE,
                parse: (value) =>
                  PlayerDecisionContextSectionV1Schema.parse(
                    value,
                  ) as JsonValue,
              },
            ],
          },
        ],
      })
      const scanner = createSensitiveValueScanner()
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
              contentVersion: projectionSha256,
            },
          ],
          sections: [
            {
              sectionId: 'playerDecision',
              schema: PLAYER_DECISION_CONTEXT_SECTION_REFERENCE,
              payload: section as unknown as JsonValue,
            },
          ],
        },
        policy: fixturePolicy,
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
        maximumRequestBytes:
          PLAYER_MODEL_INPUT_LIMITS.maximumWorstCaseInitialRequestBytes,
        maximumInputTokens: PLAYER_MODEL_INPUT_LIMITS.maximumRunInputTokens,
      })
      return { context, request }
    }
    const productionProjection =
      createPlayerDecisionProjectionWorstCaseFixtureV1()
    const projection =
      createPlayerDecisionProjectionRepresentationalUpperBoundFixtureV1()

    for (const candidate of [productionProjection, projection]) {
      const { context, request } = prepareBudget(candidate)
      expect(context.byteLength).toBeLessThanOrEqual(
        PLAYER_MODEL_INPUT_LIMITS.maximumContextBytes,
      )
      expect(request.byteLength).toBeLessThanOrEqual(
        PLAYER_MODEL_INPUT_LIMITS.maximumWorstCaseInitialRequestBytes,
      )
      expect(request.estimatedInputTokens).toBeLessThanOrEqual(
        PLAYER_MODEL_INPUT_LIMITS.maximumRunInputTokens,
      )
    }

    expect(productionProjection.spot.actionLineCode.split(';')).toHaveLength(
      1_025,
    )
    expect(productionProjection.candidates).toHaveLength(7)
    expect(projection.spot.actionLineCode.split(';')).toHaveLength(1_025)
    expect(projection.candidates).toHaveLength(7)
    expect(projection.factManifest).toHaveLength(32)
    expect(projection.versionCatalog).toHaveLength(16)
  })

  test('reaches the third accepted attempt inside the run input budget', async () => {
    const { packet, scanner, bundle } = prepareCorrectionBudgetFixture()
    const candidateActionId = packet.projection.candidates[0]![0]
    const adapterMessages: {
      readonly role: 'system' | 'user'
      readonly content: string
    }[][] = []
    let call = 0
    const adapter: ModelProviderAdapter = {
      provider: 'deepseek',
      async generate(input) {
        adapterMessages.push(input.messages.map((message) => ({ ...message })))
        call += 1
        if (call <= 2) {
          return {
            kind: 'success',
            value: {
              candidateActionId: 'unknown',
              summary: 'https://unsafe.example',
            },
            textProjection: 'x'.repeat(4_096),
            usage: { inputTokens: 100, outputTokens: 10 },
            finishReason: 'stop',
          }
        }
        return {
          kind: 'success',
          value: { candidateActionId },
          textProjection: JSON.stringify({ candidateActionId }),
          usage: { inputTokens: 100, outputTokens: 10 },
          finishReason: 'stop',
        }
      },
    }
    const starts: Parameters<
      ModelAttemptControlPort<PlayerBoundedChoiceV1>['startAttempt']
    >[0][] = []
    const finishes: Parameters<
      ModelAttemptControlPort<PlayerBoundedChoiceV1>['finishAttempt']
    >[0][] = []
    const control: ModelAttemptControlPort<PlayerBoundedChoiceV1> = {
      async startAttempt(input) {
        starts.push(input)
        return {
          kind: 'started',
          attemptId: `attempt-${String(starts.length)}`,
          actualTimeoutMs: 1_000,
          maximumOutputTokens: 256,
        }
      },
      async finishAttempt(input) {
        finishes.push(input)
        return 'recorded'
      },
    }
    const authority = issueRuntimeCommitAuthority({
      runtimeType: 'player',
      runId: '11111111-1111-4111-8111-111111111111',
      leaseOwner: 'm46-budget:player:0',
      fencingToken: 1,
    })
    const gateway = createModelGateway({
      adapter,
      registry: productionRuntimeRegistry,
    })
    const result = await gateway.generateStructured({
      runtimeType: 'player',
      runtimeDefinitionVersion: 1,
      authority,
      budget,
      routePolicy: playerModelRoutePolicy,
      pricingPolicy: deepSeekPricingPolicy,
      request: bundle.request,
      outputSchemaReference: bundle.outputSchemaReference,
      outputSchema: bundle.outputSchema,
      validate: bundle.validate,
      modelSelection: PERSONA_MODEL_BUNDLE_DEFAULTS,
      signal: new AbortController().signal,
      stage: 'player.bounded-choice',
      scanner,
      control,
    })

    expect(result).toEqual({
      kind: 'accepted',
      value: { candidateActionId },
      attempts: 3,
    })
    expect(
      adapterMessages.every(
        (messages) =>
          byteLengthMessages(messages) <=
          PLAYER_MODEL_INPUT_LIMITS.maximumRequestBytes,
      ),
    ).toBe(true)
    expect(
      starts.reduce((sum, entry) => sum + entry.estimatedInputTokens, 0),
    ).toBeLessThanOrEqual(PLAYER_MODEL_INPUT_LIMITS.maximumRunInputTokens)
    expect(adapterMessages.map(hashMessages)).toEqual(
      starts.map(({ requestProjectionHash }) => requestProjectionHash),
    )
    expect(finishes.map(({ validatedOutput }) => validatedOutput)).toEqual([
      null,
      null,
      { candidateActionId },
    ])
  })
})
