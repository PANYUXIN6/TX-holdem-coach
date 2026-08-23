import {
  APICallError,
  JSONParseError,
  NoObjectGeneratedError,
  TypeValidationError,
  type LanguageModel,
  type LanguageModelUsage,
} from 'ai'
import { describe, expect, test, vi } from 'vitest'
import { z } from 'zod'
import { createAiSdkModelAdapter } from '../../src/agents/model-gateway/ai-sdk-model-adapter.js'
import { createSensitiveValueScanner } from '../../src/agents/model-gateway/sensitive-value-scanner.js'
import { classifyProviderError } from '../../src/agents/model-gateway/provider-error-classifier.js'

const sdkUsage: LanguageModelUsage = {
  inputTokens: 10,
  outputTokens: 2,
  inputTokenDetails: {
    noCacheTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: undefined,
  },
  outputTokenDetails: { textTokens: 2, reasoningTokens: 0 },
  totalTokens: 12,
}

function noObjectGenerated(input: {
  readonly cause: Error
  readonly text?: string
  readonly finishReason?: 'stop' | 'content-filter'
}): NoObjectGeneratedError {
  return new NoObjectGeneratedError({
    cause: input.cause,
    ...(input.text === undefined ? {} : { text: input.text }),
    response: {
      id: 'response-1',
      timestamp: new Date('2026-08-21T00:00:00.000Z'),
      modelId: 'deepseek-v4-flash',
    },
    usage: sdkUsage,
    finishReason: input.finishReason ?? 'stop',
  })
}

describe('AI SDK DeepSeek adapter', () => {
  test('pins one non-streaming, no-tools, no-retry structured call', async () => {
    const generate = vi.fn(async () => ({
      output: { ok: true },
      usage: sdkUsage,
      finishReason: 'stop',
    }))
    const adapter = createAiSdkModelAdapter({
      provider: 'deepseek',
      createModel: () => ({}) as LanguageModel,
      scanner: createSensitiveValueScanner(),
      generate: generate as unknown as typeof import('ai').generateText,
    })
    const result = await adapter.generate({
      messages: [{ role: 'user', content: 'return json' }],
      modelId: 'deepseek-v4-flash',
      temperature: 0.2,
      maximumOutputTokens: 256,
      outputSchema: z.strictObject({ ok: z.boolean() }),
      abortSignal: new AbortController().signal,
    })
    expect(result).toMatchObject({
      kind: 'success',
      value: { ok: true },
      textProjection: '{"ok":true}',
    })
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        maxRetries: 0,
        maxOutputTokens: 256,
        toolChoice: 'none',
        include: {
          requestBody: false,
          requestMessages: false,
          responseBody: false,
        },
        providerOptions: {
          deepseek: {
            thinking: { type: 'disabled' },
            strictJsonSchema: true,
          },
        },
      }),
    )
  })

  test.each([
    [
      new JSONParseError({
        text: 'not-json',
        cause: new SyntaxError('private parse detail'),
      }),
      'not-json',
      'response_parse_error',
    ],
    [
      new TypeValidationError({
        value: { ok: 'wrong' },
        cause: new Error('private schema detail'),
      }),
      '{"ok":"wrong"}',
      'response_schema_error',
    ],
  ] as const)(
    'classifies only explicit parse/schema NoObjectGenerated causes',
    async (cause, expectedText, expectedFailure) => {
      const adapter = createAiSdkModelAdapter({
        provider: 'deepseek',
        createModel: () => ({}) as LanguageModel,
        scanner: createSensitiveValueScanner(),
        generate: (async () => {
          throw noObjectGenerated({ cause, text: 'untrusted raw text' })
        }) as typeof import('ai').generateText,
      })

      await expect(
        adapter.generate({
          messages: [{ role: 'user', content: 'return json' }],
          modelId: 'deepseek-v4-flash',
          temperature: 0.2,
          maximumOutputTokens: 256,
          outputSchema: z.strictObject({ ok: z.boolean() }),
          abortSignal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({
        kind: 'contentInvalid',
        textProjection: expectedText,
        failure: expectedFailure,
      })
    },
  )

  test('fails closed for content-filter or unclassified NoObjectGenerated errors', async () => {
    const adapter = createAiSdkModelAdapter({
      provider: 'deepseek',
      createModel: () => ({}) as LanguageModel,
      scanner: createSensitiveValueScanner(),
      generate: (async () => {
        throw noObjectGenerated({
          cause: new Error('unclassified'),
          finishReason: 'content-filter',
        })
      }) as typeof import('ai').generateText,
    })

    await expect(
      adapter.generate({
        messages: [{ role: 'user', content: 'return json' }],
        modelId: 'deepseek-v4-flash',
        temperature: 0.2,
        maximumOutputTokens: 256,
        outputSchema: z.strictObject({ ok: z.boolean() }),
        abortSignal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: 'failure',
      failure: 'provider_unknown_error',
    })
  })

  test('scans structured output before producing its canonical projection', async () => {
    const adapter = createAiSdkModelAdapter({
      provider: 'deepseek',
      createModel: () => ({}) as LanguageModel,
      scanner: createSensitiveValueScanner(),
      generate: (async () => ({
        output: { ok: true, reasoning: 'private' },
        usage: sdkUsage,
        finishReason: 'stop',
      })) as unknown as typeof import('ai').generateText,
    })

    await expect(
      adapter.generate({
        messages: [{ role: 'user', content: 'return json' }],
        modelId: 'deepseek-v4-flash',
        temperature: 0.2,
        maximumOutputTokens: 256,
        outputSchema: z.strictObject({ ok: z.boolean() }),
        abortSignal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: 'failure',
      failure: 'provider_unknown_error',
    })
  })

  test.each([
    [401, 'provider_auth_error'],
    [402, 'provider_billing_unavailable'],
    [403, 'provider_auth_error'],
    [429, 'provider_rate_limited'],
    [500, 'provider_service_unavailable'],
    [502, 'provider_service_unavailable'],
    [503, 'provider_service_unavailable'],
    [504, 'provider_service_unavailable'],
    [418, 'provider_unknown_error'],
  ] as const)(
    'classifies HTTP %i without using retry hints',
    (status, expected) => {
      const error = new APICallError({
        message: 'must not escape',
        url: 'https://provider.invalid',
        requestBodyValues: { secret: 'must not escape' },
        statusCode: status,
        responseHeaders: { authorization: 'must not escape' },
        responseBody: 'must not escape',
        isRetryable: true,
      })
      expect(classifyProviderError(error, new AbortController().signal)).toBe(
        expected,
      )
    },
  )

  test('distinguishes local timeout, worker cancellation and known network codes', () => {
    const timeout = new AbortController()
    timeout.abort('provider_timeout')
    expect(classifyProviderError(new Error('ignored'), timeout.signal)).toBe(
      'provider_timeout',
    )
    const cancelled = new AbortController()
    cancelled.abort('runtime_cancelled')
    expect(classifyProviderError(new Error('ignored'), cancelled.signal)).toBe(
      'runtime_cancelled',
    )
    const network = Object.assign(new Error('ignored'), { code: 'ECONNRESET' })
    expect(classifyProviderError(network, new AbortController().signal)).toBe(
      'provider_network_error',
    )

    const apiCallNetworkError = new APICallError({
      message: 'must not escape',
      url: 'https://provider.invalid',
      requestBodyValues: {},
      cause: Object.assign(new Error('ignored'), { code: 'ECONNRESET' }),
    })
    expect(
      classifyProviderError(apiCallNetworkError, new AbortController().signal),
    ).toBe('provider_network_error')
  })
})
