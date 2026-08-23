import {
  JSONParseError,
  NoObjectGeneratedError,
  Output,
  TypeValidationError,
  generateText,
  type LanguageModel,
  type LanguageModelUsage,
} from 'ai'
import { canonicalJson, type JsonValue } from '../../persisted-json.js'
import type {
  ModelProviderAdapter,
  ProviderAttemptInput,
  ProviderAttemptResult,
  ProviderUsage,
} from '../foundation/model-gateway-protocol.js'
import { classifyProviderError } from './provider-error-classifier.js'
import type { SensitiveValueScanner } from '../foundation/context-envelope.js'

type GenerateTextFunction = typeof generateText

function projectUsage(
  usage: LanguageModelUsage | undefined,
): ProviderUsage | null {
  if (usage?.inputTokens === undefined || usage.outputTokens === undefined) {
    return null
  }
  const cacheRead = usage.inputTokenDetails.cacheReadTokens
  const noCache = usage.inputTokenDetails.noCacheTokens
  return Object.freeze({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(cacheRead === undefined || noCache === undefined
      ? {}
      : {
          cacheReadInputTokens: cacheRead,
          cacheMissInputTokens: noCache,
        }),
  })
}

function boundedInvalidText(text: string | undefined): string {
  if (text === undefined) return ''
  return Buffer.from(text, 'utf8').subarray(0, 4_096).toString('utf8')
}

export function createAiSdkModelAdapter(input: {
  readonly provider: 'deepseek'
  readonly createModel: (modelId: string) => LanguageModel
  readonly scanner: SensitiveValueScanner
  readonly generate?: GenerateTextFunction
}): ModelProviderAdapter {
  const invoke = input.generate ?? generateText
  return Object.freeze({
    provider: input.provider,
    async generate(
      attempt: ProviderAttemptInput,
    ): Promise<ProviderAttemptResult> {
      try {
        const result = await invoke({
          model: input.createModel(attempt.modelId),
          messages: attempt.messages.map((message) => ({ ...message })),
          allowSystemInMessages: true,
          output: Output.object({ schema: attempt.outputSchema }),
          toolChoice: 'none',
          maxRetries: 0,
          maxOutputTokens: attempt.maximumOutputTokens,
          temperature: attempt.temperature,
          abortSignal: attempt.abortSignal,
          include: {
            requestBody: false,
            requestMessages: false,
            responseBody: false,
          },
          telemetry: { isEnabled: false },
          providerOptions: {
            deepseek: {
              thinking: { type: 'disabled' },
              strictJsonSchema: true,
            },
          },
        })
        const value = result.output as JsonValue
        input.scanner.assertSafe(value)
        const textProjection = canonicalJson(value)
        return Object.freeze({
          kind: 'success' as const,
          value,
          textProjection,
          usage: projectUsage(result.usage),
          finishReason: result.finishReason,
        })
      } catch (error) {
        if (NoObjectGeneratedError.isInstance(error)) {
          if (error.finishReason === 'content-filter') {
            return Object.freeze({
              kind: 'failure' as const,
              failure: 'provider_unknown_error' as const,
            })
          }
          let textProjection: string
          let failure: 'response_parse_error' | 'response_schema_error'
          try {
            if (JSONParseError.isInstance(error.cause)) {
              textProjection = boundedInvalidText(error.cause.text)
              input.scanner.assertSafe(textProjection)
              failure = 'response_parse_error'
            } else if (TypeValidationError.isInstance(error.cause)) {
              const invalidValue = error.cause.value as JsonValue
              input.scanner.assertSafe(invalidValue)
              textProjection = boundedInvalidText(canonicalJson(invalidValue))
              failure = 'response_schema_error'
            } else {
              return Object.freeze({
                kind: 'failure' as const,
                failure: 'provider_unknown_error' as const,
              })
            }
          } catch {
            return Object.freeze({
              kind: 'failure' as const,
              failure: 'provider_unknown_error' as const,
            })
          }
          return Object.freeze({
            kind: 'contentInvalid' as const,
            textProjection,
            usage: projectUsage(error.usage),
            finishReason: error.finishReason ?? null,
            failure,
          })
        }
        return Object.freeze({
          kind: 'failure' as const,
          failure: classifyProviderError(error, attempt.abortSignal),
        })
      }
    },
  })
}
