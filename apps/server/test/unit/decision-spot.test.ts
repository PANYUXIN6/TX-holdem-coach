import { describe, expect, test } from 'vitest'

import {
  createCommittedActionProof,
  createInitialBettingProjection,
  getProjectedLegalActions,
  projectActionContinuation,
  projectBettingTransition,
  type BettingProjectionState,
} from '../../src/poker/betting-projection.js'
import { STANDARD_DECK } from '../../src/poker/cards.js'
import type { PokerCommand } from '../../src/poker/commands.js'
import type {
  DecisionAnalysisInput,
  DecisionAnalysisPublicAction,
} from '../../src/poker/decision-analysis-input.js'
import { normalizeDecisionSpot } from '../../src/poker/decision-spot.js'
import { POKER_RULE_SET_VERSION } from '../../src/poker/poker-rule-set.js'
import { assignLogicalPositions } from '../../src/poker/positioning.js'

interface ScenarioOptions {
  tableSize?: 6 | 7 | 8 | 9
  startingStacks?: Readonly<Record<number, number>>
}

function createScenario(options: ScenarioOptions = {}) {
  const tableSize = options.tableSize ?? 6
  const participantSeatNumbers = Array.from(
    { length: tableSize },
    (_, seatNumber) => seatNumber,
  )
  const startingStacks = participantSeatNumbers.map((seatNumber) => ({
    seatNumber,
    stack: options.startingStacks?.[seatNumber] ?? 2_000,
  }))
  let state: BettingProjectionState = createInitialBettingProjection({
    buttonSeatNumber: 0,
    participantSeatNumbers,
    smallBlindSeatNumber: 1,
    bigBlindSeatNumber: 2,
    startingStacks,
  })
  const publicActions: DecisionAnalysisPublicAction[] = []

  function act(
    expectedActorSeatNumber: number,
    action: PokerCommand['action'],
  ): void {
    expect(state.currentActorSeatNumber).toBe(expectedActorSeatNumber)
    const transition = projectBettingTransition(
      state,
      createCommittedActionProof(
        { actorSeatNumber: expectedActorSeatNumber, action },
        getProjectedLegalActions(state),
      ),
    )
    publicActions.push({
      eventSeq: publicActions.length + 1,
      streetBefore: state.street,
      actorSeatNumber: transition.actorSeatNumber,
      action: transition.action,
      amountToCallBefore: transition.amountToCallBefore,
      contributionDelta: transition.contributionDelta,
      targetStreetCommitmentAfter: transition.targetStreetCommitmentAfter,
      totalContributionAfter: transition.totalContributionAfter,
      potBefore: transition.potBefore,
      currentBetBefore: transition.currentBetBefore,
      currentBetAfter: transition.currentBetAfter,
      minimumFullRaiseIncrementBefore:
        transition.minimumFullRaiseIncrementBefore,
      minimumFullRaiseIncrementAfter: transition.minimumFullRaiseIncrementAfter,
      isVoluntaryPreflopContribution: transition.isVoluntaryPreflopContribution,
      isFullRaise: transition.isFullRaise,
    })
    const continuation = projectActionContinuation(
      transition.state,
      transition.actorSeatNumber,
    )
    if (
      continuation.kind !== 'sameStreet' &&
      continuation.kind !== 'nextStreet'
    ) {
      throw new Error(`测试脚本意外结束牌局：${continuation.kind}`)
    }
    state = continuation.state
  }

  function input(): DecisionAnalysisInput {
    const boardCardCount =
      state.street === 'preflop'
        ? 0
        : state.street === 'flop'
          ? 3
          : state.street === 'turn'
            ? 4
            : 5
    const firstHoleCard = STANDARD_DECK[0]
    const secondHoleCard = STANDARD_DECK[1]
    if (firstHoleCard === undefined || secondHoleCard === undefined) {
      throw new Error('标准牌组不完整。')
    }
    return {
      pokerRuleSetVersion: POKER_RULE_SET_VERSION,
      buttonSeatNumber: 0,
      participantSeatNumbers,
      heroSeatNumber: state.currentActorSeatNumber,
      street: state.street,
      positions: assignLogicalPositions(0, participantSeatNumbers),
      startingStacks,
      smallBlindSeatNumber: 1,
      bigBlindSeatNumber: 2,
      heroHoleCards: [firstHoleCard, secondHoleCard],
      board: STANDARD_DECK.slice(2, 2 + boardCardCount),
      pot: state.pot,
      seats: state.seats,
      bettingRound: state.bettingRound,
      legalActions: getProjectedLegalActions(state),
      publicActions,
    }
  }

  return { act, input }
}

