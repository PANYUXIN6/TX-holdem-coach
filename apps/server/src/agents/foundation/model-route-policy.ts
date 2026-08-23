import type {
  RuntimeComponentReference,
  RuntimeType,
} from './runtime-definition.js'

export type ProviderId = 'deepseek'

declare const modelRoutePolicyBrand: unique symbol

export interface ModelRoutePolicy<TRuntime extends RuntimeType> {
  readonly runtimeType: TRuntime
  readonly policy: RuntimeComponentReference
  readonly pricingPolicy: RuntimeComponentReference
  readonly provider: 'deepseek'
  readonly maximumContentCorrections: 2
  readonly [modelRoutePolicyBrand]: never
}

const routePolicies = new WeakSet<object>()

export function createModelRoutePolicy<TRuntime extends RuntimeType>(input: {
  readonly runtimeType: TRuntime
  readonly policy: RuntimeComponentReference
  readonly pricingPolicy: RuntimeComponentReference
  readonly provider: 'deepseek'
  readonly maximumContentCorrections: 2
}): ModelRoutePolicy<TRuntime> {
  if (
    (input.runtimeType !== 'player' && input.runtimeType !== 'coach') ||
    !input.policy.id.startsWith(`${input.runtimeType}.route-policy`) ||
    input.policy.version <= 0 ||
    input.pricingPolicy.id !== 'foundation.deepseek-pricing-cny' ||
    input.pricingPolicy.version !== 1 ||
    input.provider !== 'deepseek' ||
    input.maximumContentCorrections !== 2
  ) {
    throw new TypeError('模型路由策略无效。')
  }
  const policy = Object.freeze({
    ...input,
    policy: Object.freeze({ ...input.policy }),
    pricingPolicy: Object.freeze({ ...input.pricingPolicy }),
  }) as ModelRoutePolicy<TRuntime>
  routePolicies.add(policy)
  return policy
}

export function isModelRoutePolicy<TRuntime extends RuntimeType>(
  value: unknown,
  runtimeType: TRuntime,
): value is ModelRoutePolicy<TRuntime> {
  return (
    typeof value === 'object' &&
    value !== null &&
    routePolicies.has(value) &&
    (value as { readonly runtimeType?: unknown }).runtimeType === runtimeType
  )
}
