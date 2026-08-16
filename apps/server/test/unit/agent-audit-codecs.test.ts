import { describe, expect, test } from 'vitest'
import {
  AuditVersionReferenceSchema,
  CanonicalAuditReferenceIdSchema,
  Sha256DigestSchema,
  StableAuditCodeSchema,
} from '../../src/agents/audit/audit-primitives.js'
import {
  currentRunConfigurationAuditReader,
  decodeCurrentRunConfigurationAudit,
  encodeRunConfigurationAudit,
  RUN_CONFIGURATION_AUDIT_PAYLOAD_VERSION,
} from '../../src/agents/audit/run-configuration-audit-codec.js'
import {
  currentExecutionBudgetAuditReader,
  decodeCurrentExecutionBudgetAudit,
  encodeExecutionBudgetAudit,
  EXECUTION_BUDGET_AUDIT_PAYLOAD_VERSION,
} from '../../src/agents/audit/execution-budget-audit-codec.js'
import {
  ATTEMPT_AUDIT_PAYLOAD_VERSION,
  decodeCurrentAttemptAudit,
  encodeAttemptAudit,
  readCurrentAttemptAudit,
} from '../../src/agents/audit/attempt-audit-codec.js'
import {
  EMPTY_COACH_RUNTIME_AUDIT,
  EMPTY_PLAYER_RUNTIME_AUDIT,
  type AgentAuditDecoderBundle,
  type CoachRuntimeAuditShape,
  type PlayerRuntimeAuditDecodeInput,
  type PlayerRuntimeAuditShape,
  type RuntimeAuditExtensionDecoder,
} from '../../src/agents/audit/runtime-audit-extension-decoder.js'

describe('agent audit primitives', () => {
  test('accepts only canonical audit references, stable codes and normalized SHA-256 digests', () => {
    expect(CanonicalAuditReferenceIdSchema.parse('player/runtime:v1')).toBe(
      'player/runtime:v1',
    )
    expect(StableAuditCodeSchema.parse('provider_timeout')).toBe(
      'provider_timeout',
    )
    expect(Sha256DigestSchema.parse('a'.repeat(64))).toBe('a'.repeat(64))
    expect(
      AuditVersionReferenceSchema.parse({
        id: 'prompt/player@base',
        version: 3,
      }),
    ).toEqual({ id: 'prompt/player@base', version: 3 })

    for (const reference of [
      '',
      ' Player/runtime',
      'player/runtime ',
      '_player',
      'player_',
      'PLAYER',
      'a'.repeat(129),
    ]) {
      expect(CanonicalAuditReferenceIdSchema.safeParse(reference).success).toBe(
        false,
      )
    }
    for (const code of [
      '',
      'ProviderTimeout',
      'provider-timeout',
      'a'.repeat(65),
    ]) {
      expect(StableAuditCodeSchema.safeParse(code).success).toBe(false)
    }
    expect(Sha256DigestSchema.safeParse('A'.repeat(64)).success).toBe(false)
    expect(
      AuditVersionReferenceSchema.safeParse({
        id: 'prompt/player@base',
        version: 0,
      }).success,
    ).toBe(false)
    expect(
      AuditVersionReferenceSchema.safeParse({
        id: 'prompt/player@base',
        version: 3,
        secret: 'forbidden',
      }).success,
    ).toBe(false)
  })
})

function runConfigurationInput() {
  return {
    runtime: 'player' as const,
    runtimeDefinitionVersion: 4,
    contextSchemaVersion: 2,
    promptModules: [
      { id: 'prompt/player@system', version: 3 },
      { id: 'prompt/player@persona', version: 7 },
    ],
    capabilityManifest: { id: 'capability/player', version: 5 },
    capabilities: [
      { id: 'capability/equity', version: 2 },
      { id: 'capability/range', version: 1 },
    ],
    routePolicy: { id: 'route/player', version: 3 },
    outputSchema: { id: 'output/player-decision', version: 2 },
    validator: { id: 'validator/player-decision', version: 6 },
    commitGate: { id: 'commit/player-action', version: 3 },
    recoveryPolicy: { id: 'recovery/player', version: 1 },
    dataDependencies: [
      { id: 'strategy/preflop', version: 8 },
      { id: 'persona/nit_fish', version: 2 },
    ],
  }
}

