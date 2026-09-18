import { describe, expect, test } from 'vitest'
import { expandRangeWeights } from '../../src/poker-range/combo-expander.js'
import { RANGE_HAND_CLASSES } from '../../src/poker-range/opponent-range-pack.js'

const weights = RANGE_HAND_CLASSES.map((handClass) => ({
  handClass,
  relativeComboWeightBasisPoints: ['AA', 'AKs', 'AKo'].includes(handClass)
    ? 10000
    : 0,
}))

describe('opponent range combo mass', () => {
  test('expands 6/4/12 combinations before conditioning on known cards', () => {
    const result = expandRangeWeights(weights, [])
    expect(
      result.combos.filter((combo) => combo.handClass === 'AA'),
    ).toHaveLength(6)
    expect(
      result.combos.filter((combo) => combo.handClass === 'AKs'),
    ).toHaveLength(4)
    expect(
      result.combos.filter((combo) => combo.handClass === 'AKo'),
    ).toHaveLength(12)
    const blocked = expandRangeWeights(weights, [{ rank: 'A', suit: 'spades' }])
    expect(
      blocked.combos.filter((combo) => combo.handClass === 'AA'),
    ).toHaveLength(3)
    expect(
      blocked.combos.filter((combo) => combo.handClass === 'AKs'),
    ).toHaveLength(3)
    expect(
      blocked.combos.filter((combo) => combo.handClass === 'AKo'),
    ).toHaveLength(9)
    expect(
      blocked.combos.reduce((sum, combo) => sum + combo.weight, 0),
    ).toBeCloseTo(1)
    expect(
      blocked.chart.find((cell) => cell.handClass === 'AKo')?.normalizedMass,
    ).toBeCloseTo(9 / 15)
  })
})

import { makeOpponentRangePack } from '../fixtures/opponent-range-pack.js'
import {
  createStaticOpponentRangeRepository,
  assertRepositoryOpponentRangePack,
} from '../../src/poker-range/opponent-range-repository.js'
import {
  parseOpponentRangePack,
  type RangeApplicability,
  type RangeUpdateRule,
} from '../../src/poker-range/opponent-range-pack.js'
import {
  matchesRangeApplicability,
  createRangeMatchContext,
} from '../../src/poker-range/range-scenario.js'
import { applyRangeUpdates } from '../../src/poker-range/range-updater.js'
import { buildRangeAnalysis } from '../../src/poker-range/range-analysis.js'
import { normalizeDecisionSpot } from '../../src/poker/decision-spot.js'
import {
  createInitialBettingProjection,
  getProjectedLegalActions,
} from '../../src/poker/betting-projection.js'
import { assignLogicalPositions } from '../../src/poker/positioning.js'
import { POKER_RULE_SET_VERSION } from '../../src/poker/poker-rule-set.js'
import type {
  DecisionAnalysisInput,
  DecisionAnalysisPublicAction,
} from '../../src/poker/decision-analysis-input.js'

function decision(tableSize = 6): DecisionAnalysisInput {
  const participantSeatNumbers = Array.from({ length: tableSize }, (_, i) => i)
  const startingStacks = participantSeatNumbers.map((seatNumber) => ({
    seatNumber,
    stack: 2000,
  }))
  const state = createInitialBettingProjection({
    buttonSeatNumber: 0,
    participantSeatNumbers,
    smallBlindSeatNumber: 1,
    bigBlindSeatNumber: 2,
    startingStacks,
  })
  return {
    pokerRuleSetVersion: POKER_RULE_SET_VERSION,
    buttonSeatNumber: 0,
    participantSeatNumbers,
    heroSeatNumber: state.currentActorSeatNumber,
    street: 'preflop',
    positions: assignLogicalPositions(0, participantSeatNumbers),
    startingStacks,
    smallBlindSeatNumber: 1,
    bigBlindSeatNumber: 2,
    heroHoleCards: [
      { rank: '2', suit: 'clubs' },
      { rank: '3', suit: 'clubs' },
    ],
    board: [],
    pot: state.pot,
    seats: state.seats,
    bettingRound: state.bettingRound,
    legalActions: getProjectedLegalActions(state),
    publicActions: [],
  }
}
function applicability(
  input: DecisionAnalysisInput,
  seatNumber: number,
): RangeApplicability {
  const { effectiveStackBb, ...context } = createRangeMatchContext(
    input,
    normalizeDecisionSpot(input),
    seatNumber,
  )
  return {
    ...context,
    effectiveStackIntervalBb: { min: effectiveStackBb, max: effectiveStackBb },
  }
}
function populatedPack(input: DecisionAnalysisInput) {
  const ranges = input.seats
    .filter((seat) => seat.seatNumber !== input.heroSeatNumber)
    .map((seat) => ({
      rangeId: `seat-${seat.seatNumber}`,
      sourceRefs: ['fixture-source'],
      applicability: applicability(input, seat.seatNumber),
      matchStatus: 'matched' as const,
      differences: [],
      limitations: [],
      weights,
    }))
  return makeOpponentRangePack({
    initialRanges: ranges,
    coverageManifest: ranges.map((range) => ({
      rangeId: range.rangeId,
      status: 'matched',
      limitations: [],
    })),
    jointScenarios: [
      {
        scenarioId: 'base',
        name: 'synthetic base',
        sourceRefs: ['fixture-source'],
        initialRangeIds: ranges.map((range) => range.rangeId),
        updateRuleIds: [],
        allowUnmodeledActions: true,
        limitations: ['test-only'],
      },
    ],
  })
}

