import { z } from 'zod'
import { describe, expect, test } from 'vitest'
import {
  TOKEN_ESTIMATOR_REFERENCE,
  prepareContextEnvelope,
} from '../../src/agents/foundation/context-envelope.js'
import { createModelGateway } from '../../src/agents/foundation/model-gateway.js'
import type {
  ModelAttemptControlPort,
  ModelProviderAdapter,
  ProviderAttemptResult,
} from '../../src/agents/foundation/model-gateway-protocol.js'
import { prepareModelRequest } from '../../src/agents/foundation/prompt-module.js'
import { issueRuntimeCommitAuthority } from '../../src/agents/foundation/runtime-ports.js'
import { createSensitiveValueScanner } from '../../src/agents/model-gateway/sensitive-value-scanner.js'
import { deepSeekPricingPolicy } from '../../src/agents/model-gateway/model-pricing-policy.js'
import { playerRuntimeBudgetPolicy } from '../../src/agents/player/foundation-definition.js'
import { playerModelRoutePolicy } from '../../src/agents/player/route-policy.js'
import { productionRuntimeRegistry } from '../../src/agents/production-runtime-registry.js'

const scanner = createSensitiveValueScanner()
const budget = playerRuntimeBudgetPolicy.createSnapshot({
  runtimeType: 'player',
  attemptTimeoutSeconds: 15,
  decisionDeadlineSeconds: 45,
})
const OutputSchema = z.strictObject({ choice: z.enum(['call', 'fold']) })

function preparedRequest(maximumRequestBytes = 8_192) {
  const context = prepareContextEnvelope({
    envelope: {
      runtimeType: 'player',
      runtimeDefinitionVersion: 1,
      contextSchemaVersion: 1,
      contextKind: 'decision',
      promptModules: [
        { id: 'player.prompt.system', version: 1 },
        { id: 'player.prompt.decision', version: 1 },
      ],
      sourceVersions: [],
      sections: [
        {
          sectionId: 'protocol',
          schema: { id: 'player.context.protocol', version: 1 },
          payload: { version: 1 },
        },
      ],
    },
    policy: {
      runtimeType: 'player',
      policy: { id: 'player.context-policy', version: 1 },
      tokenEstimator: TOKEN_ESTIMATOR_REFERENCE,
      maximumSerializedBytes: 4_096,
      kinds: [
        {
          contextKind: 'decision',
          sections: [
            {
              sectionId: 'protocol',
              schema: { id: 'player.context.protocol', version: 1 },
              parse: (value) =>
                z.strictObject({ version: z.literal(1) }).parse(value),
            },
          ],
        },
      ],
    },
    registry: productionRuntimeRegistry,
    budget,
    scanner,
  })
  const modules = [
    {
      runtimeType: 'player' as const,
      module: { id: 'player.prompt.system', version: 1 },
      inputSchema: { id: 'player.prompt.system-input', version: 1 },
      maximumOutputBytes: 64,
      render: () => [{ role: 'system' as const, content: 'system' }],
    },
    {
      runtimeType: 'player' as const,
      module: { id: 'player.prompt.decision', version: 1 },
      inputSchema: { id: 'player.prompt.decision-input', version: 1 },
      maximumOutputBytes: 64,
      render: () => [{ role: 'user' as const, content: 'choose' }],
    },
  ]
  return prepareModelRequest({
    runtimeType: 'player',
    runtimeDefinitionVersion: 1,
    context,
    modules,
    invocations: modules.map((module) => ({
      module: module.module,
      inputSchema: module.inputSchema,
      input: {},
    })),
    registry: productionRuntimeRegistry,
    scanner,
    maximumRequestBytes,
    maximumInputTokens: budget.maxInputTokens,
  })
}

function programmableAdapter(
  results: readonly ProviderAttemptResult[],
): ModelProviderAdapter & { readonly calls: unknown[] } {
  const pending = [...results]
  const calls: unknown[] = []
  return {
    provider: 'deepseek',
    calls,
    async generate(input) {
      calls.push(input)
      const result = pending.shift()
      if (result === undefined) throw new Error('missing programmed result')
      return result
    },
  }
}

function attemptControl(
  options: {
    readonly actualTimeoutMs?: number
    readonly finishResult?: Awaited<
      ReturnType<ModelAttemptControlPort['finishAttempt']>
    >
    readonly onFinish?: () => void
  } = {},
): ModelAttemptControlPort & {
  readonly starts: unknown[]
  readonly finishes: unknown[]
} {
  const starts: unknown[] = []
  const finishes: unknown[] = []
  return {
    starts,
    finishes,
    async startAttempt(input) {
      starts.push(input)
      return {
        kind: 'started',
        attemptId: `attempt-${starts.length}`,
        actualTimeoutMs: options.actualTimeoutMs ?? 1_000,
        maximumOutputTokens: 256,
      }
    },
    async finishAttempt(input) {
      finishes.push(input)
      options.onFinish?.()
      return options.finishResult ?? 'recorded'
    },
  }
}

