import { describe, expect, test } from 'vitest'
import {
  EMPTY_AUTHORIZED_STRATEGY_PACK,
  createStaticStrategyPackRepository,
  StrategyPackUnavailableError,
} from '../../src/poker-strategy/strategy-pack-repository.js'
import { parseStrategyPack } from '../../src/poker-strategy/strategy-pack.js'
import {
  decodeStrategyPackAuditReference,
  encodeStrategyPackAuditReference,
  readPinnedStrategyPackReference,
} from '../../src/agents/player/player-strategy-pack-audit-reference.js'
import { projectStrategy } from '../../src/poker-strategy/strategy-projection.js'

const spotKey = 'a'.repeat(64)

describe('StrategyPack', () => {
  test('publishes authorized empty production coverage as explicit unsupported', () => {
    const repository = createStaticStrategyPackRepository()
    const pack = repository.read({
      reference: {
        datasetId: EMPTY_AUTHORIZED_STRATEGY_PACK.datasetId,
        datasetVersion: EMPTY_AUTHORIZED_STRATEGY_PACK.datasetVersion,
      },
      usage: 'newRun',
    })

    expect(
      projectStrategy({
        pack,
        spotKey,
        exactHandAbstractionKey: 'AA',
        referenceHandAbstractionKey: 'AA',
        assumptionCodes: [],
        legalCandidateIds: ['fold', 'call:20'],
        aggressiveCandidateIds: [],
      }),
    ).toMatchObject({
      status: 'unsupported',
      reasonCode: 'noAuthorizedCoverage',
      candidateWeights: [],
    })
  })

  test('accepts an exact authorized test record and rejects illegal candidate references', () => {
    const pack = parseStrategyPack({
      strategyPackSchemaVersion: 1,
      datasetId: 'test-pack',
      datasetVersion: 1,
      status: 'active',
      pokerRuleSetVersion: 'nlhe-cash-6to9-10-20-v1',
      abstractionProfile: {
        profileId: 'exact-test',
        version: 1,
        descriptionCode: 'testOnly',
      },
      records: [
        {
          recordId: 'record-1',
          matchKind: 'exact',
          spotKey,
          handAbstractionKey: 'AA',
          assumptionCodes: [],
          abstractionLossCodes: [],
          sourceKind: 'teachingReference',
          sourceName: 'unit-test',
          sourceVersion: '1',
          licenseOrAuthorizationRef: 'test-authorization',
          actions: [
            {
              candidateId: 'fold',
              actionFrequencyBasisPoints: 2_000,
              betSizePotRatio: null,
              solverEv: null,
            },
            {
              candidateId: 'call:20',
              actionFrequencyBasisPoints: 8_000,
              betSizePotRatio: null,
              solverEv: null,
            },
          ],
        },
      ],
    })

    expect(
      projectStrategy({
        pack,
        spotKey,
        exactHandAbstractionKey: 'AA',
        referenceHandAbstractionKey: 'AA',
        assumptionCodes: [],
        legalCandidateIds: ['fold', 'call:20'],
        aggressiveCandidateIds: [],
      }).status,
    ).toBe('exact')
    expect(() =>
      projectStrategy({
        pack,
        spotKey,
        exactHandAbstractionKey: 'AA',
        referenceHandAbstractionKey: 'AA',
        assumptionCodes: [],
        legalCandidateIds: ['fold'],
        aggressiveCandidateIds: [],
      }),
    ).toThrow(/非法候选/)
  })

  test.each([
    {
      name: 'non-aggressive candidate with a size',
      candidateId: 'call:60',
      betSizePotRatio: { numerator: 60, denominator: 100 },
    },
    {
      name: 'aggressive candidate without a size',
      candidateId: 'bet:60',
      betSizePotRatio: null,
    },
    {
      name: 'aggressive size that does not match its target',
      candidateId: 'raise:60',
      betSizePotRatio: { numerator: 50, denominator: 100 },
    },
    {
      name: 'malformed candidate semantics',
      candidateId: 'bet:0',
      betSizePotRatio: { numerator: 0, denominator: 100 },
    },
  ])('rejects $name', ({ candidateId, betSizePotRatio }) => {
    expect(() =>
      parseStrategyPack({
        strategyPackSchemaVersion: 1,
        datasetId: 'invalid-action-pack',
        datasetVersion: 1,
        status: 'active',
        pokerRuleSetVersion: 'nlhe-cash-6to9-10-20-v1',
        abstractionProfile: {
          profileId: 'exact-test',
          version: 1,
          descriptionCode: 'testOnly',
        },
        records: [
          {
            recordId: 'record-1',
            matchKind: 'exact',
            spotKey,
            handAbstractionKey: 'AA',
            assumptionCodes: [],
            abstractionLossCodes: [],
            sourceKind: 'teachingReference',
            sourceName: 'unit-test',
            sourceVersion: '1',
            licenseOrAuthorizationRef: 'test-authorization',
            actions: [
              {
                candidateId,
                actionFrequencyBasisPoints: 10_000,
                betSizePotRatio,
                solverEv: null,
              },
            ],
          },
        ],
      }),
    ).toThrow()
  })

  test('accepts a matching aggressive size and enforces abstraction loss semantics', () => {
    const createPack = (
      matchKind: 'exact' | 'referenceOnly',
      abstractionLossCodes: readonly string[],
    ) => ({
      strategyPackSchemaVersion: 1,
      datasetId: `test-${matchKind.toLowerCase()}`,
      datasetVersion: 1,
      status: 'active',
      pokerRuleSetVersion: 'nlhe-cash-6to9-10-20-v1',
      abstractionProfile: {
        profileId: 'test-profile',
        version: 1,
        descriptionCode: 'testOnly',
      },
      records: [
        {
          recordId: 'record-1',
          matchKind,
          spotKey,
          handAbstractionKey: 'AA',
          assumptionCodes: [],
          abstractionLossCodes,
          sourceKind: 'teachingReference',
          sourceName: 'unit-test',
          sourceVersion: '1',
          licenseOrAuthorizationRef: 'test-authorization',
          actions: [
            {
              candidateId: 'allIn:200',
              actionFrequencyBasisPoints: 10_000,
              betSizePotRatio: { numerator: 200, denominator: 120 },
              solverEv: null,
            },
          ],
        },
      ],
    })

    expect(() => parseStrategyPack(createPack('exact', []))).not.toThrow()
    expect(() =>
      parseStrategyPack(createPack('referenceOnly', ['boardTextureCollapsed'])),
    ).not.toThrow()
    expect(() =>
      parseStrategyPack(createPack('exact', ['boardTextureCollapsed'])),
    ).toThrow(/抽象损失/)
    expect(() => parseStrategyPack(createPack('referenceOnly', []))).toThrow(
      /抽象损失/,
    )
  })

  test('rejects unknown and duplicate versioned strategy codes', () => {
    const base = {
      ...EMPTY_AUTHORIZED_STRATEGY_PACK,
      datasetId: 'strategy-code-test',
      records: [
        {
          recordId: 'record-1',
          matchKind: 'referenceOnly',
          spotKey,
          handAbstractionKey: 'AA',
          assumptionCodes: ['currentHandEvidenceOnly'],
          abstractionLossCodes: ['boardTextureCollapsed'],
          sourceKind: 'teachingReference',
          sourceName: 'unit-test',
          sourceVersion: '1',
          licenseOrAuthorizationRef: 'test-authorization',
          actions: [
            {
              candidateId: 'fold',
              actionFrequencyBasisPoints: 10_000,
              betSizePotRatio: null,
              solverEv: null,
            },
          ],
        },
      ],
    }
    expect(() =>
      parseStrategyPack({
        ...base,
        records: [{ ...base.records[0], assumptionCodes: ['misspelled'] }],
      }),
    ).toThrow()
    expect(() =>
      parseStrategyPack({
        ...base,
        records: [
          {
            ...base.records[0],
            abstractionLossCodes: ['unknownLoss'],
          },
        ],
      }),
    ).toThrow()
    expect(() =>
      parseStrategyPack({
        ...base,
        records: [
          {
            ...base.records[0],
            assumptionCodes: [
              'currentHandEvidenceOnly',
              'currentHandEvidenceOnly',
            ],
          },
        ],
      }),
    ).toThrow(/重复假设代码/)
    expect(() =>
      parseStrategyPack({
        ...base,
        records: [
          {
            ...base.records[0],
            abstractionLossCodes: [
              'boardTextureCollapsed',
              'boardTextureCollapsed',
            ],
          },
        ],
      }),
    ).toThrow(/重复抽象损失代码/)
  })

  test('round-trips the unique StrategyPack Run dependency codec', () => {
    const reference = {
      datasetId: 'm45-empty-authorized',
      datasetVersion: 1,
    }
    const auditReference = encodeStrategyPackAuditReference(reference)
    expect(auditReference).toEqual({
      id: 'strategy-pack/m45-empty-authorized',
      version: 1,
    })
    expect(decodeStrategyPackAuditReference(auditReference)).toEqual(reference)
    expect(readPinnedStrategyPackReference([auditReference])).toEqual(reference)
    expect(() =>
      readPinnedStrategyPackReference([
        auditReference,
        { id: 'strategy-pack/another', version: 1 },
      ]),
    ).toThrow(/仅固化一个/)
    expect(() =>
      decodeStrategyPackAuditReference({ id: 'other/data', version: 1 }),
    ).toThrow(/不是 StrategyPack/)
  })

  test('distinguishes a calling all-in from an aggressive all-in at projection time', () => {
    const pack = parseStrategyPack({
      strategyPackSchemaVersion: 1,
      datasetId: 'all-in-call-test',
      datasetVersion: 1,
      status: 'active',
      pokerRuleSetVersion: 'nlhe-cash-6to9-10-20-v1',
      abstractionProfile: {
        profileId: 'exact-test',
        version: 1,
        descriptionCode: 'testOnly',
      },
      records: [
        {
          recordId: 'all-in-call',
          matchKind: 'exact',
          spotKey,
          handAbstractionKey: 'AA',
          assumptionCodes: [],
          abstractionLossCodes: [],
          sourceKind: 'teachingReference',
          sourceName: 'unit-test',
          sourceVersion: '1',
          licenseOrAuthorizationRef: 'test-authorization',
          actions: [
            {
              candidateId: 'allIn:20',
              actionFrequencyBasisPoints: 10_000,
              betSizePotRatio: null,
              solverEv: null,
            },
          ],
        },
      ],
    })
    const input = {
      pack,
      spotKey,
      exactHandAbstractionKey: 'AA',
      referenceHandAbstractionKey: 'AA',
      assumptionCodes: [],
      legalCandidateIds: ['allIn:20'],
    }

    expect(
      projectStrategy({ ...input, aggressiveCandidateIds: [] }).status,
    ).toBe('exact')
    expect(() =>
      projectStrategy({
        ...input,
        aggressiveCandidateIds: ['allIn:20'],
      }),
    ).toThrow(/下注尺度/)
  })

  test('refuses revoked and new-run deprecated packs', () => {
    const deprecated = parseStrategyPack({
      ...EMPTY_AUTHORIZED_STRATEGY_PACK,
      datasetId: 'deprecated-test',
      status: 'deprecated',
    })
    const revoked = parseStrategyPack({
      ...EMPTY_AUTHORIZED_STRATEGY_PACK,
      datasetId: 'revoked-test',
      status: 'revoked',
    })
    const repository = createStaticStrategyPackRepository([deprecated, revoked])
    expect(() =>
      repository.read({
        reference: { datasetId: 'deprecated-test', datasetVersion: 1 },
        usage: 'newRun',
      }),
    ).toThrow(StrategyPackUnavailableError)
    expect(
      repository.read({
        reference: { datasetId: 'deprecated-test', datasetVersion: 1 },
        usage: 'pinnedRun',
      }).status,
    ).toBe('deprecated')
    expect(() =>
      repository.read({
        reference: { datasetId: 'revoked-test', datasetVersion: 1 },
        usage: 'pinnedRun',
      }),
    ).toThrow(StrategyPackUnavailableError)
  })
})