describe('range publication and pinned reads', () => {
  test('does not authenticate parsed copies and rejects missing/revoked/new deprecated reads', () => {
    const raw = makeOpponentRangePack()
    expect(() =>
      assertRepositoryOpponentRangePack(parseOpponentRangePack(raw)),
    ).toThrow('range_untrusted_pack')
    const repository = createStaticOpponentRangeRepository([
      raw,
      { ...raw, datasetVersion: 2, status: 'deprecated' },
      { ...raw, datasetVersion: 3, status: 'revoked' },
    ])
    expect(
      repository.read({
        reference: { datasetId: raw.datasetId, datasetVersion: 2 },
        usage: 'pinnedRun',
      }).status,
    ).toBe('deprecated')
    for (const [datasetVersion, usage, reason] of [
      [2, 'newRun', 'deprecated'],
      [3, 'pinnedRun', 'revoked'],
      [4, 'pinnedRun', 'missing'],
    ] as const) {
      expect(() =>
        repository.read({
          reference: { datasetId: raw.datasetId, datasetVersion },
          usage,
        }),
      ).toThrow(reason)
    }
    expect(() =>
      assertRepositoryOpponentRangePack(
        repository.resolveActiveForNewRun({
          pokerRuleSetVersion: POKER_RULE_SET_VERSION,
        }),
      ),
    ).not.toThrow()
  })
  test('rejects duplicate classes, missing authorization, unknown references and excess scenarios', () => {
    const raw = populatedPack(decision())
    const duplicate = structuredClone(raw)
    duplicate.initialRanges[0]!.weights[1] =
      duplicate.initialRanges[0]!.weights[0]!
    expect(() => parseOpponentRangePack(duplicate)).toThrow(
      'duplicate_hand_class',
    )
    expect(() =>
      parseOpponentRangePack({
        ...raw,
        sources: [{ ...raw.sources[0], authorizationRef: '' }],
      }),
    ).toThrow()
    expect(() =>
      parseOpponentRangePack({
        ...raw,
        jointScenarios: [
          { ...raw.jointScenarios[0], initialRangeIds: ['missing'] },
        ],
      }),
    ).toThrow('unknown_scenario_reference')
    expect(() =>
      parseOpponentRangePack({
        ...raw,
        jointScenarios: Array.from({ length: 4 }, (_, i) => ({
          ...raw.jointScenarios[0],
          scenarioId: `s${i}`,
        })),
      }),
    ).toThrow()
    expect(() =>
      parseOpponentRangePack({ ...raw, actionFrequency: 0.5 }),
    ).toThrow()
  })
})

