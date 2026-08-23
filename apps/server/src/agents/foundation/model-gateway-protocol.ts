import type { z } from 'zod'
import type { JsonValue } from '../../persisted-json.js'
import type { SensitiveValueScanner } from './context-envelope.js'
import type { ModelGatewayFailure } from './errors.js'
import type { ExecutionBudget } from './execution-budget.js'
import type { ModelRoutePolicy, ProviderId } from './model-route-policy.js'
import type { PreparedModelRequest, ModelMessage } from './prompt-module.js'
import type { RuntimeCommitAuthority } from './runtime-ports.js'
import type {
  RuntimeComponentReference,
  RuntimeType,
} from './runtime-definition.js'
import type { ModelPricingPolicy } from '../model-gateway/model-pricing-policy.js'

export interface ModelSelectionSnapshot {
  readonly deepSeek: {
    readonly modelId: string
    readonly temperature: number
    readonly maxOutputTokens: number
    readonly thinkingMode: 'disabled'
  }
}

export interface ModelVisibleValidationIssue {
  readonly code: string
  readonly path: readonly string[]
}

export type RuntimeOutputValidation<TOutput extends JsonValue> =
  | { readonly kind: 'valid'; readonly value: TOutput }
  | {
      readonly kind: 'invalid'
      readonly issues: readonly ModelVisibleValidationIssue[]
    }

export interface ProviderUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadInputTokens?: number
  readonly cacheMissInputTokens?: number
}

export interface ProviderAttemptInput {
  readonly messages: readonly ModelMessage[]
  readonly modelId: string
  readonly temperature: number
  readonly maximumOutputTokens: number
  readonly outputSchema: z.ZodType<unknown>
  readonly abortSignal: AbortSignal
}

export type ProviderAttemptResult =
  | {
      readonly kind: 'success'
      readonly value: unknown
      readonly textProjection: string
      readonly usage: ProviderUsage | null
      readonly finishReason: string
    }
  | {
      readonly kind: 'contentInvalid'
      readonly textProjection: string
      readonly usage: ProviderUsage | null
      readonly finishReason: string | null
      readonly failure: 'response_parse_error' | 'response_schema_error'
    }
  | {
      readonly kind: 'failure'
      readonly failure: Extract<
        ModelGatewayFailure,
        | 'provider_billing_unavailable'
        | 'provider_network_error'
        | 'provider_timeout'
        | 'provider_service_unavailable'
        | 'provider_auth_error'
        | 'provider_rate_limited'
        | 'provider_unknown_error'
        | 'runtime_cancelled'
      >
    }

export interface ModelProviderAdapter {
  readonly provider: ProviderId
  generate(input: ProviderAttemptInput): Promise<ProviderAttemptResult>
}

export type AttemptStartDecision =
  | {
      readonly kind: 'started'
      readonly attemptId: string
      readonly actualTimeoutMs: number
      readonly maximumOutputTokens: number
    }
  | {
      readonly kind: 'rejected'
      readonly failure:
        | 'execution_budget_exhausted'
        | 'execution_deadline_exhausted'
        | 'runtime_authority_lost'
        | 'local_persistence_error'
    }

export interface ModelAttemptControlPort {
  startAttempt(input: {
    readonly attemptType: 'initial' | 'correction'
    readonly routingReasonCode: null | 'content_correction'
    readonly stage: string
    readonly provider: 'deepseek'
    readonly model: string
    readonly estimatedInputTokens: number
    readonly requestedMaximumOutputTokens: number
    readonly reservedCostMicrounits: number
    readonly requestProjectionHash: string
  }): Promise<AttemptStartDecision>
  finishAttempt(input: {
    readonly attemptId: string
    readonly lifecycle: 'completed' | 'failed' | 'cancelled'
    readonly accepted: boolean
    readonly inputTokens: number
    readonly outputTokens: number
    readonly costMicrounits: number
    readonly durationMs: number
    readonly errorCode: ModelGatewayFailure | null
    readonly responseProjectionHash: string | null
    readonly validationStatus: 'notRun' | 'valid' | 'invalid'
    readonly usageAccounting:
      'providerReported' | 'reservedUpperBound' | 'notIncurred'
    readonly costAccounting:
      | 'providerReportedSplit'
      | 'allInputAtCacheMiss'
      | 'reservedUpperBound'
      | 'notIncurred'
  }): Promise<'recorded' | 'stale' | 'budgetExceeded' | 'authorityLost'>
}

export interface StructuredGenerationInput<
  TRuntime extends RuntimeType,
  TOutput extends JsonValue,
> {
  readonly runtimeType: TRuntime
  readonly runtimeDefinitionVersion: number
  readonly authority: RuntimeCommitAuthority<TRuntime>
  readonly budget: ExecutionBudget
  readonly routePolicy: ModelRoutePolicy<TRuntime>
  readonly pricingPolicy: ModelPricingPolicy
  readonly request: PreparedModelRequest<TRuntime>
  readonly outputSchemaReference: RuntimeComponentReference
  readonly outputSchema: z.ZodType<TOutput>
  readonly validate?: (value: TOutput) => RuntimeOutputValidation<TOutput>
  readonly modelSelection: ModelSelectionSnapshot
  readonly signal: AbortSignal
  readonly stage: string
  readonly scanner: SensitiveValueScanner
  readonly control: ModelAttemptControlPort
}

export type StructuredGenerationResult<TOutput extends JsonValue> =
  | {
      readonly kind: 'accepted'
      readonly value: TOutput
      readonly attempts: number
    }
  | {
      readonly kind: 'failed'
      readonly failure: ModelGatewayFailure
      readonly attempts: number
    }

export interface ModelGateway {
  generateStructured<TRuntime extends RuntimeType, TOutput extends JsonValue>(
    input: StructuredGenerationInput<TRuntime, TOutput>,
  ): Promise<StructuredGenerationResult<TOutput>>
}
