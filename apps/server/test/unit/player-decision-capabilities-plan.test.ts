import { describe, expect, test, vi } from 'vitest'
import {
  createCapabilityExecutor,
  type CapabilityExecutionControlPort,
  type CapabilityExecutor,
  type CapabilityInvocationAudit,
} from '../../src/agents/foundation/capability-executor.js'
import { issueRuntimeCommitAuthority } from '../../src/agents/foundation/runtime-ports.js'
import {
  PLAYER_COMPUTE_DECISION_METRICS_CAPABILITY,
  PLAYER_PROJECT_OPPONENT_FEATURES_CAPABILITY,
  PLAYER_PROJECT_STRATEGY_CAPABILITY,
  PLAYER_READ_SESSION_MEMORY_CAPABILITY,
  playerComputeDecisionMetricsCapabilityDefinition,
  playerDecisionCapabilityDefinitions,
} from '../../src/agents/player/player-decision-capabilities.js'
import {
  buildPlayerDecisionAnalysisCore,
  isPlayerDecisionAnalysisCore,
} from '../../src/agents/player/player-decision-analysis-core.js'
import {
  executePlayerDecisionPreprocessingPlan,
  PLAYER_DECISION_PREPROCESSING_CAPABILITY_ORDER,
} from '../../src/agents/player/player-decision-preprocessing-plan.js'
import { isPlayerDecisionPreprocessingResult } from '../../src/agents/player/player-decision-preprocessor.js'
import { isPlayerOpponentEvidence } from '../../src/agents/player/player-opponent-evidence.js'
import type { PlayerDecisionReference } from '../../src/agents/player/player-decision-reference.js'
import { isPlayerStrategyProjection } from '../../src/agents/player/player-strategy-projection.js'
import { playerRuntimeDefinition } from '../../src/agents/player/foundation-definition.js'
import type { JsonValue } from '../../src/persisted-json.js'
import {
  createConfigSnapshotKey,
  PERSONA_CONFIG_PAYLOAD_VERSION,
} from '../../src/personas/config.js'
import { loadAndValidatePersonaCatalog } from '../../src/personas/catalog.js'
import { EMPTY_AUTHORIZED_STRATEGY_PACK } from '../../src/poker-strategy/strategy-pack-repository.js'
import { buildPlayerObservationDraft } from '../../src/sessions/authoritative-state/player-observation-builder.js'
import { certifyPlayerVisibleState } from '../../src/sessions/authoritative-state/player-information-boundary-guard.js'
import type { PlayerVisibleState } from '../../src/sessions/authoritative-state/player-visible-state.js'
import { createPlayerObservationFixture } from '../helpers/player-observation-fixture.js'
import {
  decodePlayerSessionMemoryV1,
  hashPlayerSessionMemoryV1,
  PLAYER_EMPTY_SESSION_MEMORY_V1,
} from '../../src/agents/player/player-session-memory.js'
import type { CertifiedPlayerMemoryRevisionV1 } from '../../src/persistence/player-memory-repository.js'

type PlayerCapabilityInvocation = Parameters<
  CapabilityExecutor<'player'>['invoke']
>[0]

const authority = issueRuntimeCommitAuthority({
  runtimeType: 'player',
  runId: '11111111-1111-4111-8111-111111111111',
  leaseOwner: 'test:player:m45',
  fencingToken: 1,
})

