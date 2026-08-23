import { createModelRoutePolicy } from '../foundation/model-route-policy.js'
import { DEEPSEEK_PRICING_POLICY_REFERENCE } from '../model-gateway/model-pricing-policy.js'

export const playerModelRoutePolicy = createModelRoutePolicy({
  runtimeType: 'player',
  policy: { id: 'player.route-policy', version: 1 },
  pricingPolicy: DEEPSEEK_PRICING_POLICY_REFERENCE,
  provider: 'deepseek',
  maximumContentCorrections: 2,
})