describe('current run configuration audit', () => {
  test('round-trips only frozen, ordered and uniquely identified configuration references', () => {
    const configuration = runConfigurationInput()

    const encoded = encodeRunConfigurationAudit(configuration)

    expect(RUN_CONFIGURATION_AUDIT_PAYLOAD_VERSION).toBe(1)
    expect(encoded).toEqual({
      payloadVersion: 1,
      payload: {
        configuration,
      },
    })
    expect(
      decodeCurrentRunConfigurationAudit(structuredClone(encoded)),
    ).toEqual(encoded)
    expect(Object.isFrozen(encoded.payload.configuration.promptModules)).toBe(
      true,
    )
    expect(
      encoded.payload.configuration.promptModules.map(({ id }) => id),
    ).toEqual(['prompt/player@system', 'prompt/player@persona'])

    expect(() =>
      encodeRunConfigurationAudit({
        ...configuration,
        promptModules: [
          configuration.promptModules[0],
          configuration.promptModules[0],
        ],
      }),
    ).toThrow('Agent 审计载荷无效。')
    expect(() =>
      encodeRunConfigurationAudit({
        ...configuration,
        apiKey: 'secret',
      }),
    ).toThrow('Agent 审计载荷无效。')
  })

  test('reads the current configuration and classifies unknown or damaged rows', () => {
    const current = encodeRunConfigurationAudit(runConfigurationInput())

    expect(
      currentRunConfigurationAuditReader.read(
        current.payloadVersion,
        current.payload,
      ),
    ).toEqual({ kind: 'decoded', value: current.payload.configuration })
    expect(currentRunConfigurationAuditReader.read(2, current.payload)).toEqual(
      { kind: 'unknownVersion' },
    )
    expect(
      currentRunConfigurationAuditReader.read('1', current.payload),
    ).toEqual({ kind: 'invalidPayload' })
    expect(
      currentRunConfigurationAuditReader.read(1, { configuration: {} }),
    ).toEqual({ kind: 'invalidPayload' })
    expect(Object.isFrozen(currentRunConfigurationAuditReader)).toBe(true)
  })
})

function executionBudgetInput() {
  return {
    budgetSchemaVersion: 1 as const,
    maxAttempts: 3,
    maxInputTokens: 20_000,
    maxOutputTokens: 1_000,
    maxWallClockMs: 45_000,
    maxCapabilityInvocations: 4,
    maxCostMicrounits: 25_000,
    maxOwnerConcurrentRuns: 2,
    maxSystemConcurrentRuns: 4,
    minimumAttemptStartRemainingMs: 5_000,
    attemptTimeoutMs: 15_000,
  }
}

describe('current execution budget audit', () => {
  test('round-trips the complete frozen execution budget', () => {
    const budget = executionBudgetInput()

    const encoded = encodeExecutionBudgetAudit(budget)

    expect(EXECUTION_BUDGET_AUDIT_PAYLOAD_VERSION).toBe(1)
    expect(encoded).toEqual({
      payloadVersion: 1,
      payload: {
        budget,
      },
    })
    expect(decodeCurrentExecutionBudgetAudit(structuredClone(encoded))).toEqual(
      encoded,
    )
    expect(Object.isFrozen(encoded.payload.budget)).toBe(true)

    expect(() =>
      encodeExecutionBudgetAudit({ ...budget, maxAttempts: 0 }),
    ).toThrow('Agent 审计载荷无效。')
    expect(() =>
      encodeExecutionBudgetAudit({ ...budget, providerApiKey: 'secret' }),
    ).toThrow('Agent 审计载荷无效。')
  })

  test('reads only the current row version and classifies invalid payloads', () => {
    const budget = executionBudgetInput()
    const current = encodeExecutionBudgetAudit(budget)

    expect(
      currentExecutionBudgetAuditReader.read(
        current.payloadVersion,
        current.payload,
      ),
    ).toEqual({ kind: 'decoded', value: budget })
    expect(currentExecutionBudgetAuditReader.read(2, current.payload)).toEqual({
      kind: 'unknownVersion',
    })
    expect(currentExecutionBudgetAuditReader.read(1, { budget: {} })).toEqual({
      kind: 'invalidPayload',
    })
    expect(Object.isFrozen(currentExecutionBudgetAuditReader)).toBe(true)
  })
})

const requestProjectionHash = '1'.repeat(64)
const responseProjectionHash = '2'.repeat(64)
const attemptStartFacts = {
  actualTimeoutMs: 15_000,
  remainingDeadlineMsAtStart: 44_000,
  requestProjectionHash,
}

