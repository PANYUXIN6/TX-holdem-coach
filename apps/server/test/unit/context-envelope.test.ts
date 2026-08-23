import { z } from 'zod'
import { describe, expect, test } from 'vitest'
import {
  TOKEN_ESTIMATOR_REFERENCE,
  isPreparedContextEnvelope,
  prepareContextEnvelope,
  type ContextPolicyDefinition,
} from '../../src/agents/foundation/context-envelope.js'
import { prepareModelRequest } from '../../src/agents/foundation/prompt-module.js'
import { playerRuntimeBudgetPolicy } from '../../src/agents/player/foundation-definition.js'
import { productionRuntimeRegistry } from '../../src/agents/production-runtime-registry.js'
import { createSensitiveValueScanner } from '../../src/agents/model-gateway/sensitive-value-scanner.js'

const SectionSchema = z.strictObject({ value: z.string() })
const policy: ContextPolicyDefinition<'player', 'decision'> = {
  runtimeType: 'player',
  policy: { id: 'player.context-policy', version: 1 },
  tokenEstimator: TOKEN_ESTIMATOR_REFERENCE,
  maximumSerializedBytes: 8_192,
  kinds: [
    {
      contextKind: 'decision',
      sections: [
        {
          sectionId: 'protocol',
          schema: { id: 'player.context.protocol', version: 1 },
          parse: (value) => SectionSchema.parse(value),
        },
      ],
    },
  ],
}

function envelope() {
  return {
    runtimeType: 'player' as const,
    runtimeDefinitionVersion: 1,
    contextSchemaVersion: 1,
    contextKind: 'decision' as const,
    promptModules: [
      { id: 'player.prompt.system', version: 1 },
      { id: 'player.prompt.decision', version: 1 },
    ],
    sourceVersions: [
      { source: { id: 'player.source.z', version: 1 }, contentVersion: '2' },
      { source: { id: 'player.source.a', version: 1 }, contentVersion: '1' },
    ],
    sections: [
      {
        sectionId: 'protocol',
        schema: { id: 'player.context.protocol', version: 1 },
        payload: { value: 'ok' },
      },
    ],
  }
}

const budget = playerRuntimeBudgetPolicy.createSnapshot({
  runtimeType: 'player',
  attemptTimeoutSeconds: 15,
  decisionDeadlineSeconds: 45,
})
const scanner = createSensitiveValueScanner({ secrets: ['secret-sentinel'] })

describe('context envelope and prompt preparation', () => {
  test('produces deterministic canonical context, hash and token estimate', () => {
    const first = prepareContextEnvelope({
      envelope: envelope(),
      policy,
      registry: productionRuntimeRegistry,
      budget,
      scanner,
    })
    const second = prepareContextEnvelope({
      envelope: envelope(),
      policy,
      registry: productionRuntimeRegistry,
      budget,
      scanner,
    })

    expect(first.serialized).toBe(second.serialized)
    expect(first.sha256).toBe(second.sha256)
    expect(first.estimatedInputTokens).toBe(second.estimatedInputTokens)
    expect(first.serialized.indexOf('player.source.a')).toBeLessThan(
      first.serialized.indexOf('player.source.z'),
    )
    expect(isPreparedContextEnvelope(first, 'player')).toBe(true)
    expect(isPreparedContextEnvelope({ ...first }, 'player')).toBe(false)
  })

  test('rejects section drift, strict payload extras and sensitive values', () => {
    expect(() =>
      prepareContextEnvelope({
        envelope: {
          ...envelope(),
          sections: [
            {
              ...envelope().sections[0]!,
              payload: { value: 'ok', extra: true },
            },
          ],
        },
        policy,
        registry: productionRuntimeRegistry,
        budget,
        scanner,
      }),
    ).toThrow('Agent Foundation 协议校验失败。')
    expect(() =>
      prepareContextEnvelope({
        envelope: {
          ...envelope(),
          sections: [
            {
              ...envelope().sections[0]!,
              payload: { value: 'Bearer abc.def.ghi' },
            },
          ],
        },
        policy,
        registry: productionRuntimeRegistry,
        budget,
        scanner,
      }),
    ).toThrow('Agent Foundation 协议校验失败。')
  })

  test('rejects duplicate source ids even when their versions differ', () => {
    expect(() =>
      prepareContextEnvelope({
        envelope: {
          ...envelope(),
          sourceVersions: [
            {
              source: { id: 'player.source.same', version: 1 },
              contentVersion: 'one',
            },
            {
              source: { id: 'player.source.same', version: 2 },
              contentVersion: 'two',
            },
          ],
        },
        policy,
        registry: productionRuntimeRegistry,
        budget,
        scanner,
      }),
    ).toThrow('Agent Foundation 协议校验失败。')
  })

  test('compiles only the exact static prompt order plus readonly context', () => {
    const context = prepareContextEnvelope({
      envelope: envelope(),
      policy,
      registry: productionRuntimeRegistry,
      budget,
      scanner,
    })
    const modules = [
      {
        runtimeType: 'player' as const,
        module: { id: 'player.prompt.system', version: 1 },
        inputSchema: { id: 'player.prompt.system-input', version: 1 },
        maximumOutputBytes: 128,
        render: () => [{ role: 'system' as const, content: 'system' }],
      },
      {
        runtimeType: 'player' as const,
        module: { id: 'player.prompt.decision', version: 1 },
        inputSchema: { id: 'player.prompt.decision-input', version: 1 },
        maximumOutputBytes: 128,
        render: () => [{ role: 'user' as const, content: 'choose' }],
      },
    ]
    const request = prepareModelRequest({
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
      maximumRequestBytes: 16_384,
      maximumInputTokens: budget.maxInputTokens,
    })
    expect(request.messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'user',
    ])
    expect(request.messages.at(-1)?.content).toContain('只读上下文数据')
  })
})
