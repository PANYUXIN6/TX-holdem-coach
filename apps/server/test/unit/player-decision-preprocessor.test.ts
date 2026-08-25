import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import {
  buildPlayerDecisionAnalysisCore,
  type PlayerDecisionAnalysisCore,
} from '../../src/agents/player/player-decision-analysis-core.js'
import {
  composePlayerDecisionPreprocessingResult,
  isPlayerDecisionPreprocessingResult,
} from '../../src/agents/player/player-decision-preprocessor.js'
import { decodeCurrentPlayerDecisionPreprocessingResult } from '../../src/agents/player/player-decision-preprocessing-schema.js'
import { buildPlayerOpponentEvidence } from '../../src/agents/player/player-opponent-evidence.js'
import type { PlayerDecisionReference } from '../../src/agents/player/player-decision-reference.js'
import { buildPlayerStrategyProjection } from '../../src/agents/player/player-strategy-projection.js'
import { loadAndValidatePersonaCatalog } from '../../src/personas/catalog.js'
import { canonicalJson, type JsonValue } from '../../src/persisted-json.js'
import type { PokerCommand } from '../../src/poker/commands.js'
import {
  createConfigSnapshotKey,
  PERSONA_CONFIG_PAYLOAD_VERSION,
} from '../../src/personas/config.js'
import { EMPTY_AUTHORIZED_STRATEGY_PACK } from '../../src/poker-strategy/strategy-pack-repository.js'
import {
  parseStrategyPack,
  type StrategyPack,
} from '../../src/poker-strategy/strategy-pack.js'
import { buildPlayerObservationDraft } from '../../src/sessions/authoritative-state/player-observation-builder.js'
import { certifyPlayerVisibleState } from '../../src/sessions/authoritative-state/player-information-boundary-guard.js'
import type { PlayerVisibleState } from '../../src/sessions/authoritative-state/player-visible-state.js'
import { createPlayerObservationFixture } from '../helpers/player-observation-fixture.js'
import {
  FactSourceRefSchema,
  type FactSourceRef,
} from '../../src/agents/player/player-fact-sources.js'

function referenceFor(
  observation: PlayerVisibleState,
): PlayerDecisionReference {
  const persona = loadAndValidatePersonaCatalog().list()[0]!
  return Object.freeze({
    sessionId: observation.identity.sessionId,
    handId: observation.identity.handId,
    actorParticipantId: observation.identity.actorParticipantId,
    actorSeat: observation.identity.actorSeat,
    pokerRuleSetVersion: 'nlhe-cash-6to9-10-20-v1',
    handNumber: observation.hand.handNumber,
    configSnapshotKey: createConfigSnapshotKey(
      PERSONA_CONFIG_PAYLOAD_VERSION,
      persona,
    ),
    personaId: persona.personaId,
    personaVersion: 1,
    personaPolicy: { ...persona.style },
  })
}

function exactStrategyPackFor(
  analysisCore: PlayerDecisionAnalysisCore,
): StrategyPack {
  const hand = analysisCore.data.handFeatures
  const handAbstractionKey =
    hand.kind === 'preflop'
      ? `preflop:v1:${hand.startingHandClass}`
      : `postflop:v1:visible:${hand.visibleCardsSha256}`
  const passiveCandidate = analysisCore.data.legalCandidates.find(
    ({ action }) =>
      action.type === 'fold' ||
      action.type === 'check' ||
      action.type === 'call',
  )
  if (passiveCandidate === undefined) {
    throw new RangeError('测试策略包需要一个非主动下注候选。')
  }
  return parseStrategyPack({
    strategyPackSchemaVersion: 1,
    datasetId: 'decoder-strategy-test',
    datasetVersion: 1,
    status: 'active',
    pokerRuleSetVersion: 'nlhe-cash-6to9-10-20-v1',
    abstractionProfile: {
      profileId: 'decoder-strategy-test',
      version: 1,
      descriptionCode: 'testOnly',
    },
    records: [
      {
        recordId: 'decoder-strategy-record',
        matchKind: 'exact',
        spotKey: analysisCore.data.normalizedSpot.spotKey,
        handAbstractionKey,
        assumptionCodes: [],
        abstractionLossCodes: [],
        sourceKind: 'teachingReference',
        sourceName: 'unit-test',
        sourceVersion: '1',
        licenseOrAuthorizationRef: 'test-authorization',
        actions: [
          {
            candidateId: passiveCandidate.candidateId,
            actionFrequencyBasisPoints: 10_000,
            betSizePotRatio: null,
            solverEv: null,
          },
        ],
      },
    ],
  })
}