describe('current attempt audit', () => {
  test('strictly discriminates started and terminal payloads by the row lifecycle', () => {
    const attempts = [
      { lifecycle: 'started' as const, ...attemptStartFacts },
      {
        lifecycle: 'completed' as const,
        ...attemptStartFacts,
        responseProjectionHash,
        validationStatus: 'valid' as const,
      },
      {
        lifecycle: 'failed' as const,
        ...attemptStartFacts,
        responseProjectionHash: null,
        validationStatus: 'invalid' as const,
      },
      {
        lifecycle: 'cancelled' as const,
        ...attemptStartFacts,
        responseProjectionHash: null,
        validationStatus: 'notRun' as const,
      },
      {
        lifecycle: 'stale' as const,
        ...attemptStartFacts,
        responseProjectionHash,
        validationStatus: 'valid' as const,
      },
    ]

    expect(ATTEMPT_AUDIT_PAYLOAD_VERSION).toBe(1)
    for (const attempt of attempts) {
      const encoded = encodeAttemptAudit(attempt)
      expect(decodeCurrentAttemptAudit(structuredClone(encoded))).toEqual(
        encoded,
      )
      expect(Object.isFrozen(encoded.payload)).toBe(true)
    }

    expect(() =>
      encodeAttemptAudit({
        lifecycle: 'started',
        ...attemptStartFacts,
        responseProjectionHash,
      }),
    ).toThrow('Agent 审计载荷无效。')
    expect(() =>
      encodeAttemptAudit({
        lifecycle: 'completed',
        ...attemptStartFacts,
        responseProjectionHash: null,
        validationStatus: 'valid',
      }),
    ).toThrow('Agent 审计载荷无效。')
    expect(() =>
      encodeAttemptAudit({
        lifecycle: 'failed',
        ...attemptStartFacts,
        responseProjectionHash: null,
        validationStatus: 'valid',
      }),
    ).toThrow('Agent 审计载荷无效。')
    expect(() =>
      encodeAttemptAudit({
        lifecycle: 'cancelled',
        ...attemptStartFacts,
        responseProjectionHash,
        validationStatus: 'notRun',
      }),
    ).toThrow('Agent 审计载荷无效。')
    expect(() =>
      encodeAttemptAudit({
        lifecycle: 'stale',
        ...attemptStartFacts,
        responseProjectionHash,
        validationStatus: 'valid',
        reasoningContent: 'forbidden',
      }),
    ).toThrow('Agent 审计载荷无效。')
  })

  test('reads the current lifecycle payload and classifies unknown or damaged rows', () => {
    const attempt = {
      lifecycle: 'failed' as const,
      ...attemptStartFacts,
      responseProjectionHash: null,
      validationStatus: 'notRun' as const,
    }
    const current = encodeAttemptAudit(attempt)

    expect(
      readCurrentAttemptAudit(
        attempt.lifecycle,
        current.payloadVersion,
        current.payload,
      ),
    ).toEqual({ kind: 'decoded', value: attempt })
    expect(
      readCurrentAttemptAudit(attempt.lifecycle, 2, current.payload),
    ).toEqual({ kind: 'unknownVersion' })
    expect(
      readCurrentAttemptAudit(
        'unknown',
        current.payloadVersion,
        current.payload,
      ),
    ).toEqual({ kind: 'invalidPayload' })
    expect(readCurrentAttemptAudit('failed', 1, {})).toEqual({
      kind: 'invalidPayload',
    })
  })
})

describe('runtime audit extension decoder contracts', () => {
  test('publishes exact frozen empty extensions and fixed player/coach decoder slots', () => {
    type PlayerAudit = PlayerRuntimeAuditShape<
      { readonly checkpoint: true },
      { readonly result: true },
      { readonly decision: true }
    >
    type CoachAudit = CoachRuntimeAuditShape<
      { readonly checkpoint: true },
      { readonly result: true }
    >
    const playerDecoder: RuntimeAuditExtensionDecoder<
      'player',
      PlayerRuntimeAuditDecodeInput,
      PlayerAudit
    > = {
      runtime: 'player',
      decode: () => ({ checkpoint: null, result: null, decision: null }),
    }
    const bundle = {
      player: playerDecoder,
    } satisfies AgentAuditDecoderBundle<PlayerAudit, CoachAudit>

    expect(EMPTY_PLAYER_RUNTIME_AUDIT).toEqual({
      checkpoint: null,
      result: null,
      decision: null,
    })
    expect(EMPTY_COACH_RUNTIME_AUDIT).toEqual({
      checkpoint: null,
      result: null,
    })
    expect(Object.keys(EMPTY_PLAYER_RUNTIME_AUDIT)).toEqual([
      'checkpoint',
      'result',
      'decision',
    ])
    expect(Object.isFrozen(EMPTY_PLAYER_RUNTIME_AUDIT)).toBe(true)
    expect(Object.isFrozen(EMPTY_COACH_RUNTIME_AUDIT)).toBe(true)
    expect(Object.keys(bundle)).toEqual(['player'])
    expect('register' in bundle).toBe(false)
  })
})