function bigBlindOptionScenario(): DecisionAnalysisInput {
  const scenario = createScenario()
  scenario.act(3, { type: 'call' })
  scenario.act(4, { type: 'fold' })
  scenario.act(5, { type: 'fold' })
  scenario.act(0, { type: 'fold' })
  scenario.act(1, { type: 'fold' })
  return scenario.input()
}

describe('decision spot normalizer', () => {
  test('recognizes the unraised big-blind option and projects every legal candidate topology', () => {
    const spot = normalizeDecisionSpot(bigBlindOptionScenario())

    expect(spot).toMatchObject({
      spotSchemaVersion: 1,
      normalizerVersion: 1,
      tableSize: 6,
      heroPosition: 'BB',
      bigBlindOptionAvailable: true,
      actionOrder: [3, 4, 5, 0, 1, 2],
      playersBehindHero: [3],
      preflopNode: {
        kind: 'limped',
        fullRaiseCount: 0,
        limperCount: 1,
      },
      lastFullRaise: {
        status: 'available',
        value: {
          targetStreetCommitment: 20,
          increment: 20,
          source: 'forcedBigBlind',
          actorSeatNumber: 2,
        },
      },
    })
    expect(spot.forcedPosts).toEqual([
      {
        seatNumber: 1,
        kind: 'smallBlind',
        nominalAmount: 10,
        actualAmount: 10,
        isAllIn: false,
      },
      {
        seatNumber: 2,
        kind: 'bigBlind',
        nominalAmount: 20,
        actualAmount: 20,
        isAllIn: false,
      },
    ])

    const check = spot.decisionTopology.find(
      ({ actionType }) => actionType === 'check',
    )
    const raise = spot.decisionTopology.find(
      ({ actionType }) => actionType === 'raise',
    )
    const fold = spot.decisionTopology.find(
      ({ actionType }) => actionType === 'fold',
    )
    expect(check).toMatchObject({
      targetStreetCommitment: null,
      heroActionCompletes: true,
      bettingRoundClosesImmediately: true,
      canFaceFurtherAction: false,
    })
    expect(raise).toMatchObject({
      heroActionCompletes: true,
      bettingRoundClosesImmediately: false,
      canFaceFurtherAction: true,
    })
    expect(fold).toMatchObject({
      bettingRoundClosesImmediately: true,
      canFaceFurtherAction: false,
    })
    expect(spot.decisionTopology).toHaveLength(
      bigBlindOptionScenario().legalActions.reduce(
        (count, action) =>
          count +
          (action.type === 'raise' || action.type === 'bet'
            ? action.suggestedTargets.length
            : 1),
        0,
      ),
    )
  })

  test('distinguishes single-raised, squeeze, and ordinary re-raise trees', () => {
    const singleRaised = createScenario()
    singleRaised.act(3, { type: 'raise', targetStreetCommitment: 60 })

    const squeeze = createScenario()
    squeeze.act(3, { type: 'raise', targetStreetCommitment: 60 })
    squeeze.act(4, { type: 'call' })
    squeeze.act(5, { type: 'raise', targetStreetCommitment: 200 })

    const reRaise = createScenario()
    reRaise.act(3, { type: 'raise', targetStreetCommitment: 60 })
    reRaise.act(4, { type: 'raise', targetStreetCommitment: 140 })

    expect(normalizeDecisionSpot(singleRaised.input())).toMatchObject({
      preflopNode: { kind: 'singleRaised', fullRaiseCount: 1, callerCount: 0 },
      potType: { kind: 'singleRaised' },
    })
    expect(normalizeDecisionSpot(squeeze.input())).toMatchObject({
      preflopNode: { kind: 'squeezed', fullRaiseCount: 2, callerCount: 1 },
      potType: { kind: 'threeBet' },
    })
    expect(normalizeDecisionSpot(reRaise.input())).toMatchObject({
      preflopNode: { kind: 'threeBet', fullRaiseCount: 2, callerCount: 0 },
      lastFullRaise: {
        status: 'available',
        value: {
          targetStreetCommitment: 140,
          increment: 80,
          actorSeatNumber: 4,
        },
      },
    })
  })

  test('tracks a short all-in without reopening action for the original raiser', () => {
    const scenario = createScenario({ startingStacks: { 5: 80 } })
    scenario.act(3, { type: 'raise', targetStreetCommitment: 60 })
    scenario.act(4, { type: 'call' })
    scenario.act(5, { type: 'allIn' })
    scenario.act(0, { type: 'call' })
    scenario.act(1, { type: 'call' })
    scenario.act(2, { type: 'call' })
    const spot = normalizeDecisionSpot(scenario.input())

    expect(spot.heroPosition).toBe('UTG')
    expect(spot.preflopNode).toMatchObject({
      kind: 'shortAllInTree',
      fullRaiseCount: 1,
      hasShortAllInRaise: true,
    })
    expect(spot.lastFullRaise).toMatchObject({
      status: 'available',
      value: { targetStreetCommitment: 60, increment: 40, actorSeatNumber: 3 },
    })
    expect(spot.raiseReopenedForHero).toBe(false)
    expect(spot.actionLine.at(-1)).toMatchObject({
      currentBetBefore: 80,
      currentBetAfter: 80,
      minimumFullRaiseIncrementAfter: 40,
    })
  })

  test('retains preflop history across the street reset and detects a multiway side pot', () => {
    const scenario = createScenario({ startingStacks: { 3: 50 } })
    scenario.act(3, { type: 'allIn' })
    scenario.act(4, { type: 'raise', targetStreetCommitment: 100 })
    scenario.act(5, { type: 'call' })
    scenario.act(0, { type: 'call' })
    scenario.act(1, { type: 'call' })
    scenario.act(2, { type: 'call' })
    const input = scenario.input()
    const spot = normalizeDecisionSpot(input)

    expect(input.street).toBe('flop')
    expect(input.bettingRound).toMatchObject({
      currentBet: 0,
      minimumFullRaiseIncrement: 20,
    })
    expect(
      input.seats.every(({ streetContribution }) => streetContribution === 0),
    ).toBe(true)
    expect(spot).toMatchObject({
      preflopNode: {
        kind: 'notApplicable',
        fullRaiseCount: 2,
        hasShortAllInRaise: false,
      },
      potType: {
        kind: 'multiwaySidePot',
        isMultiway: true,
        hasSidePot: true,
      },
      playerCounts: { activeCount: 5, allInCount: 1, notFoldedCount: 6 },
      lastFullRaise: { status: 'notApplicable', reasonCode: 'noBetOnStreet' },
      initiative: {
        lastPreflopFullAggressorSeatNumber: 4,
        lastPreflopFullAggressorStillInHand: true,
        lastCurrentStreetFullAggressorSeatNumber: null,
      },
    })
    expect(spot.actionLine).toHaveLength(6)
    expect(spot.actionLine[0]).toMatchObject({
      actionType: 'allIn',
      contributionDelta: 50,
      targetStreetCommitmentAfter: 50,
      currentBetBefore: 20,
      currentBetAfter: 50,
      isFullRaise: true,
    })
  })

  test('distinguishes a short postflop open all-in from no bet on the street', () => {
    const scenario = createScenario({ startingStacks: { 1: 35 } })
    scenario.act(3, { type: 'fold' })
    scenario.act(4, { type: 'fold' })
    scenario.act(5, { type: 'fold' })
    scenario.act(0, { type: 'call' })
    scenario.act(1, { type: 'call' })
    scenario.act(2, { type: 'check' })
    scenario.act(1, { type: 'allIn' })

    const input = scenario.input()
    const spot = normalizeDecisionSpot(input)

    expect(input.street).toBe('flop')
    expect(input.bettingRound.currentBet).toBe(15)
    expect(spot.actionLine.at(-1)).toMatchObject({
      actionType: 'allIn',
      currentBetBefore: 0,
      currentBetAfter: 15,
      isFullRaise: false,
    })
    expect(spot.lastFullRaise).toEqual({
      status: 'notApplicable',
      reasonCode: 'noFullRaiseOnStreet',
      sourceRefs: [
        {
          kind: 'analysisInputField',
          path: 'hand.publicActions',
          eventSeq: null,
        },
        {
          kind: 'analysisInputField',
          path: 'hand.bettingRound',
          eventSeq: null,
        },
      ],
      assumptionCodes: [],
    })
    expect(spot.initiative.lastCurrentStreetFullAggressorSeatNumber).toBeNull()
  })

  test('normalizes positions, player counts, action order, and every effective-stack band', () => {
    const scenario = createScenario({
      startingStacks: {
        0: 4_000,
        1: 2_010,
        2: 1_220,
        3: 5_000,
        4: 600,
        5: 300,
      },
    })
    const spot = normalizeDecisionSpot(scenario.input())

    expect(spot.heroPosition).toBe('UTG')
    expect(spot.playerCounts).toEqual({
      dealtCount: 6,
      remainingSeatCount: 6,
      notFoldedCount: 6,
      activeCount: 6,
      allInCount: 0,
      voluntaryPreflopParticipantCount: 0,
      currentlyOwingActionCount: 6,
    })
    expect(spot.actionOrder).toEqual([4, 5, 0, 1, 2, 3])
    expect(spot.playersBehindHero).toEqual([4, 5, 0, 1, 2])
    expect(
      spot.effectiveStackBandsByOpponent.map(
        ({ opponentSeatNumber, effectiveStackChips, band }) => [
          opponentSeatNumber,
          effectiveStackChips,
          band,
        ],
      ),
    ).toEqual([
      [0, 4_000, 'ge150bb'],
      [1, 2_000, '80to149bb'],
      [2, 1_200, '40to79bb'],
      [4, 600, '20to39bb'],
      [5, 300, 'lt20bb'],
    ])
    expect(
      spot.positionsByOpponent.find(
        ({ opponentSeatNumber }) => opponentSeatNumber === 1,
      ),
    ).toMatchObject({
      opponentPosition: 'SB',
      preflopActsBeforeHero: false,
      currentStreetActsBeforeHero: false,
      relativePosition: 'inPosition',
    })
    expect(
      spot.positionsByOpponent.find(
        ({ opponentSeatNumber }) => opponentSeatNumber === 0,
      ),
    ).toMatchObject({
      opponentPosition: 'BTN',
      relativePosition: 'outOfPosition',
    })
  })

  test.each([6, 7, 8, 9] as const)(
    'supports a %i-handed table',
    (tableSize) => {
      const spot = normalizeDecisionSpot(createScenario({ tableSize }).input())
      expect(spot.tableSize).toBe(tableSize)
      expect(spot.positionsByOpponent).toHaveLength(tableSize - 1)
      expect(spot.actionOrder).toHaveLength(tableSize)
    },
  )

  test('uses canonical strategy facts for spotKey and deeply freezes the result', () => {
    const input = bigBlindOptionScenario()
    const replacementFirst = STANDARD_DECK[20]
    const replacementSecond = STANDARD_DECK[21]
    if (replacementFirst === undefined || replacementSecond === undefined) {
      throw new Error('标准牌组不完整。')
    }
    const changedCards: DecisionAnalysisInput = {
      ...structuredClone(input),
      heroHoleCards: [replacementFirst, replacementSecond],
    }
    const changedEvidenceSequence: DecisionAnalysisInput = {
      ...structuredClone(input),
      publicActions: input.publicActions.map((action) => ({
        ...action,
        eventSeq: action.eventSeq + 100,
      })),
    }
    const changedExactStackWithinBand: DecisionAnalysisInput = {
      ...structuredClone(input),
      seats: input.seats.map((seat) =>
        seat.seatNumber === 3 ? { ...seat, stack: 1_900 } : { ...seat },
      ),
    }

    const first = normalizeDecisionSpot(input)
    const second = normalizeDecisionSpot(structuredClone(input))
    const cardsChanged = normalizeDecisionSpot(changedCards)
    const evidenceSequenceChanged = normalizeDecisionSpot(
      changedEvidenceSequence,
    )
    const exactStackChanged = normalizeDecisionSpot(changedExactStackWithinBand)
    const raisedScenario = createScenario()
    raisedScenario.act(3, { type: 'raise', targetStreetCommitment: 60 })
    const raisedInput = raisedScenario.input()
    const raisedEvidenceSequenceChanged: DecisionAnalysisInput = {
      ...structuredClone(raisedInput),
      publicActions: raisedInput.publicActions.map((action) => ({
        ...action,
        eventSeq: action.eventSeq + 100,
      })),
    }

    expect(first.spotKey).toMatch(/^[0-9a-f]{64}$/)
    expect(second.spotKey).toBe(first.spotKey)
    expect(cardsChanged.spotKey).toBe(first.spotKey)
    expect(evidenceSequenceChanged.spotKey).toBe(first.spotKey)
    expect(exactStackChanged.effectiveStackBandsByOpponent).not.toEqual(
      first.effectiveStackBandsByOpponent,
    )
    expect(exactStackChanged.spotKey).toBe(first.spotKey)
    expect(normalizeDecisionSpot(raisedEvidenceSequenceChanged).spotKey).toBe(
      normalizeDecisionSpot(raisedInput).spotKey,
    )
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.positionsByOpponent)).toBe(true)
    expect(Object.isFrozen(first.positionsByOpponent[0])).toBe(true)
    expect(Object.isFrozen(first.lastFullRaise)).toBe(true)
    expect(Object.isFrozen(first.decisionTopology)).toBe(true)
    expect(Object.isFrozen(first.decisionTopology[0])).toBe(true)
  })

  test('rejects a legal-action catalog that is inconsistent with the supplied state', () => {
    const source = bigBlindOptionScenario()
    const input: DecisionAnalysisInput = {
      ...structuredClone(source),
      legalActions: source.legalActions.filter(({ type }) => type !== 'check'),
    }

    expect(() => normalizeDecisionSpot(input)).toThrow(
      /legalActions do not match the betting projection/,
    )
  })
})
