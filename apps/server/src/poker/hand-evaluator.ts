import { createRequire } from 'node:module'
import { CardSchema } from '@tx-holdem-coach/contracts'
import type { Card, CardRank, CardSuit } from '@tx-holdem-coach/contracts'

export type HandCategory =
  | 'highCard'
  | 'onePair'
  | 'twoPair'
  | 'threeOfAKind'
  | 'straight'
  | 'flush'
  | 'fullHouse'
  | 'fourOfAKind'
  | 'straightFlush'

export type HandComparison = 'win' | 'lose' | 'tie'

export interface HandEvaluation {
  readonly category: HandCategory
  readonly comparisonGrade: readonly [
    categoryRank: number,
    firstCardRank: number,
    secondCardRank: number,
    thirdCardRank: number,
    fourthCardRank: number,
    fifthCardRank: number,
  ]
  readonly bestFive: readonly [Card, Card, Card, Card, Card]
  readonly displayName: string
}

export interface HandEvaluator {
  evaluate(cards: readonly Card[]): HandEvaluation
  compare(
    leftCards: readonly Card[],
    rightCards: readonly Card[],
  ): HandComparison
}

interface PokerSolverCard {
  readonly value: string
  readonly suit: string
}

interface PokerSolverHand {
  readonly name: string
  readonly descr: string
  readonly cards: readonly PokerSolverCard[]
}

interface PokerSolverHandConstructor {
  solve(cards: readonly string[], game: 'standard'): PokerSolverHand
  winners(hands: readonly PokerSolverHand[]): readonly PokerSolverHand[]
}

interface PokerSolverModule {
  readonly Hand: PokerSolverHandConstructor
}

interface CategoryDefinition {
  readonly category: HandCategory
  readonly categoryRank: number
  readonly displayName: string
}

const loadCommonJsModule = createRequire(import.meta.url)
const { Hand } = loadCommonJsModule('pokersolver') as PokerSolverModule

const SOLVER_SUITS = {
  clubs: 'c',
  diamonds: 'd',
  hearts: 'h',
  spades: 's',
} as const satisfies Record<CardSuit, string>

const DOMAIN_SUITS: Readonly<Record<string, CardSuit | undefined>> =
  Object.freeze({
    c: 'clubs',
    d: 'diamonds',
    h: 'hearts',
    s: 'spades',
  })

const CARD_RANK_VALUES = {
  '2': 0,
  '3': 1,
  '4': 2,
  '5': 3,
  '6': 4,
  '7': 5,
  '8': 6,
  '9': 7,
  T: 8,
  J: 9,
  Q: 10,
  K: 11,
  A: 12,
} as const satisfies Record<CardRank, number>

const CATEGORY_BY_SOLVER_NAME: Readonly<
  Record<string, CategoryDefinition | undefined>
> = Object.freeze({
  'High Card': { category: 'highCard', categoryRank: 0, displayName: '高牌' },
  Pair: { category: 'onePair', categoryRank: 1, displayName: '一对' },
  'Two Pair': { category: 'twoPair', categoryRank: 2, displayName: '两对' },
  'Three of a Kind': {
    category: 'threeOfAKind',
    categoryRank: 3,
    displayName: '三条',
  },
  Straight: { category: 'straight', categoryRank: 4, displayName: '顺子' },
  Flush: { category: 'flush', categoryRank: 5, displayName: '同花' },
  'Full House': {
    category: 'fullHouse',
    categoryRank: 6,
    displayName: '葫芦',
  },
  'Four of a Kind': {
    category: 'fourOfAKind',
    categoryRank: 7,
    displayName: '四条',
  },
  'Straight Flush': {
    category: 'straightFlush',
    categoryRank: 8,
    displayName: '同花顺',
  },
})

function toSolverCode(card: Card): string {
  return `${card.rank}${SOLVER_SUITS[card.suit]}`
}

function toDomainCard(card: PokerSolverCard): Card {
  return CardSchema.parse({
    rank: card.value === '1' ? 'A' : card.value,
    suit: DOMAIN_SUITS[card.suit],
  })
}

function cardKey(card: Card): string {
  return `${card.rank}:${card.suit}`
}

function selectBestFive(
  solvedHand: PokerSolverHand,
  inputCards: readonly Card[],
): readonly [Card, Card, Card, Card, Card] {
  if (solvedHand.cards.length < 5) {
    throw new Error('牌型评估器未返回完整的最佳五张牌。')
  }

  const inputCardKeys = new Set(inputCards.map(cardKey))
  const solvedCards = solvedHand.cards.map(toDomainCard)

  if (solvedCards.some((card) => !inputCardKeys.has(cardKey(card)))) {
    throw new Error('牌型评估器返回了不属于输入的牌。')
  }

  const [first, second, third, fourth, fifth] = solvedCards.slice(0, 5)

  if (
    first === undefined ||
    second === undefined ||
    third === undefined ||
    fourth === undefined ||
    fifth === undefined
  ) {
    throw new Error('牌型评估器未返回完整的最佳五张牌。')
  }

  return [first, second, third, fourth, fifth]
}