describe('range scenario and updates', () => {
  test('requires exact table, position, line, topology, street and declared stack interval', () => {
    const input = decision()
    const context = createRangeMatchContext(
      input,
      normalizeDecisionSpot(input),
      0,
    )
    const match = applicability(input, 0)
    expect(matchesRangeApplicability(match, context)).toBe(true)
    for (const change of [
      { tableSize: 9 as const },
      { opponentLogicalPosition: 'BB' as const },
      { effectiveStackBb: 99 },
      { street: 'river' as const },
      {
        normalizedPreflopLine: [
          { actorPosition: 'UTG' as const, action: 'call' as const },
        ],
      },
      { participantTopology: { remainingSeatCount: 2, hasSidePot: false } },
    ]) {
      expect(matchesRangeApplicability(match, { ...context, ...change })).toBe(
        false,
      )
    }
  })
  test.each([6, 7, 8, 9])(
    'matches a published %i-seat scenario and rejects other table sizes',
    (tableSize) => {
      const input = decision(tableSize)
      const raw = populatedPack(input)
      const pack = createStaticOpponentRangeRepository([
        raw,
      ]).resolveActiveForNewRun({ pokerRuleSetVersion: POKER_RULE_SET_VERSION })
      const result = buildRangeAnalysis({ decision: input, pack })
      expect(result.status).toBe('matched')
      if (result.status === 'unavailable') throw new Error('expected coverage')
      expect(result.scenarios[0]!.opponents).toHaveLength(tableSize - 1)
      for (const otherSize of [6, 7, 8, 9].filter(
        (size) => size !== tableSize,
      )) {
        expect(
          buildRangeAnalysis({ decision: decision(otherSize), pack }),
        ).toMatchObject({
          status: 'unavailable',
          reasonCode: 'uncoveredScenario',
        })
      }
    },
  )
  test('updates only matching combo mass, preserves unmodeled actions and rejects overlapping rules', () => {
    const input = decision()
    const context = createRangeMatchContext(
      input,
      normalizeDecisionSpot(input),
      0,
    )
    const rule: RangeUpdateRule = {
      ruleId: 'increase-aa',
      sourceRefs: ['fixture-source'],
      rangeNodeApplicability: applicability(input, 0),
      street: 'preflop',
      observedAction: 'raise',
      betSizeInterval: null,
      handPredicate: { kind: 'handClasses', handClasses: ['AA'] },
      boardPredicate: { kind: 'any' },
      weightMultiplierBasisPoints: 20000,
      explanation: 'synthetic multiplier',
      limitations: [],
    }
    const action: DecisionAnalysisPublicAction = {
      eventSeq: 1,
      streetBefore: 'preflop',
      actorSeatNumber: 0,
      action: { type: 'raise', targetStreetCommitment: 60 },
      amountToCallBefore: 20,
      contributionDelta: 60,
      targetStreetCommitmentAfter: 60,
      totalContributionAfter: 60,
      potBefore: 30,
      currentBetBefore: 20,
      currentBetAfter: 60,
      minimumFullRaiseIncrementBefore: 20,
      minimumFullRaiseIncrementAfter: 40,
      isVoluntaryPreflopContribution: true,
      isFullRaise: true,
    }
    const combos = expandRangeWeights(weights, []).combos
    const updated = applyRangeUpdates({
      combos,
      actions: [action, { ...action, eventSeq: 2, action: { type: 'call' } }],
      context,
      board: [],
      rules: [rule],
    })
    expect(
      updated.combos
        .filter((combo) => combo.handClass === 'AA')
        .reduce((sum, combo) => sum + combo.weight, 0),
    ).toBeCloseTo(12 / 28)
    expect(updated.unmodeledActions).toEqual([2])
    expect(updated.updateTrace[0]?.sourceRefs).toEqual(['fixture-source'])
    expect(() =>
      applyRangeUpdates({
        combos,
        actions: [action],
        context,
        board: [],
        rules: [rule, { ...rule, ruleId: 'overlap' }],
      }),
    ).toThrow('range_ambiguous_update')
  })
  test('builds all required opponents from authenticated pack and never silently drops one', () => {
    const input = decision()
    const raw = populatedPack(input)
    const repository = createStaticOpponentRangeRepository([raw])
    const pack = repository.resolveActiveForNewRun({
      pokerRuleSetVersion: POKER_RULE_SET_VERSION,
    })
    const result = buildRangeAnalysis({ decision: input, pack })
    expect(result.status).toBe('matched')
    if (result.status === 'unavailable') throw new Error('expected coverage')
    expect(result.scenarios[0]?.opponents).toHaveLength(5)
    expect(result.scenarios[0]?.opponents[0]?.chart).toHaveLength(169)
    const missing = structuredClone(raw)
    missing.jointScenarios.push({
      ...missing.jointScenarios[0]!,
      scenarioId: 'tighter',
      initialRangeIds: missing.jointScenarios[0]!.initialRangeIds.slice(0, -1),
    })
    const incomplete = createStaticOpponentRangeRepository([
      missing,
    ]).resolveActiveForNewRun({ pokerRuleSetVersion: POKER_RULE_SET_VERSION })
    expect(
      buildRangeAnalysis({ decision: input, pack: incomplete }),
    ).toMatchObject({ status: 'unavailable', reasonCode: 'uncoveredScenario' })
    expect(() => buildRangeAnalysis({ decision: input, pack: raw })).toThrow(
      'range_untrusted_pack',
    )
  })
})
