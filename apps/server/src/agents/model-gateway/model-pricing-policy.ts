import { z } from 'zod'
import type { RuntimeComponentReference } from '../foundation/runtime-definition.js'

export const DEEPSEEK_PRICING_POLICY_REFERENCE = Object.freeze({
  id: 'foundation.deepseek-pricing-cny',
  version: 1,
})

declare const modelPricingPolicyBrand: unique symbol

const TokenUsageSchema = z
  .strictObject({
    inputTokens: z.number().int().nonnegative().safe(),
    outputTokens: z.number().int().nonnegative().safe(),
    cacheReadInputTokens: z.number().int().nonnegative().safe().optional(),
    cacheMissInputTokens: z.number().int().nonnegative().safe().optional(),
  })
  .superRefine((usage, context) => {
    const hasRead = usage.cacheReadInputTokens !== undefined
    const hasMiss = usage.cacheMissInputTokens !== undefined
    if (
      hasRead !== hasMiss ||
      (hasRead &&
        usage.cacheReadInputTokens! + usage.cacheMissInputTokens! !==
          usage.inputTokens)
    ) {
      context.addIssue({ code: 'custom' })
    }
  })

export interface ModelPricingPolicy {
  readonly policy: RuntimeComponentReference
  readonly provider: 'deepseek'
  readonly modelId: 'deepseek-v4-flash'
  calculateCostMicrounits(input: unknown): number
  reserveCostMicrounits(input: {
    readonly estimatedInputTokens: number
    readonly maximumOutputTokens: number
  }): number
  readonly [modelPricingPolicyBrand]: never
}

const modelPricingPolicies = new WeakSet<object>()

function calculateCost(input: unknown): number {
  const usage = TokenUsageSchema.parse(input)
  const cacheRead = usage.cacheReadInputTokens ?? 0
  const cacheMiss = usage.cacheMissInputTokens ?? usage.inputTokens
  // 价格单位为 CNY/1M tokens，换算到 microCny 后正好是每 token 的有理数。
  // hit=0.02/1M CNY => 2/100 microCny；miss=1；output=2。
  const numerator = cacheRead * 2 + cacheMiss * 100 + usage.outputTokens * 200
  if (!Number.isSafeInteger(numerator)) throw new RangeError('成本溢出。')
  return Math.ceil(numerator / 100)
}

function createDeepSeekPricingPolicy(): ModelPricingPolicy {
  const policy = Object.freeze({
    policy: DEEPSEEK_PRICING_POLICY_REFERENCE,
    provider: 'deepseek' as const,
    modelId: 'deepseek-v4-flash' as const,
    calculateCostMicrounits: calculateCost,
    reserveCostMicrounits(input: {
      readonly estimatedInputTokens: number
      readonly maximumOutputTokens: number
    }): number {
      return calculateCost({
        inputTokens: input.estimatedInputTokens,
        outputTokens: input.maximumOutputTokens,
      })
    },
  }) as ModelPricingPolicy
  modelPricingPolicies.add(policy)
  return policy
}

export function isModelPricingPolicy(
  value: unknown,
): value is ModelPricingPolicy {
  return (
    typeof value === 'object' &&
    value !== null &&
    modelPricingPolicies.has(value)
  )
}

export const deepSeekPricingPolicy = createDeepSeekPricingPolicy()