function ranksWithCount(
  rankCounts: ReadonlyMap<number, number>,
  expectedCount: number,
): number[] {
  return [...rankCounts.entries()]
    .filter(([, count]) => count === expectedCount)
    .map(([rank]) => rank)
    .sort((left, right) => right - left)
}

function requireRank(ranks: readonly number[], index: number): number {
  const rank = ranks[index]

  if (rank === undefined) {
    throw new Error('牌型评估器返回的最佳五张与牌型不一致。')
  }

  return rank
}

function createComparisonGrade(
  definition: CategoryDefinition,
  bestFive: readonly [Card, Card, Card, Card, Card],
): HandEvaluation['comparisonGrade'] {
  const cardRanks = bestFive.map((card) => CARD_RANK_VALUES[card.rank])
  const rankCounts = new Map<number, number>()

  for (const rank of cardRanks) {
    rankCounts.set(rank, (rankCounts.get(rank) ?? 0) + 1)
  }

  const singles = ranksWithCount(rankCounts, 1)
  const pairs = ranksWithCount(rankCounts, 2)
  const triples = ranksWithCount(rankCounts, 3)
  const quads = ranksWithCount(rankCounts, 4)
  let tieBreakRanks: readonly [number, number, number, number, number]

  switch (definition.category) {
    case 'highCard':
    case 'flush':
      tieBreakRanks = [
        requireRank(singles, 0),
        requireRank(singles, 1),
        requireRank(singles, 2),
        requireRank(singles, 3),
        requireRank(singles, 4),
      ]
      break
    case 'onePair':
      tieBreakRanks = [
        requireRank(pairs, 0),
        requireRank(singles, 0),
        requireRank(singles, 1),
        requireRank(singles, 2),
        0,
      ]
      break
    case 'twoPair':
      tieBreakRanks = [
        requireRank(pairs, 0),
        requireRank(pairs, 1),
        requireRank(singles, 0),
        0,
        0,
      ]
      break
    case 'threeOfAKind':
      tieBreakRanks = [
        requireRank(triples, 0),
        requireRank(singles, 0),
        requireRank(singles, 1),
        0,
        0,
      ]
      break
    case 'straight':
    case 'straightFlush': {
      const sortedRanks = [...cardRanks].sort((left, right) => right - left)
      const isWheel =
        sortedRanks.join(',') ===
        [
          CARD_RANK_VALUES.A,
          CARD_RANK_VALUES['5'],
          CARD_RANK_VALUES['4'],
          CARD_RANK_VALUES['3'],
          CARD_RANK_VALUES['2'],
        ].join(',')
      const highestRank = isWheel
        ? CARD_RANK_VALUES['5']
        : requireRank(sortedRanks, 0)
      tieBreakRanks = [highestRank, 0, 0, 0, 0]
      break
    }
    case 'fullHouse':
      tieBreakRanks = [requireRank(triples, 0), requireRank(pairs, 0), 0, 0, 0]
      break
    case 'fourOfAKind':
      tieBreakRanks = [requireRank(quads, 0), requireRank(singles, 0), 0, 0, 0]
      break
  }

  return [definition.categoryRank, ...tieBreakRanks]
}

function solveCards(cards: readonly Card[]): {
  normalizedCards: Card[]
  solvedHand: PokerSolverHand
} {
  if (!Array.isArray(cards)) {
    throw new TypeError('牌型输入必须是数组。')
  }

  if (cards.length < 5 || cards.length > 7) {
    throw new RangeError('牌型输入必须包含 5、6 或 7 张牌。')
  }

  const normalizedCards = cards.map((card) => CardSchema.parse(card))
  const cardKeys = normalizedCards.map(cardKey)

  if (new Set(cardKeys).size !== cardKeys.length) {
    throw new RangeError('牌型输入不得包含重复牌。')
  }

  const solvedHand = Hand.solve(normalizedCards.map(toSolverCode), 'standard')

  return { normalizedCards, solvedHand }
}

function evaluate(cards: readonly Card[]): HandEvaluation {
  const { normalizedCards, solvedHand } = solveCards(cards)
  const definition = CATEGORY_BY_SOLVER_NAME[solvedHand.name]

  if (definition === undefined) {
    throw new Error('牌型评估器返回了未知牌型。')
  }

  const bestFive = selectBestFive(solvedHand, normalizedCards)

  return {
    category: definition.category,
    comparisonGrade: createComparisonGrade(definition, bestFive),
    bestFive,
    displayName:
      solvedHand.descr === 'Royal Flush'
        ? '皇家同花顺'
        : definition.displayName,
  }
}

function compare(
  leftCards: readonly Card[],
  rightCards: readonly Card[],
): HandComparison {
  const leftHand = solveCards(leftCards).solvedHand
  const rightHand = solveCards(rightCards).solvedHand
  const winners = Hand.winners([leftHand, rightHand])

  if (winners.length === 2) {
    return 'tie'
  }

  if (winners[0] === leftHand) {
    return 'win'
  }

  if (winners[0] === rightHand) {
    return 'lose'
  }

  throw new Error('牌型评估器未返回可识别的比较结果。')
}

export const handEvaluator: HandEvaluator = Object.freeze({
  evaluate,
  compare,
})
