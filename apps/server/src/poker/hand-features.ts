import { createHash } from 'node:crypto'
import {
  CARD_RANKS,
  CARD_SUITS,
  CardSchema,
  type Card,
  type CardRank,
  type CardSuit,
} from '@tx-holdem-coach/contracts'
import { z } from 'zod'
import { STANDARD_DECK } from './cards.js'
import type { CoreFactSourceRef } from './decision-analysis-types.js'
import {
  handEvaluator,
  type HandCategory,
  type HandEvaluation,
} from './hand-evaluator.js'
import {
  classifyStartingHand,
  type StartingHandCategory,
} from './hand-result.js'
import {
  POKER_RULE_SET_VERSION,
  type PokerRuleSetVersion,
} from './poker-rule-set.js'

export const HAND_FEATURE_SCHEMA_VERSION = 1 as const
export const HAND_FEATURE_ANALYZER_VERSION = 1 as const

const HandFeatureStreetSchema = z.enum(['preflop', 'flop', 'turn', 'river'])
const HandFeatureInputSchema = z.strictObject({
  pokerRuleSetVersion: z.literal(POKER_RULE_SET_VERSION),
  street: HandFeatureStreetSchema,
  heroHoleCards: z.tuple([CardSchema, CardSchema]),
  board: z.array(CardSchema).max(5),
})

const RANK_VALUE = Object.freeze(
  Object.fromEntries(CARD_RANKS.map((rank, index) => [rank, index])) as Record<
    CardRank,
    number
  >,
)
const CARD_ORDER = new Map(
  STANDARD_DECK.map((card, index) => [cardKey(card), index]),
)
const HAND_CATEGORY_VALUE = Object.freeze({
  highCard: 0,
  onePair: 1,
  twoPair: 2,
  threeOfAKind: 3,
  straight: 4,
  flush: 5,
  fullHouse: 6,
  fourOfAKind: 7,
  straightFlush: 8,
} satisfies Record<HandCategory, number>)

const STRAIGHT_WINDOWS = Object.freeze([
  { highRank: '5', ranks: ['A', '2', '3', '4', '5'] },
  { highRank: '6', ranks: ['2', '3', '4', '5', '6'] },
  { highRank: '7', ranks: ['3', '4', '5', '6', '7'] },
  { highRank: '8', ranks: ['4', '5', '6', '7', '8'] },
  { highRank: '9', ranks: ['5', '6', '7', '8', '9'] },
  { highRank: 'T', ranks: ['6', '7', '8', '9', 'T'] },
  { highRank: 'J', ranks: ['7', '8', '9', 'T', 'J'] },
  { highRank: 'Q', ranks: ['8', '9', 'T', 'J', 'Q'] },
  { highRank: 'K', ranks: ['9', 'T', 'J', 'Q', 'K'] },
  { highRank: 'A', ranks: ['T', 'J', 'Q', 'K', 'A'] },
] as const satisfies readonly {
  readonly highRank: CardRank
  readonly ranks: readonly CardRank[]
}[])

export type HandFeatureStreet = z.infer<typeof HandFeatureStreetSchema>

export interface AnalyzeHandFeaturesInput {
  readonly pokerRuleSetVersion: PokerRuleSetVersion
  readonly street: HandFeatureStreet
  readonly heroHoleCards: readonly [Card, Card]
  readonly board: readonly Card[]
}

export type HandFeatureSourceRef = CoreFactSourceRef

export type HandFeatureFact<T> =
  | {
      readonly status: 'available'
      readonly value: T
      readonly epistemicKind: 'ruleFact' | 'formulaFact'
      readonly sourceRefs: readonly HandFeatureSourceRef[]
      readonly assumptionCodes: readonly string[]
    }
  | {
      readonly status: 'unavailable'
      readonly reasonCode: 'noVersionedOpponentRange'
      readonly sourceRefs: readonly HandFeatureSourceRef[]
      readonly assumptionCodes: readonly string[]
    }
  | {
      readonly status: 'notApplicable'
      readonly reasonCode:
        | 'pairHasNoRankGap'
        | 'noPriorPostflopStreet'
        | 'notCurrentHandCategory'
        | 'noFutureDecisionStreet'
        | 'insufficientRanks'
      readonly sourceRefs: readonly HandFeatureSourceRef[]
      readonly assumptionCodes: readonly string[]
    }

export interface StraightWindowFact {
  readonly highRank: CardRank
  readonly occupiedRanks: readonly CardRank[]
  readonly missingRanks: readonly CardRank[]
  readonly duplicateBoardCards: number
}

export interface BoardStructureCore {
  readonly suitCounts: readonly {
    readonly suit: CardSuit
    readonly count: number
  }[]
  readonly maxSuitCount: number
  readonly suitPattern: 'monotone' | 'twoTone' | 'rainbow' | 'mixed'
  readonly rankCounts: readonly {
    readonly rank: CardRank
    readonly count: number
  }[]
  readonly uniqueRanks: readonly CardRank[]
  readonly rankMultiplicity: {
    readonly pairs: readonly CardRank[]
    readonly trips: readonly CardRank[]
    readonly quads: readonly CardRank[]
  }
  readonly straightWindows: readonly StraightWindowFact[]
  readonly maximumConsecutiveRankRun: number
  readonly minimumInternalGap: HandFeatureFact<number>
  readonly candidateStraightWindowCount: number
  readonly boardHighRank: CardRank
  readonly boardLowRank: CardRank
}