function build(
  strategyPackFor: (
    analysisCore: PlayerDecisionAnalysisCore,
  ) => StrategyPack = () => EMPTY_AUTHORIZED_STRATEGY_PACK,
) {
  const fixture = createPlayerObservationFixture({ withPublicAction: true })
  const observation = certifyPlayerVisibleState(
    buildPlayerObservationDraft(fixture.input),
  )
  const reference = referenceFor(observation)
  const analysisCore = buildPlayerDecisionAnalysisCore({
    observation,
    reference,
  })
  const strategyPack = strategyPackFor(analysisCore)
  const strategyProjection = buildPlayerStrategyProjection({
    analysisCore,
    strategyPack,
  })
  const opponentEvidence = buildPlayerOpponentEvidence({
    observation,
    reference,
  })
  return {
    observation,
    reference,
    analysisCore,
    strategyProjection,
    opponentEvidence,
    result: composePlayerDecisionPreprocessingResult({
      observation,
      reference,
      strategyPackRef: {
        datasetId: strategyPack.datasetId,
        datasetVersion: strategyPack.datasetVersion,
      },
      analysisCore,
      strategyProjection,
      opponentEvidence,
    }),
  }
}

type MutableCandidateStage = {
  candidateId: string
  weightBasisPoints: number
}

type MutablePolicyCandidateStage = MutableCandidateStage & {
  action: PokerCommand['action']
  targetStreetCommitment: number | null
  contributionDelta: number
}

type MutablePreprocessingPayload = {
  configSnapshotKey: string
  candidateSource: 'strategy' | 'heuristic'
  heuristicCandidateResult: {
    data: { candidates: MutablePolicyCandidateStage[] } | null
  }
  personaAdjustment: { data: { candidates: MutablePolicyCandidateStage[] } }
  exploitAdjustment: { data: { candidates: MutablePolicyCandidateStage[] } }
  candidates: {
    data: (MutablePolicyCandidateStage & {
      source: 'strategy' | 'heuristic'
      baseWeightBasisPoints: number
      personaAdjustedWeightBasisPoints: number
      exploitAdjustedWeightBasisPoints: number
      sourceRefs: FactSourceRef[]
    })[]
  }
  candidateOutcomes: {
    data: {
      candidate: {
        candidateId: string
        action: PokerCommand['action']
        targetStreetCommitment: number | null
        targetKind:
          | 'minimum'
          | 'halfPot'
          | 'twoThirdsPot'
          | 'pot'
          | 'call'
          | 'allIn'
          | 'notApplicable'
      }
      contributionDelta: number
      targetStreetCommitment:
        | { status: 'available'; value: number }
        | { status: 'notApplicable'; reasonCode: 'noTarget' }
    }[]
  }
  preprocessingSha256: string
}

function mutablePayload(
  result: ReturnType<typeof build>['result'],
): MutablePreprocessingPayload {
  return structuredClone(result) as unknown as MutablePreprocessingPayload
}

function rehash(payload: MutablePreprocessingPayload): void {
  const { preprocessingSha256: _previousHash, ...withoutHash } = payload
  payload.preprocessingSha256 = createHash('sha256')
    .update(canonicalJson(withoutHash as unknown as JsonValue), 'utf8')
    .digest('hex')
}

function transferOneBasisPoint(
  candidates: MutableCandidateStage[],
): [MutableCandidateStage, MutableCandidateStage] {
  const donor = candidates.find(
    ({ weightBasisPoints }) => weightBasisPoints > 0,
  )
  const recipient = candidates.find(
    ({ candidateId }) => candidateId !== donor?.candidateId,
  )
  if (donor === undefined || recipient === undefined) {
    throw new RangeError('测试候选不足以执行守恒权重转移。')
  }
  donor.weightBasisPoints -= 1
  recipient.weightBasisPoints += 1
  return [donor, recipient]
}

