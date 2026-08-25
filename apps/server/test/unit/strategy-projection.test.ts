import { describe, expect, test } from 'vitest'
import { parseStrategyPack } from '../../src/poker-strategy/strategy-pack.js'
import { projectStrategy } from '../../src/poker-strategy/strategy-projection.js'

const spotKey = 'b'.repeat(64)

function record(input: {
  readonly recordId: string
  readonly matchKind: 'exact' | 'referenceOnly'
  readonly handAbstractionKey: string
  readonly abstractionLossCodes: readonly string[]
}) {
  return {
    ...input,
    spotKey,
    assumptionCodes: [],
    sourceKind: 'teachingReference' as const,
    sourceName: 'unit-test',
    sourceVersion: '1',
    licenseOrAuthorizationRef: 'test-authorization',
    actions: [
      {
        candidateId: 'check',
        actionFrequencyBasisPoints: 10_000,
        betSizePotRatio: null,
        solverEv: null,
      },
    ],
  }
}

describe('Strategy projection hand abstraction', () => {
  test('uses the full visible-card key for exact and falls back to an explicit lossy reference', () => {
    const pack = parseStrategyPack({
      strategyPackSchemaVersion: 1,
      datasetId: 'hand-abstraction-test',
      datasetVersion: 1,
      status: 'active',
      pokerRuleSetVersion: 'nlhe-cash-6to9-10-20-v1',
      abstractionProfile: {
        profileId: 'hand-abstraction-v1',
        version: 1,
        descriptionCode: 'testOnly',
      },
      records: [
        record({
          recordId: 'exact-visible-a',
          matchKind: 'exact',
          handAbstractionKey: 'postflop:v1:visible:visible-a',
          abstractionLossCodes: [],
        }),
        record({
          recordId: 'reference-one-pair',
          matchKind: 'referenceOnly',
          handAbstractionKey: 'postflop:v1:onePair:topPair',
          abstractionLossCodes: ['boardTextureCollapsed'],
        }),
      ],
    })

    expect(
      projectStrategy({
        pack,
        spotKey,
        exactHandAbstractionKey: 'postflop:v1:visible:visible-a',
        referenceHandAbstractionKey: 'postflop:v1:onePair:topPair',
        assumptionCodes: [],
        legalCandidateIds: ['check'],
        aggressiveCandidateIds: [],
      }),
    ).toMatchObject({ status: 'exact', recordId: 'exact-visible-a' })

    expect(
      projectStrategy({
        pack,
        spotKey,
        exactHandAbstractionKey: 'postflop:v1:visible:visible-b',
        referenceHandAbstractionKey: 'postflop:v1:onePair:topPair',
        assumptionCodes: [],
        legalCandidateIds: ['check'],
        aggressiveCandidateIds: [],
      }),
    ).toMatchObject({
      status: 'referenceOnly',
      recordId: 'reference-one-pair',
    })

    expect(
      projectStrategy({
        pack,
        spotKey,
        exactHandAbstractionKey: 'postflop:v1:visible:visible-b',
        referenceHandAbstractionKey: 'postflop:v1:highCard:none',
        assumptionCodes: [],
        legalCandidateIds: ['check'],
        aggressiveCandidateIds: [],
      }),
    ).toMatchObject({ status: 'unsupported' })
  })
})