export interface BoardStreetDelta {
  readonly addedCard: Card
  readonly changedSuit: {
    readonly suit: CardSuit
    readonly countBefore: number
    readonly countAfter: number
  }
  readonly changedRank: {
    readonly rank: CardRank
    readonly countBefore: number
    readonly countAfter: number
  }
  readonly changedStraightWindows: readonly {
    readonly highRank: CardRank
    readonly missingRanksBefore: readonly CardRank[]
    readonly missingRanksAfter: readonly CardRank[]
  }[]
}

export interface HandTransitionFact {
  readonly categoryBefore: HandCategory
  readonly categoryAfter: HandCategory
  readonly comparisonGradeBefore: HandEvaluation['comparisonGrade']
  readonly comparisonGradeAfter: HandEvaluation['comparisonGrade']
  readonly holeCardsUsedBefore: 0 | 1 | 2
  readonly holeCardsUsedAfter: 0 | 1 | 2
}

export interface BoardStructureFacts extends BoardStructureCore {
  readonly streetDelta: HandFeatureFact<BoardStreetDelta>
  readonly handTransition: HandFeatureFact<HandTransitionFact>
}

export type PairRelation =
  | 'none'
  | 'pocketPairBelowBoard'
  | 'overpair'
  | 'topPair'
  | 'middlePair'
  | 'bottomPair'
  | 'boardPairOnly'
  | 'twoPairUsingHole'
  | 'set'
  | 'tripsUsingOneHole'
  | 'other'

export type DrawType =
  | 'flushDraw'
  | 'openEndedStraightDraw'
  | 'gutshot'
  | 'doubleGutshot'
  | 'comboDraw'

export interface StructuralOutCard {
  readonly card: Card
  readonly resultingCategory: HandCategory
  readonly resultingGrade: HandEvaluation['comparisonGrade']
  readonly improvementKinds: readonly (
    | 'higherCategory'
    | 'higherGrade'
    | 'completesFlush'
    | 'completesStraight'
    | 'pairsVisibleRank'
  )[]
}

export interface BackdoorDrawFact {
  readonly kind: 'backdoorFlush' | 'backdoorStraight'
  readonly suit: CardSuit | null
  readonly neededRanks: readonly CardRank[]
}

export interface CardRemovalFact {
  readonly card: Card
  readonly unknownCardsOfSameRank: number
  readonly unknownCardsOfSameSuit: number
  readonly opponentTwoCardCombinationsRemaining: number
  readonly opponentTwoCardCombinationsRemoved: number
}

export interface CounterfeitRiskFact {
  readonly nextCard: Card
  readonly reasonCodes: readonly (
    | 'holeCardsUsedDecreases'
    | 'boardPairs'
    | 'boardMakesSharedHand'
    | 'pairStructureChanges'
  )[]
}

interface UnavailableHandFacts {
  readonly cleanOuts: HandFeatureFact<never>
  readonly rangeConditionalEquity: HandFeatureFact<never>
  readonly expectedValue: HandFeatureFact<never>
  readonly dominationProbability: HandFeatureFact<never>
  readonly foldEquity: HandFeatureFact<never>
  readonly opponentResponseProbability: HandFeatureFact<never>
  readonly impliedOdds: HandFeatureFact<never>
  readonly reverseImpliedOdds: HandFeatureFact<never>
  readonly actualReverseOuts: HandFeatureFact<never>
  readonly strategicBlockerValue: HandFeatureFact<never>
  readonly rangeRoleLabels: HandFeatureFact<never>
}

interface HandFeatureBase {
  readonly handFeatureSchemaVersion: typeof HAND_FEATURE_SCHEMA_VERSION
  readonly analyzerVersion: typeof HAND_FEATURE_ANALYZER_VERSION
  readonly pokerRuleSetVersion: PokerRuleSetVersion
  readonly street: HandFeatureStreet
  readonly visibleCardsSha256: string
  readonly sourceRefs: readonly HandFeatureSourceRef[]
  readonly unavailableFacts: UnavailableHandFacts
}

export interface PreflopHandFeatures extends HandFeatureBase {
  readonly kind: 'preflop'
  readonly startingHandClass: StartingHandCategory
  readonly isPair: boolean
  readonly isSuited: boolean
  readonly rankGap: HandFeatureFact<number>
  readonly isConnector: boolean
  readonly isBroadway: boolean
  readonly aceWheelPotential: boolean
  readonly highRank: CardRank
  readonly lowRank: CardRank
  readonly containsAce: boolean
  readonly containsKing: boolean
  readonly containsQueen: boolean
  readonly containsJack: boolean
  readonly containsTen: boolean
}