function referenceFor(
  observation: PlayerVisibleState,
): PlayerDecisionReference {
  const persona = loadAndValidatePersonaCatalog().list()[0]!
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

function createInputs(): {
  readonly observation: PlayerVisibleState
  readonly reference: PlayerDecisionReference
} {
  const fixture = createPlayerObservationFixture({ withPublicAction: true })
  const observation = certifyPlayerVisibleState(
    buildPlayerObservationDraft(fixture.input),
  )
  return { observation, reference: referenceFor(observation) }
}

function createHarness(): {
  readonly executor: CapabilityExecutor<'player'>
  readonly control: CapabilityExecutionControlPort
  readonly reservedCapabilityIds: string[]
  readonly audits: CapabilityInvocationAudit[]
  readonly reserveInvocation: ReturnType<typeof vi.fn>
} {
  const reservedCapabilityIds: string[] = []
  const audits: CapabilityInvocationAudit[] = []
  let reservationSequence = 0
  const reserveInvocation = vi.fn(
    async (
      input: Parameters<CapabilityExecutionControlPort['reserveInvocation']>[0],
    ) => {
      reservedCapabilityIds.push(input.capability.id)
      reservationSequence += 1
      return {
        kind: 'reserved' as const,
        reservationId: `reservation-${String(reservationSequence)}`,
      }
    },
  )
  const control: CapabilityExecutionControlPort = {
    reserveInvocation,
    finishInvocation: async ({ audit }) => {
      audits.push(audit)
      return 'recorded'
    },
  }
  return {
    executor: createCapabilityExecutor({
      runtimeType: 'player',
      manifest: playerRuntimeDefinition.capabilityManifest,
      definitions: playerDecisionCapabilityDefinitions,
    }),
    control,
    reservedCapabilityIds,
    audits,
    reserveInvocation,
  }
}

function planInput(
  harness: ReturnType<typeof createHarness>,
  inputs: ReturnType<typeof createInputs>,
  executor: CapabilityExecutor<'player'> = harness.executor,
  sessionMemory: CertifiedPlayerMemoryRevisionV1 = memoryFor(inputs),
) {
  return {
    executor,
    authority,
    control: harness.control,
    signal: new AbortController().signal,
    observation: inputs.observation,
    reference: inputs.reference,
    strategyPack: EMPTY_AUTHORIZED_STRATEGY_PACK,
    sessionMemory,
  }
}

function memoryFor(
  inputs: ReturnType<typeof createInputs>,
  payload = PLAYER_EMPTY_SESSION_MEMORY_V1,
): CertifiedPlayerMemoryRevisionV1 {
  return Object.freeze({
    revision: 1,
    payloadVersion: 1,
    payload,
    sha256: hashPlayerSessionMemoryV1(payload),
    sourceAgentRunId: '11111111-1111-4111-8111-111111111148',
    sourceHandId: inputs.observation.identity.handId,
    sourceStateVersion: inputs.observation.identity.stateVersion,
    decisionRequestId: inputs.observation.identity.decisionRequestId,
    asOfEventSeq: inputs.observation.identity.asOfEventSeq,
  })
}

describe('Player decision capability definitions and plan', () => {
  test('publishes the fixed references, schemas, timeouts and immutable order', () => {
    expect(
      playerDecisionCapabilityDefinitions.map((definition) => ({
        capability: definition.capability,
        inputSchema: definition.inputSchema,
        outputSchema: definition.outputSchema,
        mode: definition.mode,
        timeoutMs: definition.timeoutMs,
      })),
    ).toEqual([
      {
        capability: PLAYER_READ_SESSION_MEMORY_CAPABILITY,
        inputSchema: {
          id: 'player.capability.read-session-memory.input',
          version: 1,
        },
        outputSchema: {
          id: 'player.capability.read-session-memory.output',
          version: 1,
        },
        mode: 'readOnly',
        timeoutMs: 1_000,
      },
      {
        capability: PLAYER_COMPUTE_DECISION_METRICS_CAPABILITY,
        inputSchema: {
          id: 'player.capability.compute-decision-metrics.input',
          version: 1,
        },
        outputSchema: {
          id: 'player.capability.compute-decision-metrics.output',
          version: 1,
        },
        mode: 'deterministicCompute',
        timeoutMs: 2_000,
      },
      {
        capability: PLAYER_PROJECT_STRATEGY_CAPABILITY,
        inputSchema: {
          id: 'player.capability.project-strategy.input',
          version: 1,
        },
        outputSchema: {
          id: 'player.capability.project-strategy.output',
          version: 1,
        },
        mode: 'deterministicCompute',
        timeoutMs: 1_000,
      },
      {
        capability: PLAYER_PROJECT_OPPONENT_FEATURES_CAPABILITY,
        inputSchema: {
          id: 'player.capability.project-opponent-features.input',
          version: 1,
        },
        outputSchema: {
          id: 'player.capability.project-opponent-features.output',
          version: 1,
        },
        mode: 'deterministicCompute',
        timeoutMs: 1_000,
      },
    ])
    expect(PLAYER_DECISION_PREPROCESSING_CAPABILITY_ORDER).toEqual([
      PLAYER_READ_SESSION_MEMORY_CAPABILITY,
      PLAYER_COMPUTE_DECISION_METRICS_CAPABILITY,
      PLAYER_PROJECT_STRATEGY_CAPABILITY,
      PLAYER_PROJECT_OPPONENT_FEATURES_CAPABILITY,
    ])
    expect(Object.isFrozen(playerDecisionCapabilityDefinitions)).toBe(true)
    expect(
      Object.isFrozen(PLAYER_DECISION_PREPROCESSING_CAPABILITY_ORDER),
    ).toBe(true)
  })

  test('executes Memory, compute, strategy and opponent capabilities in fixed order', async () => {
    const inputs = createInputs()
    const harness = createHarness()
    const cloneBrandChecks: boolean[] = []
    const observingExecutor: CapabilityExecutor<'player'> = {
      async invoke<TOutput extends JsonValue>(
        invocation: PlayerCapabilityInvocation,
      ): Promise<TOutput> {
        const output = await harness.executor.invoke<TOutput>(invocation)
        if (
          invocation.capability.id ===
          PLAYER_COMPUTE_DECISION_METRICS_CAPABILITY.id
        ) {
          cloneBrandChecks.push(isPlayerDecisionAnalysisCore(output))
        } else if (
          invocation.capability.id === PLAYER_PROJECT_STRATEGY_CAPABILITY.id
        ) {
          cloneBrandChecks.push(isPlayerStrategyProjection(output))
        } else if (
          invocation.capability.id ===
          PLAYER_PROJECT_OPPONENT_FEATURES_CAPABILITY.id
        ) {
          cloneBrandChecks.push(isPlayerOpponentEvidence(output))
        }
        return output
      },
    }

    const result = await executePlayerDecisionPreprocessingPlan(
      planInput(harness, inputs, observingExecutor, memoryFor(inputs)),
    )

    expect(isPlayerDecisionPreprocessingResult(result)).toBe(true)
    expect(cloneBrandChecks).toEqual([false, false, false])
    expect(harness.reservedCapabilityIds).toEqual([
      'player.read-session-memory',
      'player.compute-decision-metrics',
      'player.project-strategy',
      'player.project-opponent-features',
    ])
    expect(harness.audits).toHaveLength(4)
    expect(harness.audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          authorized: true,
          budgetCost: 1,
          inputSchemaVersion: 1,
          outputSchemaVersion: 1,
          errorCode: null,
        }),
      ]),
    )
  })

  test('将 Memory 的跨手样本合并到对手证据与置信度', async () => {
    const inputs = createInputs()
    const harness = createHarness()
    const opponent = inputs.observation.table.seats.find(
      ({ seatNumber }) => seatNumber !== inputs.observation.identity.actorSeat,
    )
    if (opponent === undefined) throw new Error('测试缺少对手座位。')
    const payload = {
      ...PLAYER_EMPTY_SESSION_MEMORY_V1,
      scannedThrough: {
        handNumber: inputs.observation.hand.handNumber,
        eventSeq: inputs.observation.identity.asOfEventSeq - 1,
      },
      lastCompletedHandNumber: inputs.observation.hand.handNumber,
      sessionSummary: { completedHandsObserved: 10, showdownHandsObserved: 0 },
      opponents: [
        {
          participantId: opponent.participantId,
          seatNumber: opponent.seatNumber,
          completedHandsObserved: 10,
          showdownHandsObserved: 0,
          metrics: [
            'preflopVoluntaryParticipation',
            'preflopFullRaise',
            'facingAggressionFold',
            'facingAggressionCall',
            'facingAggressionRaise',
            'currentStreetAggression',
          ].map((metric) => ({
            metric,
            numerator: metric === 'facingAggressionFold' ? 6 : 0,
            denominator: 10,
            distinctHandCount: 5,
          })),
        },
      ],
    }

    const result = await executePlayerDecisionPreprocessingPlan(
      planInput(
        harness,
        inputs,
        undefined,
        memoryFor(inputs, decodePlayerSessionMemoryV1(payload)),
      ),
    )
    const evidence = result.opponentEvidence.data.opponents
      .find(({ participantId }) => participantId === opponent.participantId)
      ?.evidence.find(({ metric }) => metric === 'facingAggressionFold')

    expect(evidence).toMatchObject({
      numerator: 6,
      denominator: 10,
      distinctHandCount: 5,
      confidence: 'low',
    })
    expect(result.opponentEvidence.data.sourceScope).toBe(
      'currentHandAndSessionMemory',
    )
  })

  test('rejects cloned wrappers before a downstream capability reservation', async () => {
    const inputs = createInputs()
    const harness = createHarness()
    const liveCore = buildPlayerDecisionAnalysisCore(inputs)

    await expect(
      harness.executor.invoke({
        runtimeType: 'player',
        authority,
        capability: PLAYER_PROJECT_STRATEGY_CAPABILITY,
        payload: {
          analysisCore: structuredClone(liveCore),
          strategyPack: EMPTY_AUTHORIZED_STRATEGY_PACK,
        },
        signal: new AbortController().signal,
        control: harness.control,
      }),
    ).rejects.toMatchObject({ failure: 'capabilitySchemaRejected' })
    expect(harness.reserveInvocation).not.toHaveBeenCalled()

    await expect(
      executePlayerDecisionPreprocessingPlan({
        ...planInput(harness, inputs),
        observation: structuredClone(inputs.observation) as PlayerVisibleState,
      }),
    ).rejects.toThrow(/认证观察/)
    expect(harness.reserveInvocation).not.toHaveBeenCalled()
  })

  test.each([
    {
      name: 'binding',
      mutate: (output: Record<string, unknown>) => {
        const binding = output.binding as Record<string, unknown>
        binding.decisionRequestId = '22222222-2222-4222-8222-222222222222'
      },
    },
    {
      name: 'candidate catalog',
      mutate: (output: Record<string, unknown>) => {
        const data = output.data as {
          legalCandidates: Record<string, unknown>[]
        }
        data.legalCandidates[0]!.targetKind = 'allIn'
      },
    },
  ])('rejects a tampered $name clone', async ({ mutate }) => {
    const inputs = createInputs()
    const harness = createHarness()
    const tamperingExecutor: CapabilityExecutor<'player'> = {
      async invoke<TOutput extends JsonValue>(
        invocation: PlayerCapabilityInvocation,
      ): Promise<TOutput> {
        const output = await harness.executor.invoke<TOutput>(invocation)
        if (
          invocation.capability.id ===
          PLAYER_COMPUTE_DECISION_METRICS_CAPABILITY.id
        ) {
          const tampered = structuredClone(output) as Record<string, unknown>
          mutate(tampered)
          return tampered as TOutput
        }
        return output
      },
    }

    await expect(
      executePlayerDecisionPreprocessingPlan(
        planInput(harness, inputs, tamperingExecutor),
      ),
    ).rejects.toThrow(/Capability/)
    expect(harness.reservedCapabilityIds).toEqual([
      'player.read-session-memory',
      'player.compute-decision-metrics',
    ])
  })

  test('rejects extra top-level input fields before audit reservation', async () => {
    const inputs = createInputs()
    const harness = createHarness()

    await expect(
      harness.executor.invoke({
        runtimeType: 'player',
        authority,
        capability: PLAYER_COMPUTE_DECISION_METRICS_CAPABILITY,
        payload: { ...inputs, injected: true },
        signal: new AbortController().signal,
        control: harness.control,
      }),
    ).rejects.toMatchObject({ failure: 'capabilitySchemaRejected' })
    expect(harness.reserveInvocation).not.toHaveBeenCalled()
  })

  test.each([
    {
      name: 'metric amount',
      mutate: (output: Record<string, unknown>) => {
        const data = output.data as {
          currentMetrics: { amounts: { amountToCall: unknown } }
        }
        data.currentMetrics.amounts.amountToCall = 'twenty'
      },
    },
    {
      name: 'player counts',
      mutate: (output: Record<string, unknown>) => {
        const data = output.data as {
          normalizedSpot: { playerCounts: unknown }
        }
        data.normalizedSpot.playerCounts = { injected: true }
      },
    },
    {
      name: 'fact source',
      mutate: (output: Record<string, unknown>) => {
        const data = output.data as {
          currentMetrics: { sourceRefs: unknown }
        }
        data.currentMetrics.sourceRefs = [{ injected: true }]
      },
    },
  ])(
    'rejects malformed nested compute $name during Executor parseOutput',
    async ({ mutate }) => {
      const inputs = createInputs()
      const harness = createHarness()
      const execute = vi.fn(async (input: JsonValue, signal: AbortSignal) => {
        const output =
          await playerComputeDecisionMetricsCapabilityDefinition.execute(
            input,
            signal,
          )
        const malformed = structuredClone(output) as unknown as Record<
          string,
          unknown
        >
        mutate(malformed)
        return malformed as unknown as JsonValue
      })
      const malformedExecutor = createCapabilityExecutor({
        runtimeType: 'player',
        manifest: playerRuntimeDefinition.capabilityManifest,
        definitions: [
          {
            ...playerComputeDecisionMetricsCapabilityDefinition,
            execute,
          },
        ],
      })

      await expect(
        malformedExecutor.invoke({
          runtimeType: 'player',
          authority,
          capability: PLAYER_COMPUTE_DECISION_METRICS_CAPABILITY,
          payload: inputs,
          signal: new AbortController().signal,
          control: harness.control,
        }),
      ).rejects.toMatchObject({ failure: 'capabilitySchemaRejected' })
      expect(execute).toHaveBeenCalledOnce()
      expect(harness.reserveInvocation).toHaveBeenCalledOnce()
      expect(harness.audits).toMatchObject([
        {
          errorCode: 'capabilitySchemaRejected',
          outputSchemaVersion: null,
          outputHash: null,
        },
      ])
    },
  )
})
