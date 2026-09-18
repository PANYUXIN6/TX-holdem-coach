import type { OpponentRangePack } from '../../src/poker-range/opponent-range-pack.js'
import { POKER_RULE_SET_VERSION } from '../../src/poker/poker-rule-set.js'

/** Synthetic test-only evidence; never a production range source. */
export function makeOpponentRangePack(
  overrides: Partial<OpponentRangePack> = {},
): OpponentRangePack {
  return {
    opponentRangePackSchemaVersion: 1,
    datasetId: 'test-opponent-ranges',
    datasetVersion: 1,
    status: 'active',
    pokerRuleSetVersion: POKER_RULE_SET_VERSION,
    sources: [
      {
        sourceId: 'fixture-source',
        kind: 'projectCurated',
        publisher: 'test fixture',
        title: 'synthetic range fixture',
        version: '1',
        authorizationRef: 'test-only',
        reviewedAt: '2026-09-18T00:00:00Z',
        methodology:
          'Synthetic combinations used only for deterministic unit tests.',
      },
    ],
    coverageManifest: [],
    initialRanges: [],
    updateRules: [],
    jointScenarios: [],
    limitations: ['testOnlyNotForProduction'],
    ...overrides,
  }
}