export interface PostflopHandFeatures extends HandFeatureBase {
  readonly kind: 'postflop'
  readonly bestFiveCards: readonly [Card, Card, Card, Card, Card]
  readonly handRankTuple: HandEvaluation['comparisonGrade']
  readonly handCategory: HandCategory
  readonly holeCardsUsed: 0 | 1 | 2
  readonly holeCardsInBestFive: readonly Card[]
  readonly pairRelation: PairRelation
  readonly kickerRanks: readonly CardRank[]
  readonly overcardCount: number
  readonly flushHighRank: HandFeatureFact<CardRank>
  readonly straightHighRank: HandFeatureFact<CardRank>
  readonly madeHandUsesBoardOnly: boolean
  readonly boardStructure: BoardStructureFacts
  readonly drawTypes: readonly DrawType[]
  readonly backdoorDraws: readonly BackdoorDrawFact[]
  readonly structuralOutCards: HandFeatureFact<readonly StructuralOutCard[]>
  readonly overlappingOutGroups: HandFeatureFact<
    readonly {
      readonly card: Card
      readonly improvementKinds: StructuralOutCard['improvementKinds']
    }[]
  >
  readonly redrawFacts: HandFeatureFact<
    readonly {
      readonly fromCategory: HandCategory
      readonly improvingCards: readonly Card[]
    }[]
  >
  readonly absoluteNuts: HandFeatureFact<boolean>
  readonly cardRemovalFacts: readonly CardRemovalFact[]
  readonly counterfeitRiskFacts: HandFeatureFact<readonly CounterfeitRiskFact[]>
}

export type HandFeatureAnalysis = PreflopHandFeatures | PostflopHandFeatures

function cardKey(card: Card): string {
  return `${card.rank}:${card.suit}`
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nestedValue of Object.values(value)) deepFreeze(nestedValue)
    Object.freeze(value)
  }
  return value
}

function sortedCards(cards: readonly Card[]): Card[] {
  return [...cards].sort(
    (left, right) =>
      (CARD_ORDER.get(cardKey(left)) ?? 0) -
      (CARD_ORDER.get(cardKey(right)) ?? 0),
  )
}

function compareGrades(
  left: HandEvaluation['comparisonGrade'],
  right: HandEvaluation['comparisonGrade'],
): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index]! - right[index]!
    if (difference !== 0) return difference
  }
  return 0
}

function rankFromValue(value: number): CardRank {
  const rank = CARD_RANKS[value]
  if (rank === undefined) throw new RangeError('牌点数超出规范范围。')
  return rank
}

function available<T>(
  value: T,
  sourceRefs: readonly HandFeatureSourceRef[],
): HandFeatureFact<T> {
  return {
    status: 'available',
    value,
    epistemicKind: 'formulaFact',
    sourceRefs,
    assumptionCodes: [],
  }
}

function unavailable(
  sourceRefs: readonly HandFeatureSourceRef[],
): HandFeatureFact<never> {
  return {
    status: 'unavailable',
    reasonCode: 'noVersionedOpponentRange',
    sourceRefs,
    assumptionCodes: ['noVersionedOpponentRange'],
  }
}

function notApplicable<T>(
  reasonCode: Extract<
    HandFeatureFact<T>,
    { readonly status: 'notApplicable' }
  >['reasonCode'],
  sourceRefs: readonly HandFeatureSourceRef[],
): HandFeatureFact<T> {
  return {
    status: 'notApplicable',
    reasonCode,
    sourceRefs,
    assumptionCodes: [],
  }
}

function createUnavailableFacts(
  sourceRefs: readonly HandFeatureSourceRef[],
): UnavailableHandFacts {
  return {
    cleanOuts: unavailable(sourceRefs),
    rangeConditionalEquity: unavailable(sourceRefs),
    expectedValue: unavailable(sourceRefs),
    dominationProbability: unavailable(sourceRefs),
    foldEquity: unavailable(sourceRefs),
    opponentResponseProbability: unavailable(sourceRefs),
    impliedOdds: unavailable(sourceRefs),
    reverseImpliedOdds: unavailable(sourceRefs),
    actualReverseOuts: unavailable(sourceRefs),
    strategicBlockerValue: unavailable(sourceRefs),
    rangeRoleLabels: unavailable(sourceRefs),
  }
}

function validateInput(input: AnalyzeHandFeaturesInput) {
  const parsed = HandFeatureInputSchema.parse(input)
  const expectedBoardCount = {
    preflop: 0,
    flop: 3,
    turn: 4,
    river: 5,
  }[parsed.street]
  if (parsed.board.length !== expectedBoardCount) {
    throw new RangeError('公共牌数量必须与街道精确对应。')
  }
  const visibleKeys = [
    ...parsed.heroHoleCards.map(cardKey),
    ...parsed.board.map(cardKey),
  ]
  if (new Set(visibleKeys).size !== visibleKeys.length) {
    throw new RangeError('Hero 底牌与公共牌不得重复。')
  }
  return parsed
}

function visibleCardsSha256(
  heroHoleCards: readonly [Card, Card],
  board: readonly Card[],
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        heroHoleCards: sortedCards(heroHoleCards),
        board,
      }),
      'utf8',
    )
    .digest('hex')
}

