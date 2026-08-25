import type { Card, CardRank, CardSuit } from '@tx-holdem-coach/contracts'
import { describe, expect, test } from 'vitest'
import {
  analyzeHandFeatures,
  HAND_FEATURE_ANALYZER_VERSION,
  HAND_FEATURE_SCHEMA_VERSION,
} from '../../src/poker/hand-features.js'
import { POKER_RULE_SET_VERSION } from '../../src/poker/poker-rule-set.js'

function card(rank: CardRank, suit: CardSuit): Card {
  return { rank, suit }
}

function analyze(
  street: 'preflop' | 'flop' | 'turn' | 'river',
  heroHoleCards: readonly [Card, Card],
  board: readonly Card[],
) {
  return analyzeHandFeatures({
    pokerRuleSetVersion: POKER_RULE_SET_VERSION,
    street,
    heroHoleCards,
    board,
  })
}

describe('HandFeatureAnalyzer preflop facts', () => {
  test.each([
    {
      name: 'K2s',
      cards: [card('K', 'spades'), card('2', 'spades')] as const,
      expected: {
        startingHandClass: 'K2s',
        isPair: false,
        isSuited: true,
        rankGap: 10,
        isConnector: false,
        isBroadway: false,
        aceWheelPotential: false,
      },
    },
    {
      name: 'AA',
      cards: [card('A', 'spades'), card('A', 'hearts')] as const,
      expected: {
        startingHandClass: 'AA',
        isPair: true,
        isSuited: false,
        rankGap: null,
        isConnector: false,
        isBroadway: true,
        aceWheelPotential: false,
      },
    },
    {
      name: 'A5s',
      cards: [card('5', 'hearts'), card('A', 'hearts')] as const,
      expected: {
        startingHandClass: 'A5s',
        isPair: false,
        isSuited: true,
        rankGap: 8,
        isConnector: false,
        isBroadway: false,
        aceWheelPotential: true,
      },
    },
  ])('classifies $name without heuristic labels', ({ cards, expected }) => {
    const result = analyze('preflop', cards, [])
    expect(result.kind).toBe('preflop')
    if (result.kind !== 'preflop') throw new Error('Expected preflop facts.')
    expect(result).toMatchObject({
      handFeatureSchemaVersion: HAND_FEATURE_SCHEMA_VERSION,
      analyzerVersion: HAND_FEATURE_ANALYZER_VERSION,
      startingHandClass: expected.startingHandClass,
      isPair: expected.isPair,
      isSuited: expected.isSuited,
      isConnector: expected.isConnector,
      isBroadway: expected.isBroadway,
      aceWheelPotential: expected.aceWheelPotential,
    })
    expect(
      result.rankGap.status === 'available' ? result.rankGap.value : null,
    ).toBe(expected.rankGap)
    expect(result.unavailableFacts.expectedValue).toMatchObject({
      status: 'unavailable',
      reasonCode: 'noVersionedOpponentRange',
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.unavailableFacts)).toBe(true)
  })

  test('produces a stable visible-card hash independent of Hero card order', () => {
    const left = analyze(
      'preflop',
      [card('K', 'spades'), card('2', 'spades')],
      [],
    )
    const right = analyze(
      'preflop',
      [card('2', 'spades'), card('K', 'spades')],
      [],
    )
    expect(right.visibleCardsSha256).toBe(left.visibleCardsSha256)
    if (left.kind !== 'preflop' || right.kind !== 'preflop') {
      throw new Error('Expected preflop facts.')
    }
    expect(right.startingHandClass).toBe(left.startingHandClass)
  })
})