function generationInput(
  adapter: ModelProviderAdapter,
  control: ModelAttemptControlPort,
) {
  return {
    gateway: createModelGateway({
      adapter,
      registry: productionRuntimeRegistry,
    }),
    input: {
      runtimeType: 'player' as const,
      runtimeDefinitionVersion: 1,
      authority: issueRuntimeCommitAuthority({
        runtimeType: 'player',
        runId: '11111111-1111-4111-8111-111111111111',
        leaseOwner: 'test:player:0',
        fencingToken: 1,
      }),
      budget,
      routePolicy: playerModelRoutePolicy,
      pricingPolicy: deepSeekPricingPolicy,
      request: preparedRequest(),
      outputSchemaReference: { id: 'player.output.decision', version: 1 },
      outputSchema: OutputSchema,
      modelSelection: {
        deepSeek: {
          modelId: 'deepseek-v4-flash',
          temperature: 0.2,
          maxOutputTokens: 256,
          thinkingMode: 'disabled' as const,
        },
      },
      signal: new AbortController().signal,
      stage: 'decision',
      scanner,
      control,
    },
  }
}

const usage = { inputTokens: 100, outputTokens: 10 }

describe('single-provider model gateway', () => {
  test('accepts a valid initial DeepSeek result', async () => {
    const adapter = programmableAdapter([
      {
        kind: 'success',
        value: { choice: 'call' },
        textProjection: '{"choice":"call"}',
        usage,
        finishReason: 'stop',
      },
    ])
    const control = attemptControl()
    const { gateway, input } = generationInput(adapter, control)
    await expect(gateway.generateStructured(input)).resolves.toEqual({
      kind: 'accepted',
      value: { choice: 'call' },
      attempts: 1,
    })
    expect(adapter.calls).toHaveLength(1)
    expect(control.starts).toHaveLength(1)
    expect(control.finishes).toMatchObject([
      { accepted: true, validationStatus: 'valid' },
    ])
  })

  test('performs at most two bounded content corrections', async () => {
    const invalid = {
      kind: 'contentInvalid' as const,
      textProjection: 'not-json',
      usage,
      finishReason: 'stop',
      failure: 'response_parse_error' as const,
    }
    const adapter = programmableAdapter([invalid, invalid, invalid])
    const control = attemptControl()
    const { gateway, input } = generationInput(adapter, control)
    await expect(gateway.generateStructured(input)).resolves.toEqual({
      kind: 'failed',
      failure: 'content_correction_exhausted',
      attempts: 3,
    })
    expect(adapter.calls).toHaveLength(3)
    expect(control.starts).toMatchObject([
      { attemptType: 'initial', routingReasonCode: null },
      { attemptType: 'correction', routingReasonCode: 'content_correction' },
      { attemptType: 'correction', routingReasonCode: 'content_correction' },
    ])
  })

  test('stops immediately after a provider infrastructure failure', async () => {
    const adapter = programmableAdapter([
      { kind: 'failure', failure: 'provider_service_unavailable' },
    ])
    const control = attemptControl()
    const { gateway, input } = generationInput(adapter, control)
    await expect(gateway.generateStructured(input)).resolves.toEqual({
      kind: 'failed',
      failure: 'provider_service_unavailable',
      attempts: 1,
    })
    expect(adapter.calls).toHaveLength(1)
  })

  test('rejects an adapter result that resolves after the attempt timeout', async () => {
    const calls: unknown[] = []
    const adapter: ModelProviderAdapter = {
      provider: 'deepseek',
      async generate(input) {
        calls.push(input)
        return new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                kind: 'success',
                value: { choice: 'call' },
                textProjection: '{"choice":"call"}',
                usage,
                finishReason: 'stop',
              }),
            20,
          )
        })
      },
    }
    const control = attemptControl({ actualTimeoutMs: 5 })
    const { gateway, input } = generationInput(adapter, control)

    await expect(gateway.generateStructured(input)).resolves.toEqual({
      kind: 'failed',
      failure: 'provider_timeout',
      attempts: 1,
    })
    expect(calls).toHaveLength(1)
    expect(control.finishes).toMatchObject([
      {
        lifecycle: 'failed',
        accepted: false,
        errorCode: 'provider_timeout',
      },
    ])
  })

  test('does not call the adapter when cancellation arrives during attempt start', async () => {
    const controller = new AbortController()
    const adapter = programmableAdapter([
      {
        kind: 'success',
        value: { choice: 'call' },
        textProjection: '{"choice":"call"}',
        usage,
        finishReason: 'stop',
      },
    ])
    const finishes: unknown[] = []
    const control: ModelAttemptControlPort = {
      async startAttempt() {
        controller.abort()
        return {
          kind: 'started',
          attemptId: 'attempt-1',
          actualTimeoutMs: 1_000,
          maximumOutputTokens: 256,
        }
      },
      async finishAttempt(input) {
        finishes.push(input)
        return 'recorded'
      },
    }
    const { gateway, input } = generationInput(adapter, control)

    await expect(
      gateway.generateStructured({ ...input, signal: controller.signal }),
    ).resolves.toEqual({
      kind: 'failed',
      failure: 'runtime_cancelled',
      attempts: 1,
    })
    expect(adapter.calls).toHaveLength(0)
    expect(finishes).toMatchObject([
      {
        lifecycle: 'cancelled',
        errorCode: 'runtime_cancelled',
        usageAccounting: 'notIncurred',
        costAccounting: 'notIncurred',
      },
    ])
  })

  test('rechecks cancellation after validation before accepting the result', async () => {
    const controller = new AbortController()
    const adapter = programmableAdapter([
      {
        kind: 'success',
        value: { choice: 'call' },
        textProjection: '{"choice":"call"}',
        usage,
        finishReason: 'stop',
      },
    ])
    const control = attemptControl()
    const { gateway, input } = generationInput(adapter, control)

    await expect(
      gateway.generateStructured({
        ...input,
        signal: controller.signal,
        validate: (value) => {
          controller.abort()
          return { kind: 'valid', value }
        },
      }),
    ).resolves.toEqual({
      kind: 'failed',
      failure: 'runtime_cancelled',
      attempts: 1,
    })
    expect(control.finishes).toMatchObject([
      {
        lifecycle: 'cancelled',
        accepted: false,
        errorCode: 'runtime_cancelled',
      },
    ])
  })

  test('binds the route and output schema to the exact runtime definition', async () => {
    const adapter = programmableAdapter([])
    const control = attemptControl()
    const { gateway, input } = generationInput(adapter, control)

    await expect(
      gateway.generateStructured({ ...input, runtimeDefinitionVersion: 2 }),
    ).resolves.toMatchObject({
      kind: 'failed',
      failure: 'runtime_authority_lost',
      attempts: 0,
    })
    await expect(
      gateway.generateStructured({
        ...input,
        outputSchemaReference: { id: 'player.output.other', version: 1 },
      }),
    ).resolves.toMatchObject({
      kind: 'failed',
      failure: 'runtime_authority_lost',
      attempts: 0,
    })
    expect(adapter.calls).toHaveLength(0)
  })

  test('rejects a structurally forged pricing policy before budget reservation', async () => {
    const adapter = programmableAdapter([])
    const control = attemptControl()
    const { gateway, input } = generationInput(adapter, control)
    const forgedPricingPolicy = {
      policy: { ...deepSeekPricingPolicy.policy },
      provider: deepSeekPricingPolicy.provider,
      modelId: deepSeekPricingPolicy.modelId,
      calculateCostMicrounits: () => 0,
      reserveCostMicrounits: () => 0,
    } as unknown as typeof deepSeekPricingPolicy

    await expect(
      gateway.generateStructured({
        ...input,
        pricingPolicy: forgedPricingPolicy,
      }),
    ).resolves.toEqual({
      kind: 'failed',
      failure: 'runtime_authority_lost',
      attempts: 0,
    })
    expect(control.starts).toHaveLength(0)
    expect(adapter.calls).toHaveLength(0)
  })

  test('stops before an oversized correction request reaches the provider', async () => {
    const baseRequest = preparedRequest()
    const tightRequest = preparedRequest(baseRequest.byteLength)
    const adapter = programmableAdapter([
      {
        kind: 'contentInvalid',
        textProjection: 'x'.repeat(4_096),
        usage,
        finishReason: 'stop',
        failure: 'response_parse_error',
      },
      {
        kind: 'success',
        value: { choice: 'call' },
        textProjection: '{"choice":"call"}',
        usage,
        finishReason: 'stop',
      },
    ])
    const control = attemptControl()
    const { gateway, input } = generationInput(adapter, control)

    await expect(
      gateway.generateStructured({ ...input, request: tightRequest }),
    ).resolves.toEqual({
      kind: 'failed',
      failure: 'execution_budget_exhausted',
      attempts: 1,
    })
    expect(adapter.calls).toHaveLength(1)
    expect(control.starts).toHaveLength(1)
  })

  test('converges a throwing semantic validator to a terminal attempt', async () => {
    const adapter = programmableAdapter([
      {
        kind: 'success',
        value: { choice: 'call' },
        textProjection: '{"choice":"call"}',
        usage,
        finishReason: 'stop',
      },
    ])
    const control = attemptControl()
    const { gateway, input } = generationInput(adapter, control)

    await expect(
      gateway.generateStructured({
        ...input,
        validate: () => {
          throw new Error('validator-private-detail')
        },
      }),
    ).resolves.toEqual({
      kind: 'failed',
      failure: 'response_semantic_invalid',
      attempts: 1,
    })
    expect(control.finishes).toMatchObject([
      {
        lifecycle: 'failed',
        accepted: false,
        errorCode: 'response_semantic_invalid',
        validationStatus: 'invalid',
      },
    ])
  })

  test('converges a malformed semantic validator result to a terminal attempt', async () => {
    const adapter = programmableAdapter([
      {
        kind: 'success',
        value: { choice: 'call' },
        textProjection: '{"choice":"call"}',
        usage,
        finishReason: 'stop',
      },
    ])
    const control = attemptControl()
    const { gateway, input } = generationInput(adapter, control)

    await expect(
      gateway.generateStructured({
        ...input,
        validate: () => ({ kind: 'invalid', issues: undefined }) as never,
      }),
    ).resolves.toEqual({
      kind: 'failed',
      failure: 'response_semantic_invalid',
      attempts: 1,
    })
    expect(control.finishes).toMatchObject([
      {
        lifecycle: 'failed',
        accepted: false,
        errorCode: 'response_semantic_invalid',
      },
    ])
  })

  test.each([
    ['null', null],
    ['undefined', undefined],
  ] as const)(
    'converges a %s semantic validator result to a terminal attempt',
    async (_label, semanticResult) => {
      const adapter = programmableAdapter([
        {
          kind: 'success',
          value: { choice: 'call' },
          textProjection: '{"choice":"call"}',
          usage,
          finishReason: 'stop',
        },
      ])
      const control = attemptControl()
      const { gateway, input } = generationInput(adapter, control)

      await expect(
        gateway.generateStructured({
          ...input,
          validate: () => semanticResult as never,
        }),
      ).resolves.toEqual({
        kind: 'failed',
        failure: 'response_semantic_invalid',
        attempts: 1,
      })
      expect(control.finishes).toMatchObject([
        {
          lifecycle: 'failed',
          accepted: false,
          errorCode: 'response_semantic_invalid',
          validationStatus: 'invalid',
        },
      ])
    },
  )

  test('rejects a valid result when finish reports actual budget exhaustion', async () => {
    const adapter = programmableAdapter([
      {
        kind: 'success',
        value: { choice: 'call' },
        textProjection: '{"choice":"call"}',
        usage,
        finishReason: 'stop',
      },
    ])
    const control = attemptControl({ finishResult: 'budgetExceeded' })
    const { gateway, input } = generationInput(adapter, control)

    await expect(gateway.generateStructured(input)).resolves.toEqual({
      kind: 'failed',
      failure: 'execution_budget_exhausted',
      attempts: 1,
    })
  })

  test('does not deliver an accepted result when cancellation arrives during finish', async () => {
    const adapter = programmableAdapter([
      {
        kind: 'success',
        value: { choice: 'call' },
        textProjection: '{"choice":"call"}',
        usage,
        finishReason: 'stop',
      },
    ])
    const controller = new AbortController()
    const control = attemptControl({ onFinish: () => controller.abort() })
    const { gateway, input } = generationInput(adapter, control)

    await expect(
      gateway.generateStructured({ ...input, signal: controller.signal }),
    ).resolves.toEqual({
      kind: 'failed',
      failure: 'runtime_cancelled',
      attempts: 1,
    })
    expect(control.finishes).toMatchObject([
      { accepted: true, validationStatus: 'valid' },
    ])
  })

  test('converges pricing overflow to a terminal failed attempt', async () => {
    const adapter = programmableAdapter([
      {
        kind: 'success',
        value: { choice: 'call' },
        textProjection: '{"choice":"call"}',
        usage: {
          inputTokens: Number.MAX_SAFE_INTEGER,
          outputTokens: Number.MAX_SAFE_INTEGER,
        },
        finishReason: 'stop',
      },
    ])
    const control = attemptControl()
    const { gateway, input } = generationInput(adapter, control)

    await expect(gateway.generateStructured(input)).resolves.toEqual({
      kind: 'failed',
      failure: 'provider_billing_unavailable',
      attempts: 1,
    })
    expect(control.finishes).toMatchObject([
      {
        lifecycle: 'failed',
        accepted: false,
        inputTokens: Number.MAX_SAFE_INTEGER,
        outputTokens: Number.MAX_SAFE_INTEGER,
        errorCode: 'provider_billing_unavailable',
        usageAccounting: 'providerReported',
        costAccounting: 'reservedUpperBound',
      },
    ])
  })
})