function createStraightWindows(cards: readonly Card[]): StraightWindowFact[] {
  const rankCounts = new Map<CardRank, number>()
  for (const card of cards) {
    rankCounts.set(card.rank, (rankCounts.get(card.rank) ?? 0) + 1)
  }
  return STRAIGHT_WINDOWS.map((window) => ({
    highRank: window.highRank,
    occupiedRanks: window.ranks.filter((rank) => rankCounts.has(rank)),
    missingRanks: window.ranks.filter((rank) => !rankCounts.has(rank)),
    duplicateBoardCards: window.ranks.reduce(
      (total, rank) => total + Math.max(0, (rankCounts.get(rank) ?? 0) - 1),
      0,
    ),
  }))
}

function maximumConsecutiveRun(ranks: readonly CardRank[]): number {
  const values = new Set(ranks.map((rank) => RANK_VALUE[rank]))
  if (values.has(RANK_VALUE.A)) values.add(-1)
  let maximum = 0
  let current = 0
  let previous: number | null = null
  for (const value of [...values].sort((left, right) => left - right)) {
    current = previous !== null && value === previous + 1 ? current + 1 : 1
    maximum = Math.max(maximum, current)
    previous = value
  }
  return maximum
}

function createBoardStructureCore(
  board: readonly Card[],
  sourceRefs: readonly HandFeatureSourceRef[],
): BoardStructureCore {
  const suitCounts = CARD_SUITS.map((suit) => ({
    suit,
    count: board.filter((card) => card.suit === suit).length,
  }))
  const rankCounts = CARD_RANKS.map((rank) => ({
    rank,
    count: board.filter((card) => card.rank === rank).length,
  }))
  const uniqueRanks = rankCounts
    .filter(({ count }) => count > 0)
    .map(({ rank }) => rank)
    .sort((left, right) => RANK_VALUE[right] - RANK_VALUE[left])
  const maxSuitCount = Math.max(...suitCounts.map(({ count }) => count))
  const uniqueSuitCount = suitCounts.filter(({ count }) => count > 0).length
  const sortedRankValues = uniqueRanks
    .map((rank) => RANK_VALUE[rank])
    .sort((left, right) => left - right)
  const internalGaps = sortedRankValues
    .slice(1)
    .map((value, index) => value - sortedRankValues[index]! - 1)
  const straightWindows = createStraightWindows(board)
  return {
    suitCounts,
    maxSuitCount,
    suitPattern:
      uniqueSuitCount === 1
        ? 'monotone'
        : uniqueSuitCount === 2
          ? 'twoTone'
          : uniqueSuitCount === board.length
            ? 'rainbow'
            : 'mixed',
    rankCounts,
    uniqueRanks,
    rankMultiplicity: {
      pairs: rankCounts
        .filter(({ count }) => count === 2)
        .map(({ rank }) => rank),
      trips: rankCounts
        .filter(({ count }) => count === 3)
        .map(({ rank }) => rank),
      quads: rankCounts
        .filter(({ count }) => count === 4)
        .map(({ rank }) => rank),
    },
    straightWindows,
    maximumConsecutiveRankRun: maximumConsecutiveRun(uniqueRanks),
    minimumInternalGap:
      internalGaps.length === 0
        ? notApplicable('insufficientRanks', sourceRefs)
        : available(Math.min(...internalGaps), sourceRefs),
    candidateStraightWindowCount: straightWindows.filter(
      ({ occupiedRanks }) => occupiedRanks.length >= 2,
    ).length,
    boardHighRank: uniqueRanks[0]!,
    boardLowRank: uniqueRanks.at(-1)!,
  }
}

interface MinimumHoleCardUsage {
  readonly count: 0 | 1 | 2
  readonly cards: readonly Card[]
  readonly bestFiveCards: readonly [Card, Card, Card, Card, Card]
}

function combinations<Value>(
  values: readonly Value[],
  count: number,
): Value[][] {
  if (count === 0) return [[]]
  if (count > values.length) return []
  const result: Value[][] = []
  for (let index = 0; index <= values.length - count; index += 1) {
    for (const suffix of combinations(values.slice(index + 1), count - 1)) {
      result.push([values[index]!, ...suffix])
    }
  }
  return result
}

function minimumHoleCardUsage(
  heroHoleCards: readonly [Card, Card],
  board: readonly Card[],
  targetGrade: HandEvaluation['comparisonGrade'],
): MinimumHoleCardUsage {
  const orderedHeroCards = sortedCards(heroHoleCards)
  for (const count of [0, 1, 2] as const) {
    const boardCardCount = 5 - count
    for (const heroSubset of combinations(orderedHeroCards, count)) {
      for (const boardSubset of combinations(board, boardCardCount)) {
        const candidate = handEvaluator.evaluate([
          ...heroSubset,
          ...boardSubset,
        ])
        if (compareGrades(candidate.comparisonGrade, targetGrade) === 0) {
          return {
            count,
            cards: heroSubset,
            bestFiveCards: candidate.bestFive,
          }
        }
      }
    }
  }
  throw new Error('无法确定达到当前最高牌力所需的最少 Hero 底牌数。')
}

