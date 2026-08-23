import { describe, expect, test } from 'vitest'
import {
  deepSeekPricingPolicy,
  isModelPricingPolicy,
} from '../../src/agents/model-gateway/model-pricing-policy.js'

describe('DeepSeek pricing policy', () => {
  test('uses integer rational pricing and cache-miss fallback', () => {
    expect(
      deepSeekPricingPolicy.calculateCostMicrounits({
        inputTokens: 1,
        outputTokens: 0,
        cacheReadInputTokens: 1,
        cacheMissInputTokens: 0,
      }),
    ).toBe(1)
    expect(
      deepSeekPricingPolicy.calculateCostMicrounits({
        inputTokens: 100,
        outputTokens: 10,
      }),
    ).toBe(120)
    expect(
      deepSeekPricingPolicy.reserveCostMicrounits({
        estimatedInputTokens: 100,
        maximumOutputTokens: 10,
      }),
    ).toBe(120)
  })

  test('rejects inconsistent cache splits', () => {
    expect(() =>
      deepSeekPricingPolicy.calculateCostMicrounits({
        inputTokens: 10,
        outputTokens: 1,
        cacheReadInputTokens: 4,
        cacheMissInputTokens: 5,
      }),
    ).toThrow()
  })

  test('authenticates only the code-issued policy object', () => {
    expect(isModelPricingPolicy(deepSeekPricingPolicy)).toBe(true)
    expect(
      isModelPricingPolicy({
        ...deepSeekPricingPolicy,
        policy: { ...deepSeekPricingPolicy.policy },
      }),
    ).toBe(false)
  })
})