describe('Player decision preprocessor', () => {
  test('builds one deeply frozen, bound and hashed heuristic result', () => {
    const prepared = build()
    const result = prepared.result

    expect(isPlayerDecisionPreprocessingResult(result)).toBe(true)
    expect(result.candidateSource).toBe('heuristic')
    expect(result.strategyProjection.data.status).toBe('unsupported')
    expect(result.heuristicCandidateResult.data).toMatchObject({
      heuristicCandidatePolicyVersion: 1,
      confidence: 'low',
      reasonCode: 'legalFallbackCandidate',
      unsupportedReasonCode: 'noAuthorizedCoverage',
    })
    expect(result.opponentEvidence.data).toMatchObject({
      status: 'insufficientEvidence',
      reasonCode: 'crossHandEvidenceUnavailable',
    })
    expect(
      result.candidates.data.reduce(
        (total, candidate) => total + candidate.weightBasisPoints,
        0,
      ),
    ).toBe(10_000)
    for (const stage of [
      'baseWeightBasisPoints',
      'personaAdjustedWeightBasisPoints',
      'exploitAdjustedWeightBasisPoints',
    ] as const) {
      expect(
        result.candidates.data.reduce(
          (total, candidate) => total + candidate[stage],
          0,
        ),
      ).toBe(10_000)
    }
    expect(
      result.candidates.data.every(
        (candidate) =>
          candidate.weightBasisPoints ===
            candidate.exploitAdjustedWeightBasisPoints &&
          candidate.commitmentRiskBand !== null,
      ),
    ).toBe(true)
    expect(
      new Set(
        result.candidates.data.flatMap((candidate) =>
          candidate.sourceRefs.map(({ kind }) => kind),
        ),
      ),
    ).toEqual(
      new Set([
        'strategyPack',
        'heuristicPolicy',
        'personaSnapshot',
        'opponentEvidence',
        'exploitPolicy',
      ]),
    )
    expect(result.candidateOutcomes.data).toHaveLength(
      result.candidates.data.length,
    )
    expect(result.preprocessingSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.candidateOutcomes.data)).toBe(true)
    expect(JSON.stringify(result)).not.toContain('analysisInputField')
  })

  test('does not rehydrate a structural clone as a live certified result', () => {
    const result = build().result
    const clone = structuredClone(result)

    expect(isPlayerDecisionPreprocessingResult(clone)).toBe(false)
    expect(decodeCurrentPlayerDecisionPreprocessingResult(clone)).toEqual(
      result,
    )
  })

  test('current decoder rejects unknown nested fields and broken conservation', () => {
    const result = build().result
    const injected = structuredClone(result) as unknown as {
      candidates: { data: Record<string, unknown>[] }
    }
    injected.candidates.data[0]!.injected = true
    expect(() =>
      decodeCurrentPlayerDecisionPreprocessingResult(injected),
    ).toThrow()

    const broken = structuredClone(result) as unknown as {
      candidates: {
        data: { baseWeightBasisPoints: number }[]
      }
    }
    broken.candidates.data[0]!.baseWeightBasisPoints += 1
    expect(() =>
      decodeCurrentPlayerDecisionPreprocessingResult(broken),
    ).toThrow(/权重|哈希/)
  })

  test.each([
    {
      name: 'base',
      mutate(payload: MutablePreprocessingPayload) {
        const heuristicCandidates =
          payload.heuristicCandidateResult.data?.candidates
        if (heuristicCandidates === undefined) {
          throw new RangeError('测试需要 heuristic 阶段。')
        }
        const [donor, recipient] = transferOneBasisPoint(
          payload.candidates.data.map((candidate) => ({
            candidateId: candidate.candidateId,
            get weightBasisPoints() {
              return candidate.baseWeightBasisPoints
            },
            set weightBasisPoints(value: number) {
              candidate.baseWeightBasisPoints = value
            },
          })),
        )
        expect(
          heuristicCandidates.find(
            ({ candidateId }) => candidateId === donor.candidateId,
          )?.weightBasisPoints,
        ).not.toBe(donor.weightBasisPoints)
        expect(
          heuristicCandidates.find(
            ({ candidateId }) => candidateId === recipient.candidateId,
          )?.weightBasisPoints,
        ).not.toBe(recipient.weightBasisPoints)
      },
    },
    {
      name: 'persona',
      mutate(payload: MutablePreprocessingPayload) {
        transferOneBasisPoint(
          payload.candidates.data.map((candidate) => ({
            candidateId: candidate.candidateId,
            get weightBasisPoints() {
              return candidate.personaAdjustedWeightBasisPoints
            },
            set weightBasisPoints(value: number) {
              candidate.personaAdjustedWeightBasisPoints = value
            },
          })),
        )
      },
    },
    {
      name: 'exploit',
      mutate(payload: MutablePreprocessingPayload) {
        transferOneBasisPoint(
          payload.candidates.data.map((candidate) => ({
            candidateId: candidate.candidateId,
            get weightBasisPoints() {
              return candidate.exploitAdjustedWeightBasisPoints
            },
            set weightBasisPoints(value: number) {
              candidate.exploitAdjustedWeightBasisPoints = value
              candidate.weightBasisPoints = value
            },
          })),
        )
      },
    },
  ])(
    'current decoder rejects a rehashed, conserved $name-stage mismatch',
    ({ mutate }) => {
      const tampered = mutablePayload(build().result)
      mutate(tampered)
      rehash(tampered)

      expect(() =>
        decodeCurrentPlayerDecisionPreprocessingResult(tampered),
      ).toThrow(/逐项一致/)
    },
  )

  test('current decoder rejects a rehashed per-candidate source mismatch', () => {
    const tampered = mutablePayload(build().result)
    tampered.candidates.data[0]!.source = 'strategy'
    rehash(tampered)

    expect(() =>
      decodeCurrentPlayerDecisionPreprocessingResult(tampered),
    ).toThrow(/逐项一致/)
  })

  test('current decoder checks strategy base weights by candidate id', () => {
    const tampered = mutablePayload(build(exactStrategyPackFor).result)
    expect(tampered.candidateSource).toBe('strategy')
    transferOneBasisPoint(
      tampered.candidates.data.map((candidate) => ({
        candidateId: candidate.candidateId,
        get weightBasisPoints() {
          return candidate.baseWeightBasisPoints
        },
        set weightBasisPoints(value: number) {
          candidate.baseWeightBasisPoints = value
        },
      })),
    )
    rehash(tampered)

    expect(() =>
      decodeCurrentPlayerDecisionPreprocessingResult(tampered),
    ).toThrow(/逐项一致/)
  })

  test('current decoder rejects rehashed stage semantics that contradict CandidateOutcome', () => {
    const tampered = mutablePayload(build().result)
    const candidateId = tampered.candidates.data[0]!.candidateId
    for (const candidates of [
      tampered.heuristicCandidateResult.data!.candidates,
      tampered.personaAdjustment.data.candidates,
      tampered.exploitAdjustment.data.candidates,
      tampered.candidates.data,
    ]) {
      const candidate = candidates.find(
        (entry) => entry.candidateId === candidateId,
      )!
      candidate.action = { type: 'check' }
      candidate.contributionDelta += 1
    }
    rehash(tampered)

    expect(() =>
      decodeCurrentPlayerDecisionPreprocessingResult(tampered),
    ).toThrow(/CandidateOutcome/)
  })

  test('current decoder rejects jointly rehashed candidate copies whose ID contradicts action semantics', () => {
    const tampered = mutablePayload(build().result)
    const candidate = tampered.candidates.data.find(({ candidateId }) =>
      candidateId.startsWith('call:'),
    )
    if (candidate === undefined) {
      throw new RangeError('测试候选缺少跟注候选。')
    }
    for (const candidates of [
      tampered.heuristicCandidateResult.data!.candidates,
      tampered.personaAdjustment.data.candidates,
      tampered.exploitAdjustment.data.candidates,
      tampered.candidates.data,
    ]) {
      const copy = candidates.find(
        (entry) => entry.candidateId === candidate.candidateId,
      )
      if (copy === undefined) {
        throw new RangeError('测试阶段缺少跟注候选副本。')
      }
      copy.action = { type: 'check' }
    }
    const outcome = tampered.candidateOutcomes.data.find(
      (entry) => entry.candidate.candidateId === candidate.candidateId,
    )
    if (outcome === undefined) {
      throw new RangeError('测试结果缺少跟注候选副本。')
    }
    outcome.candidate.action = { type: 'check' }
    rehash(tampered)

    expect(() =>
      decodeCurrentPlayerDecisionPreprocessingResult(tampered),
    ).toThrow(/候选 ID/)
  })

  test('current decoder rejects a rehashed available CandidateOutcome target projection mismatch', () => {
    const tampered = mutablePayload(build().result)
    const outcome = tampered.candidateOutcomes.data.find(
      (entry) => entry.targetStreetCommitment.status === 'available',
    )
    if (outcome?.targetStreetCommitment.status !== 'available') {
      throw new RangeError('测试候选缺少数值 target 投影。')
    }
    outcome.targetStreetCommitment.value += 1
    rehash(tampered)

    expect(() =>
      decodeCurrentPlayerDecisionPreprocessingResult(tampered),
    ).toThrow(/投影 target/)
  })

  test('current decoder rejects a rehashed no-target CandidateOutcome projection mismatch', () => {
    const tampered = mutablePayload(build().result)
    const outcome = tampered.candidateOutcomes.data.find(
      (entry) => entry.targetStreetCommitment.status === 'notApplicable',
    )
    if (outcome === undefined) {
      throw new RangeError('测试候选缺少无 target 投影。')
    }
    outcome.targetStreetCommitment = { status: 'available', value: 0 }
    rehash(tampered)

    expect(() =>
      decodeCurrentPlayerDecisionPreprocessingResult(tampered),
    ).toThrow(/投影 target/)
  })

  test('current decoder rejects a jointly rehashed malformed config snapshot key', () => {
    const tampered = mutablePayload(build().result)
    tampered.configSnapshotKey = 'not-a-snapshot-hash'
    for (const candidate of tampered.candidates.data) {
      const personaSource = candidate.sourceRefs.find(
        (source) => source.kind === 'personaSnapshot',
      )
      if (personaSource?.kind !== 'personaSnapshot') {
        throw new RangeError('测试候选缺少人物快照来源。')
      }
      const mutablePersonaSource = personaSource as {
        configSnapshotKey: string
      }
      mutablePersonaSource.configSnapshotKey = 'not-a-snapshot-hash'
    }
    rehash(tampered)

    expect(() =>
      decodeCurrentPlayerDecisionPreprocessingResult(tampered),
    ).toThrow()
    expect(
      FactSourceRefSchema.safeParse({
        kind: 'personaSnapshot',
        configSnapshotKey: 'not-a-snapshot-hash',
        personaId: 'nit_fish',
        personaVersion: 1,
      }).success,
    ).toBe(false)
  })

  test.each([
    {
      name: 'a conflicting reference value',
      mutate(sourceRefs: FactSourceRef[]) {
        const source = sourceRefs.find(
          (entry) => entry.kind === 'strategyPack',
        ) as { kind: 'strategyPack'; datasetId: string }
        source.datasetId = 'tampered-audit-source'
      },
    },
    {
      name: 'a duplicate reference',
      mutate(sourceRefs: FactSourceRef[]) {
        sourceRefs.push(structuredClone(sourceRefs[0]!))
      },
    },
    {
      name: 'an extra reference',
      mutate(sourceRefs: FactSourceRef[]) {
        sourceRefs.push({
          kind: 'algorithm',
          algorithmId: 'spotNormalizer',
          version: 1,
        })
      },
    },
  ])(
    'current decoder rejects rehashed direct sources with $name',
    ({ mutate }) => {
      const tampered = mutablePayload(build().result)
      mutate(tampered.candidates.data[0]!.sourceRefs)
      rehash(tampered)

      expect(() =>
        decodeCurrentPlayerDecisionPreprocessingResult(tampered),
      ).toThrow(/直接政策来源/)
    },
  )

  test('rejects cross-observation component composition', () => {
    const prepared = build()
    const otherFixture = createPlayerObservationFixture({ actorSeat: 4 })
    const otherObservation = certifyPlayerVisibleState(
      buildPlayerObservationDraft(otherFixture.input),
    )
    const otherReference = referenceFor(otherObservation)
    const otherEvidence = buildPlayerOpponentEvidence({
      observation: otherObservation,
      reference: otherReference,
    })
    const analysisCore = buildPlayerDecisionAnalysisCore({
      observation: prepared.observation,
      reference: prepared.reference,
    })
    const strategyProjection = buildPlayerStrategyProjection({
      analysisCore,
      strategyPack: EMPTY_AUTHORIZED_STRATEGY_PACK,
    })

    expect(() =>
      composePlayerDecisionPreprocessingResult({
        observation: prepared.observation,
        reference: prepared.reference,
        strategyPackRef: {
          datasetId: EMPTY_AUTHORIZED_STRATEGY_PACK.datasetId,
          datasetVersion: EMPTY_AUTHORIZED_STRATEGY_PACK.datasetVersion,
        },
        analysisCore,
        strategyProjection,
        opponentEvidence: otherEvidence,
      }),
    ).toThrow(/绑定不一致/)
  })

  test.each([
    {
      name: 'dataset id',
      strategyPackRef: {
        datasetId: 'different-authorized-dataset',
        datasetVersion: EMPTY_AUTHORIZED_STRATEGY_PACK.datasetVersion,
      },
    },
    {
      name: 'dataset version',
      strategyPackRef: {
        datasetId: EMPTY_AUTHORIZED_STRATEGY_PACK.datasetId,
        datasetVersion: EMPTY_AUTHORIZED_STRATEGY_PACK.datasetVersion + 1,
      },
    },
  ])('rejects a mismatched strategy pack $name', ({ strategyPackRef }) => {
    const prepared = build()

    expect(() =>
      composePlayerDecisionPreprocessingResult({
        observation: prepared.observation,
        reference: prepared.reference,
        strategyPackRef,
        analysisCore: prepared.analysisCore,
        strategyProjection: prepared.strategyProjection,
        opponentEvidence: prepared.opponentEvidence,
      }),
    ).toThrow(/策略包引用与认证策略投影的数据集不一致/)
  })
})