function boardMakesGrade(
  board: readonly Card[],
  targetGrade: HandEvaluation['comparisonGrade'],
): boolean {
  return (
    board.length === 5 &&
    compareGrades(
      handEvaluator.evaluate(board).comparisonGrade,
      targetGrade,
    ) === 0
  )
}

function pairRelation(
  heroHoleCards: readonly [Card, Card],
  board: readonly Card[],
  evaluation: HandEvaluation,
  usedHoleCards: readonly Card[],
): PairRelation {
  if (evaluation.category === 'highCard') return 'none'
  const boardCounts = new Map<CardRank, number>()
  for (const card of board) {
    boardCounts.set(card.rank, (boardCounts.get(card.rank) ?? 0) + 1)
  }
  const boardRanks = [...boardCounts.keys()].sort(
    (left, right) => RANK_VALUE[right] - RANK_VALUE[left],
  )
  const isPocketPair = heroHoleCards[0].rank === heroHoleCards[1].rank
  const primaryMadeRank = rankFromValue(evaluation.comparisonGrade[1])
  if (evaluation.category === 'onePair') {
    if ((boardCounts.get(primaryMadeRank) ?? 0) >= 2) {
      return 'boardPairOnly'
    }
    if (isPocketPair && heroHoleCards[0].rank === primaryMadeRank) {
      const pocketRank = heroHoleCards[0].rank
      return RANK_VALUE[pocketRank] > RANK_VALUE[boardRanks[0]!]
        ? 'overpair'
        : 'pocketPairBelowBoard'
    }
    const matchedRank = usedHoleCards.find(
      (card) =>
        card.rank === primaryMadeRank &&
        (boardCounts.get(card.rank) ?? 0) === 1,
    )?.rank
    if (matchedRank !== undefined) {
      if (matchedRank === boardRanks[0]) return 'topPair'
      if (matchedRank === boardRanks.at(-1)) return 'bottomPair'
      return 'middlePair'
    }
  }
  if (evaluation.category === 'twoPair') {
    const secondaryMadeRank = rankFromValue(evaluation.comparisonGrade[2])
    const madeRanks = new Set([primaryMadeRank, secondaryMadeRank])
    return usedHoleCards.some(
      (card) =>
        madeRanks.has(card.rank) && (boardCounts.get(card.rank) ?? 0) < 2,
    )
      ? 'twoPairUsingHole'
      : 'boardPairOnly'
  }
  if (evaluation.category === 'threeOfAKind') {
    const boardCount = boardCounts.get(primaryMadeRank) ?? 0
    if (
      isPocketPair &&
      heroHoleCards[0].rank === primaryMadeRank &&
      boardCount === 1
    ) {
      return 'set'
    }
    if (
      boardCount === 2 &&
      usedHoleCards.some((card) => card.rank === primaryMadeRank)
    ) {
      return 'tripsUsingOneHole'
    }
    if (boardCount === 3) return 'boardPairOnly'
  }
  return 'other'
}

function kickerRanks(evaluation: HandEvaluation): CardRank[] {
  const counts = new Map<CardRank, number>()
  for (const card of evaluation.bestFive) {
    counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1)
  }
  const expectedCount =
    evaluation.category === 'onePair' ||
    evaluation.category === 'threeOfAKind' ||
    evaluation.category === 'fourOfAKind' ||
    evaluation.category === 'twoPair'
      ? 1
      : evaluation.category === 'highCard' || evaluation.category === 'flush'
        ? 1
        : null
  if (expectedCount === null) return []
  return [...counts.entries()]
    .filter(([, count]) => count === expectedCount)
    .map(([rank]) => rank)
    .sort((left, right) => RANK_VALUE[right] - RANK_VALUE[left])
}

function createStructuralOuts(
  heroHoleCards: readonly [Card, Card],
  board: readonly Card[],
  current: HandEvaluation,
): StructuralOutCard[] {
  const visible = new Set([...heroHoleCards, ...board].map(cardKey))
  return STANDARD_DECK.filter((card) => !visible.has(cardKey(card)))
    .map((card): StructuralOutCard | null => {
      const result = handEvaluator.evaluate([...heroHoleCards, ...board, card])
      if (compareGrades(result.comparisonGrade, current.comparisonGrade) <= 0) {
        return null
      }
      const improvementKinds: StructuralOutCard['improvementKinds'][number][] =
        []
      if (
        HAND_CATEGORY_VALUE[result.category] >
        HAND_CATEGORY_VALUE[current.category]
      ) {
        improvementKinds.push('higherCategory')
      } else {
        improvementKinds.push('higherGrade')
      }
      if (
        (result.category === 'flush' || result.category === 'straightFlush') &&
        current.category !== 'flush' &&
        current.category !== 'straightFlush'
      ) {
        improvementKinds.push('completesFlush')
      }
      if (
        (result.category === 'straight' ||
          result.category === 'straightFlush') &&
        current.category !== 'straight' &&
        current.category !== 'straightFlush'
      ) {
        improvementKinds.push('completesStraight')
      }
      if (
        [...heroHoleCards, ...board].some((known) => known.rank === card.rank)
      ) {
        improvementKinds.push('pairsVisibleRank')
      }
      return {
        card,
        resultingCategory: result.category,
        resultingGrade: result.comparisonGrade,
        improvementKinds,
      }
    })
    .filter((value): value is StructuralOutCard => value !== null)
}