describe('HandFeatureAnalyzer postflop facts', () => {
  test('derives a top pair, best five, kickers and atomic board structure', () => {
    const result = analyze(
      'flop',
      [card('K', 'spades'), card('Q', 'hearts')],
      [card('K', 'diamonds'), card('7', 'clubs'), card('2', 'spades')],
    )
    if (result.kind !== 'postflop') throw new Error('Expected postflop facts.')
    expect(result).toMatchObject({
      handCategory: 'onePair',
      pairRelation: 'topPair',
      holeCardsUsed: 2,
      madeHandUsesBoardOnly: false,
      overcardCount: 0,
      boardStructure: {
        suitPattern: 'rainbow',
        maxSuitCount: 1,
        rankMultiplicity: { pairs: [], trips: [], quads: [] },
        maximumConsecutiveRankRun: 1,
        streetDelta: {
          status: 'notApplicable',
          reasonCode: 'noPriorPostflopStreet',
        },
      },
    })
    expect(result.bestFiveCards).toHaveLength(5)
    expect(result.kickerRanks).toContain('Q')
    expect(result.flushHighRank.status).toBe('notApplicable')
    expect(result.straightHighRank.status).toBe('notApplicable')
    expect(result.cardRemovalFacts).toHaveLength(5)
    expect(result.counterfeitRiskFacts.status).toBe('available')
    if (result.counterfeitRiskFacts.status === 'available') {
      expect(result.counterfeitRiskFacts.value.length).toBeGreaterThan(0)
    }
  })

  test('enumerates a combo draw once per card and records overlapping improvements', () => {
    const result = analyze(
      'flop',
      [card('A', 'hearts'), card('K', 'hearts')],
      [card('Q', 'hearts'), card('J', 'hearts'), card('2', 'clubs')],
    )
    if (result.kind !== 'postflop') throw new Error('Expected postflop facts.')
    expect(result.drawTypes).toEqual(
      expect.arrayContaining(['flushDraw', 'gutshot', 'comboDraw']),
    )
    expect(result.structuralOutCards.status).toBe('available')
    expect(result.overlappingOutGroups.status).toBe('available')
    if (
      result.structuralOutCards.status === 'available' &&
      result.overlappingOutGroups.status === 'available'
    ) {
      const structuralKeys = result.structuralOutCards.value.map(
        ({ card: out }) => `${out.rank}:${out.suit}`,
      )
      expect(new Set(structuralKeys).size).toBe(structuralKeys.length)
      expect(result.overlappingOutGroups.value).toContainEqual(
        expect.objectContaining({
          card: card('T', 'hearts'),
          improvementKinds: expect.arrayContaining([
            'completesFlush',
            'completesStraight',
          ]),
        }),
      )
    }
    expect(result.unavailableFacts.cleanOuts.status).toBe('unavailable')
    expect(result.unavailableFacts.actualReverseOuts.status).toBe('unavailable')
    expect(result.unavailableFacts.strategicBlockerValue.status).toBe(
      'unavailable',
    )
  })

  test('recognizes a board-only absolute nut hand without attributing it to Hero', () => {
    const result = analyze(
      'river',
      [card('A', 'hearts'), card('2', 'diamonds')],
      [
        card('A', 'spades'),
        card('K', 'hearts'),
        card('Q', 'diamonds'),
        card('J', 'clubs'),
        card('T', 'spades'),
      ],
    )
    if (result.kind !== 'postflop') throw new Error('Expected postflop facts.')
    expect(result).toMatchObject({
      handCategory: 'straight',
      holeCardsUsed: 0,
      madeHandUsesBoardOnly: true,
      boardStructure: {
        handTransition: {
          status: 'available',
          value: { holeCardsUsedBefore: 1, holeCardsUsedAfter: 0 },
        },
      },
      absoluteNuts: { status: 'available', value: true },
      structuralOutCards: {
        status: 'notApplicable',
        reasonCode: 'noFutureDecisionStreet',
      },
      counterfeitRiskFacts: {
        status: 'notApplicable',
        reasonCode: 'noFutureDecisionStreet',
      },
    })
    expect(result.straightHighRank).toMatchObject({
      status: 'available',
      value: 'A',
    })
    expect(result.bestFiveCards).toEqual(
      expect.arrayContaining([
        card('A', 'spades'),
        card('K', 'hearts'),
        card('Q', 'diamonds'),
        card('J', 'clubs'),
        card('T', 'spades'),
      ]),
    )
  })

  test('attributes a board pair to the board even when Hero kickers play', () => {
    const result = analyze(
      'river',
      [card('A', 'hearts'), card('K', 'diamonds')],
      [
        card('Q', 'spades'),
        card('Q', 'clubs'),
        card('J', 'diamonds'),
        card('7', 'hearts'),
        card('2', 'clubs'),
      ],
    )
    if (result.kind !== 'postflop') throw new Error('Expected postflop facts.')
    expect(result).toMatchObject({
      handCategory: 'onePair',
      holeCardsUsed: 2,
      pairRelation: 'boardPairOnly',
      madeHandUsesBoardOnly: false,
    })
  })

  test('records turn street delta and the Hero hand transition', () => {
    const result = analyze(
      'turn',
      [card('K', 'spades'), card('Q', 'hearts')],
      [
        card('K', 'diamonds'),
        card('7', 'clubs'),
        card('2', 'spades'),
        card('K', 'clubs'),
      ],
    )
    if (result.kind !== 'postflop') throw new Error('Expected postflop facts.')
    expect(result).toMatchObject({
      handCategory: 'threeOfAKind',
      pairRelation: 'tripsUsingOneHole',
      boardStructure: {
        rankMultiplicity: { pairs: ['K'], trips: [], quads: [] },
        streetDelta: {
          status: 'available',
          value: {
            addedCard: card('K', 'clubs'),
            changedRank: { rank: 'K', countBefore: 1, countAfter: 2 },
          },
        },
        handTransition: {
          status: 'available',
          value: {
            categoryBefore: 'onePair',
            categoryAfter: 'threeOfAKind',
            holeCardsUsedBefore: 2,
            holeCardsUsedAfter: 2,
          },
        },
      },
    })
  })
})

describe('HandFeatureAnalyzer input boundary', () => {
  test('rejects street/card mismatches, duplicate cards and unknown fields', () => {
    expect(() =>
      analyze(
        'turn',
        [card('A', 'spades'), card('K', 'spades')],
        [card('Q', 'spades'), card('J', 'spades'), card('T', 'spades')],
      ),
    ).toThrow('公共牌数量必须与街道精确对应。')
    expect(() =>
      analyze(
        'flop',
        [card('A', 'spades'), card('K', 'spades')],
        [card('A', 'spades'), card('J', 'hearts'), card('T', 'clubs')],
      ),
    ).toThrow('Hero 底牌与公共牌不得重复。')
    expect(() =>
      analyzeHandFeatures({
        pokerRuleSetVersion: POKER_RULE_SET_VERSION,
        street: 'preflop',
        heroHoleCards: [card('A', 'spades'), card('K', 'spades')],
        board: [],
        remainingDeck: [],
      } as never),
    ).toThrow()
  })

  test('does not retain or freeze caller-owned card objects', () => {
    const hero = [card('A', 'spades'), card('K', 'hearts')] as [Card, Card]
    const board = [
      card('Q', 'diamonds'),
      card('J', 'clubs'),
      card('2', 'spades'),
    ]
    const result = analyze('flop', hero, board)
    expect(Object.isFrozen(hero)).toBe(false)
    expect(Object.isFrozen(hero[0])).toBe(false)
    expect(Object.isFrozen(board)).toBe(false)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.sourceRefs)).toBe(true)
  })
})