function createDrawTypes(
  visibleCards: readonly Card[],
  current: HandEvaluation,
): DrawType[] {
  const suitCounts = CARD_SUITS.map(
    (suit) => visibleCards.filter((card) => card.suit === suit).length,
  )
  const flushDraw =
    Math.max(...suitCounts) === 4 &&
    current.category !== 'flush' &&
    current.category !== 'straightFlush'
  const oneMissingWindows = createStraightWindows(visibleCards).filter(
    ({ missingRanks }) => missingRanks.length === 1,
  )
  const missingRanks = new Set(
    oneMissingWindows.flatMap(({ missingRanks: missing }) => missing),
  )
  const values = new Set(visibleCards.map((card) => RANK_VALUE[card.rank]))
  let hasFourCardRun = false
  for (let start = 0; start <= RANK_VALUE.J; start += 1) {
    if ([0, 1, 2, 3].every((offset) => values.has(start + offset))) {
      hasFourCardRun = true
    }
  }
  const result: DrawType[] = []
  if (flushDraw) result.push('flushDraw')
  if (missingRanks.size >= 2 && hasFourCardRun) {
    result.push('openEndedStraightDraw')
  } else if (missingRanks.size >= 2) {
    result.push('doubleGutshot')
  } else if (missingRanks.size === 1) {
    result.push('gutshot')
  }
  if (
    flushDraw &&
    result.some(
      (draw) =>
        draw === 'openEndedStraightDraw' ||
        draw === 'gutshot' ||
        draw === 'doubleGutshot',
    )
  ) {
    result.push('comboDraw')
  }
  return result
}

function createBackdoorDraws(
  visibleCards: readonly Card[],
): BackdoorDrawFact[] {
  const result: BackdoorDrawFact[] = []
  for (const suit of CARD_SUITS) {
    if (visibleCards.filter((card) => card.suit === suit).length === 3) {
      result.push({ kind: 'backdoorFlush', suit, neededRanks: [] })
    }
  }
  for (const window of createStraightWindows(visibleCards)) {
    if (window.missingRanks.length === 2) {
      result.push({
        kind: 'backdoorStraight',
        suit: null,
        neededRanks: window.missingRanks,
      })
    }
  }
  return result
}

function isAbsoluteNuts(
  heroHoleCards: readonly [Card, Card],
  board: readonly Card[],
  heroEvaluation: HandEvaluation,
): boolean {
  const visible = new Set([...heroHoleCards, ...board].map(cardKey))
  const unknown = STANDARD_DECK.filter((card) => !visible.has(cardKey(card)))
  for (let first = 0; first < unknown.length - 1; first += 1) {
    for (let second = first + 1; second < unknown.length; second += 1) {
      const opponent = handEvaluator.evaluate([
        unknown[first]!,
        unknown[second]!,
        ...board,
      ])
      if (
        compareGrades(
          opponent.comparisonGrade,
          heroEvaluation.comparisonGrade,
        ) > 0
      ) {
        return false
      }
    }
  }
  return true
}

function createCardRemovalFacts(
  visibleCards: readonly Card[],
): CardRemovalFact[] {
  const unknownCount = STANDARD_DECK.length - visibleCards.length
  const combinationsRemaining = (unknownCount * (unknownCount - 1)) / 2
  const combinationsRemoved =
    (STANDARD_DECK.length * (STANDARD_DECK.length - 1)) / 2 -
    combinationsRemaining
  return sortedCards(visibleCards).map((card) => ({
    card,
    unknownCardsOfSameRank:
      4 - visibleCards.filter((visible) => visible.rank === card.rank).length,
    unknownCardsOfSameSuit:
      13 - visibleCards.filter((visible) => visible.suit === card.suit).length,
    opponentTwoCardCombinationsRemaining: combinationsRemaining,
    opponentTwoCardCombinationsRemoved: combinationsRemoved,
  }))
}

function createCounterfeitRiskFacts(
  heroHoleCards: readonly [Card, Card],
  board: readonly Card[],
  current: HandEvaluation,
  currentUsage: MinimumHoleCardUsage,
): CounterfeitRiskFact[] {
  const visible = new Set([...heroHoleCards, ...board].map(cardKey))
  const currentPairRelation = pairRelation(
    heroHoleCards,
    board,
    current,
    currentUsage.cards,
  )
  return STANDARD_DECK.filter((card) => !visible.has(cardKey(card)))
    .map((nextCard): CounterfeitRiskFact | null => {
      const nextBoard = [...board, nextCard]
      const next = handEvaluator.evaluate([...heroHoleCards, ...nextBoard])
      const nextUsage = minimumHoleCardUsage(
        heroHoleCards,
        nextBoard,
        next.comparisonGrade,
      )
      const reasons: CounterfeitRiskFact['reasonCodes'][number][] = []
      if (nextUsage.count < currentUsage.count) {
        reasons.push('holeCardsUsedDecreases')
      }
      if (board.some((card) => card.rank === nextCard.rank)) {
        reasons.push('boardPairs')
      }
      if (boardMakesGrade(nextBoard, next.comparisonGrade)) {
        reasons.push('boardMakesSharedHand')
      }
      const nextRelation = pairRelation(
        heroHoleCards,
        nextBoard,
        next,
        nextUsage.cards,
      )
      if (nextRelation !== currentPairRelation)
        reasons.push('pairStructureChanges')
      return reasons.length === 0
        ? null
        : { nextCard, reasonCodes: [...new Set(reasons)] }
    })
    .filter((value): value is CounterfeitRiskFact => value !== null)
}

function createBoardFacts(
  street: Exclude<HandFeatureStreet, 'preflop'>,
  heroHoleCards: readonly [Card, Card],
  board: readonly Card[],
  currentEvaluation: HandEvaluation,
  currentHoleCardsUsed: 0 | 1 | 2,
  sourceRefs: readonly HandFeatureSourceRef[],
): BoardStructureFacts {
  const core = createBoardStructureCore(board, sourceRefs)
  if (street === 'flop') {
    return {
      ...core,
      streetDelta: notApplicable('noPriorPostflopStreet', sourceRefs),
      handTransition: notApplicable('noPriorPostflopStreet', sourceRefs),
    }
  }
  const previousBoard = board.slice(0, -1)
  const previousCore = createBoardStructureCore(previousBoard, sourceRefs)
  const addedCard = board.at(-1)!
  const previousEvaluation = handEvaluator.evaluate([
    ...heroHoleCards,
    ...previousBoard,
  ])
  const previousUsage = minimumHoleCardUsage(
    heroHoleCards,
    previousBoard,
    previousEvaluation.comparisonGrade,
  )
  const changedStraightWindows = core.straightWindows
    .map((window) => {
      const previous = previousCore.straightWindows.find(
        (candidate) => candidate.highRank === window.highRank,
      )!
      return {
        highRank: window.highRank,
        missingRanksBefore: previous.missingRanks,
        missingRanksAfter: window.missingRanks,
      }
    })
    .filter(
      ({ missingRanksBefore, missingRanksAfter }) =>
        missingRanksBefore.join(',') !== missingRanksAfter.join(','),
    )
  return {
    ...core,
    streetDelta: available(
      {
        addedCard,
        changedSuit: {
          suit: addedCard.suit,
          countBefore:
            previousCore.suitCounts.find(({ suit }) => suit === addedCard.suit)
              ?.count ?? 0,
          countAfter:
            core.suitCounts.find(({ suit }) => suit === addedCard.suit)
              ?.count ?? 0,
        },
        changedRank: {
          rank: addedCard.rank,
          countBefore:
            previousCore.rankCounts.find(({ rank }) => rank === addedCard.rank)
              ?.count ?? 0,
          countAfter:
            core.rankCounts.find(({ rank }) => rank === addedCard.rank)
              ?.count ?? 0,
        },
        changedStraightWindows,
      },
      sourceRefs,
    ),
    handTransition: available(
      {
        categoryBefore: previousEvaluation.category,
        categoryAfter: currentEvaluation.category,
        comparisonGradeBefore: previousEvaluation.comparisonGrade,
        comparisonGradeAfter: currentEvaluation.comparisonGrade,
        holeCardsUsedBefore: previousUsage.count,
        holeCardsUsedAfter: currentHoleCardsUsed,
      },
      sourceRefs,
    ),
  }
}

export function analyzeHandFeatures(
  input: AnalyzeHandFeaturesInput,
): HandFeatureAnalysis {
  const parsed = validateInput(input)
  const heroHoleCards = parsed.heroHoleCards
  const board = parsed.board
  const sourceRefs: readonly HandFeatureSourceRef[] = [
    { kind: 'analysisInputField', path: 'hand.street', eventSeq: null },
    {
      kind: 'analysisInputField',
      path: 'hand.heroHoleCards',
      eventSeq: null,
    },
    { kind: 'analysisInputField', path: 'hand.board', eventSeq: null },
    {
      kind: 'ruleSet',
      pokerRuleSetVersion: parsed.pokerRuleSetVersion,
      factId: 'standard52CardUnknownUniverse',
    },
    {
      kind: 'algorithm',
      algorithmId: 'handFeatureAnalyzer',
      version: HAND_FEATURE_ANALYZER_VERSION,
    },
  ]
  const base: HandFeatureBase = {
    handFeatureSchemaVersion: HAND_FEATURE_SCHEMA_VERSION,
    analyzerVersion: HAND_FEATURE_ANALYZER_VERSION,
    pokerRuleSetVersion: parsed.pokerRuleSetVersion,
    street: parsed.street,
    visibleCardsSha256: visibleCardsSha256(heroHoleCards, board),
    sourceRefs,
    unavailableFacts: createUnavailableFacts(sourceRefs),
  }
  if (parsed.street === 'preflop') {
    const [first, second] = heroHoleCards
    const [highRank, lowRank] =
      RANK_VALUE[first.rank] >= RANK_VALUE[second.rank]
        ? [first.rank, second.rank]
        : [second.rank, first.rank]
    const isPair = first.rank === second.rank
    const rankGap = Math.max(
      0,
      Math.abs(RANK_VALUE[first.rank] - RANK_VALUE[second.rank]) - 1,
    )
    const ranks = new Set(heroHoleCards.map((card) => card.rank))
    return deepFreeze({
      ...base,
      kind: 'preflop',
      startingHandClass: classifyStartingHand(heroHoleCards),
      isPair,
      isSuited: first.suit === second.suit,
      rankGap: isPair
        ? notApplicable('pairHasNoRankGap', sourceRefs)
        : available(rankGap, sourceRefs),
      isConnector: !isPair && rankGap === 0,
      isBroadway: heroHoleCards.every((card) =>
        ['T', 'J', 'Q', 'K', 'A'].includes(card.rank),
      ),
      aceWheelPotential:
        ranks.has('A') &&
        (['2', '3', '4', '5'] as const).some((rank) => ranks.has(rank)),
      highRank,
      lowRank,
      containsAce: ranks.has('A'),
      containsKing: ranks.has('K'),
      containsQueen: ranks.has('Q'),
      containsJack: ranks.has('J'),
      containsTen: ranks.has('T'),
    })
  }

  const evaluation = handEvaluator.evaluate([...heroHoleCards, ...board])
  const usage = minimumHoleCardUsage(
    heroHoleCards,
    board,
    evaluation.comparisonGrade,
  )
  const holeCardsUsed = usage.count
  const visibleCards = [...heroHoleCards, ...board]
  const structuralOuts =
    parsed.street === 'river'
      ? null
      : createStructuralOuts(heroHoleCards, board, evaluation)
  const drawTypes =
    parsed.street === 'river' ? [] : createDrawTypes(visibleCards, evaluation)
  const result: PostflopHandFeatures = {
    ...base,
    kind: 'postflop',
    bestFiveCards: usage.bestFiveCards,
    handRankTuple: evaluation.comparisonGrade,
    handCategory: evaluation.category,
    holeCardsUsed,
    holeCardsInBestFive: usage.cards,
    pairRelation: pairRelation(heroHoleCards, board, evaluation, usage.cards),
    kickerRanks: kickerRanks(evaluation),
    overcardCount: heroHoleCards.filter(
      (card) =>
        RANK_VALUE[card.rank] >
        RANK_VALUE[createBoardStructureCore(board, sourceRefs).boardHighRank],
    ).length,
    flushHighRank:
      evaluation.category === 'flush' || evaluation.category === 'straightFlush'
        ? available(
            evaluation.bestFive.reduce(
              (highest, card) =>
                RANK_VALUE[card.rank] > RANK_VALUE[highest]
                  ? card.rank
                  : highest,
              evaluation.bestFive[0]!.rank,
            ),
            sourceRefs,
          )
        : notApplicable('notCurrentHandCategory', sourceRefs),
    straightHighRank:
      evaluation.category === 'straight' ||
      evaluation.category === 'straightFlush'
        ? available(rankFromValue(evaluation.comparisonGrade[1]), sourceRefs)
        : notApplicable('notCurrentHandCategory', sourceRefs),
    madeHandUsesBoardOnly: boardMakesGrade(board, evaluation.comparisonGrade),
    boardStructure: createBoardFacts(
      parsed.street,
      heroHoleCards,
      board,
      evaluation,
      holeCardsUsed,
      sourceRefs,
    ),
    drawTypes,
    backdoorDraws:
      parsed.street === 'flop' ? createBackdoorDraws(visibleCards) : [],
    structuralOutCards:
      structuralOuts === null
        ? notApplicable('noFutureDecisionStreet', sourceRefs)
        : available(structuralOuts, sourceRefs),
    overlappingOutGroups:
      structuralOuts === null
        ? notApplicable('noFutureDecisionStreet', sourceRefs)
        : available(
            structuralOuts
              .filter(({ improvementKinds }) => improvementKinds.length > 1)
              .map(({ card, improvementKinds }) => ({
                card,
                improvementKinds,
              })),
            sourceRefs,
          ),
    redrawFacts:
      structuralOuts === null
        ? notApplicable('noFutureDecisionStreet', sourceRefs)
        : available(
            evaluation.category === 'highCard' || structuralOuts.length === 0
              ? []
              : [
                  {
                    fromCategory: evaluation.category,
                    improvingCards: structuralOuts.map(({ card }) => card),
                  },
                ],
            sourceRefs,
          ),
    absoluteNuts: available(
      isAbsoluteNuts(heroHoleCards, board, evaluation),
      sourceRefs,
    ),
    cardRemovalFacts: createCardRemovalFacts(visibleCards),
    counterfeitRiskFacts:
      parsed.street === 'river'
        ? notApplicable('noFutureDecisionStreet', sourceRefs)
        : available(
            createCounterfeitRiskFacts(heroHoleCards, board, evaluation, usage),
            sourceRefs,
          ),
  }
  return deepFreeze(result)
}
