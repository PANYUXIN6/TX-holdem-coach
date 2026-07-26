import { randomInt } from 'node:crypto'
import { CardSchema } from '@tx-holdem-coach/contracts'
import type { Card } from '@tx-holdem-coach/contracts'
import { STANDARD_DECK } from './cards.js'

export interface RandomSource {
  nextInt(maxExclusive: number): number
}

export interface DealPreflopInput {
  readonly shuffledDeck: readonly Card[]
  readonly buttonSeatNumber: number
  readonly participantSeatNumbers: readonly number[]
}

export interface DealtHoleCards {
  readonly seatNumber: number
  readonly cards: readonly [Card, Card]
}

export interface DealtHand {
  readonly buttonSeatNumber: number
  readonly participantSeatNumbers: readonly number[]
  readonly shuffledDeck: readonly Card[]
  readonly remainingDeck: readonly Card[]
  readonly holeCards: readonly DealtHoleCards[]
  readonly burnedCards: readonly Card[]
  readonly board: readonly Card[]
}

function assertPositiveInteger(maxExclusive: number): void {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
    throw new RangeError('随机上界必须为正整数。')
  }
}

export const SECURE_RANDOM_SOURCE: RandomSource = Object.freeze({
  nextInt(maxExclusive: number): number {
    assertPositiveInteger(maxExclusive)
    return randomInt(maxExclusive)
  },
})

function copyPureCard(card: Card): Card {
  return { rank: card.rank, suit: card.suit }
}

function copyCards(cards: readonly Card[]): Card[] {
  return cards.map(copyPureCard)
}

function cardKey(card: Card): string {
  return `${card.rank}:${card.suit}`
}

function cardsMatch(left: Card, right: Card): boolean {
  return left.rank === right.rank && left.suit === right.suit
}

function cardArraysMatch(
  left: readonly Card[],
  right: readonly Card[],
): boolean {
  return (
    left.length === right.length &&
    left.every((card, index) => cardsMatch(card, right[index] as Card))
  )
}

function numberArraysMatch(
  left: readonly number[],
  right: readonly number[],
): boolean {
  return (
    left.length === right.length &&
    left.every((seatNumber, index) => seatNumber === right[index])
  )
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label}必须是对象。`)
  }

  return value as Record<string, unknown>
}

function normalizeCardArray(value: unknown, label: string): Card[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label}必须是数组。`)
  }

  return value.map((card) => CardSchema.parse(card))
}

function normalizeStandardDeck(deck: unknown): Card[] {
  if (!Array.isArray(deck) || deck.length !== STANDARD_DECK.length) {
    throw new RangeError('洗后牌堆必须恰好包含 52 张牌。')
  }

  const cards = deck.map((card) => CardSchema.parse(card))
  const cardKeys = new Set(cards.map(cardKey))

  if (cardKeys.size !== STANDARD_DECK.length) {
    throw new RangeError('洗后牌堆不得包含重复牌。')
  }

  return copyCards(cards)
}

function assertSeatNumber(
  seatNumber: unknown,
  label: string,
): asserts seatNumber is number {
  if (
    !Number.isInteger(seatNumber) ||
    typeof seatNumber !== 'number' ||
    seatNumber < 0 ||
    seatNumber > 8
  ) {
    throw new RangeError(`${label}必须是 0 到 8 的整数。`)
  }
}

function buttonRelativeSeatOrder(
  buttonSeatNumber: unknown,
  participantSeatNumbers: unknown,
): number[] {
  assertSeatNumber(buttonSeatNumber, '按钮座位')

  if (
    !Array.isArray(participantSeatNumbers) ||
    participantSeatNumbers.length < 6 ||
    participantSeatNumbers.length > 9
  ) {
    throw new RangeError('本手有效座位必须为 6 到 9 个。')
  }

  const participantSet = new Set<number>()
  for (const seatNumber of participantSeatNumbers) {
    assertSeatNumber(seatNumber, '有效座位')

    if (participantSet.has(seatNumber)) {
      throw new RangeError('本手有效座位不得重复。')
    }

    participantSet.add(seatNumber)
  }

  if (!participantSet.has(buttonSeatNumber)) {
    throw new RangeError('按钮必须属于本手有效座位。')
  }

  const order: number[] = []
  for (let offset = 1; offset <= 9; offset += 1) {
    const seatNumber = (buttonSeatNumber + offset) % 9
    if (participantSet.has(seatNumber)) {
      order.push(seatNumber)
    }
  }

  return order
}

function randomIndex(random: RandomSource, maxExclusive: number): number {
  const index = random.nextInt(maxExclusive)

  if (!Number.isInteger(index) || index < 0 || index >= maxExclusive) {
    throw new RangeError('随机源返回了超出范围的索引。')
  }

  return index
}

export function shuffleStandardDeck(
  random: RandomSource = SECURE_RANDOM_SOURCE,
): readonly Card[] {
  const shuffledDeck = STANDARD_DECK.map(copyPureCard)

  for (let index = shuffledDeck.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(random, index + 1)
    const card = shuffledDeck[index]
    shuffledDeck[index] = shuffledDeck[swapIndex] as Card
    shuffledDeck[swapIndex] = card as Card
  }

  return shuffledDeck
}

export function dealPreflop(input: DealPreflopInput): DealtHand {
  const shuffledDeck = normalizeStandardDeck(input.shuffledDeck)
  const participantSeatNumbers = buttonRelativeSeatOrder(
    input.buttonSeatNumber,
    input.participantSeatNumbers,
  )
  const participantCount = participantSeatNumbers.length
  const consumedCardCount = participantCount * 2

  const holeCards = participantSeatNumbers.map((seatNumber, index) => ({
    seatNumber,
    cards: [
      copyPureCard(shuffledDeck[index] as Card),
      copyPureCard(shuffledDeck[index + participantCount] as Card),
    ] as const,
  }))

  return {
    buttonSeatNumber: input.buttonSeatNumber,
    participantSeatNumbers: [...participantSeatNumbers],
    shuffledDeck: copyCards(shuffledDeck),
    remainingDeck: copyCards(shuffledDeck.slice(consumedCardCount)),
    holeCards,
    burnedCards: [],
    board: [],
  }
}

function normalizeHoleCards(
  value: unknown,
  participantSeatNumbers: readonly number[],
  shuffledDeck: readonly Card[],
): DealtHoleCards[] {
  if (!Array.isArray(value) || value.length !== participantSeatNumbers.length) {
    throw new RangeError('底牌必须与本手有效座位一一对应。')
  }

  const participantCount = participantSeatNumbers.length

  return value.map((holeCards, index) => {
    const record = asRecord(holeCards, '底牌记录')
    const expectedSeatNumber = participantSeatNumbers[index] as number
    assertSeatNumber(record.seatNumber, '底牌座位')

    if (record.seatNumber !== expectedSeatNumber) {
      throw new RangeError('底牌记录必须按第一轮发牌顺序排列。')
    }

    const cards = normalizeCardArray(record.cards, '底牌')
    if (cards.length !== 2) {
      throw new RangeError('每个有效座位必须恰有两张底牌。')
    }

    const expectedCards = [
      shuffledDeck[index] as Card,
      shuffledDeck[index + participantCount] as Card,
    ] as const
    if (!cardArraysMatch(cards, expectedCards)) {
      throw new RangeError('底牌与洗后牌堆的发牌顺序不一致。')
    }

    return {
      seatNumber: expectedSeatNumber,
      cards: [copyPureCard(cards[0] as Card), copyPureCard(cards[1] as Card)],
    }
  })
}

function validateCommunityCardCounts(
  boardLength: number,
  burnedCardLength: number,
): void {
  const isValidStreet =
    (boardLength === 0 && burnedCardLength === 0) ||
    (boardLength === 3 && burnedCardLength === 1) ||
    (boardLength === 4 && burnedCardLength === 2) ||
    (boardLength === 5 && burnedCardLength === 3)

  if (!isValidStreet) {
    throw new RangeError('公共牌和 burn 牌数量不符合街道边界。')
  }
}

function expectedCommunityCards(
  shuffledDeck: readonly Card[],
  participantCount: number,
  boardLength: number,
): { burnedCards: Card[]; board: Card[]; remainingDeck: Card[] } {
  const burnedCards: Card[] = []
  const board: Card[] = []
  let nextCardIndex = participantCount * 2

  if (boardLength >= 3) {
    burnedCards.push(copyPureCard(shuffledDeck[nextCardIndex] as Card))
    nextCardIndex += 1
    board.push(
      copyPureCard(shuffledDeck[nextCardIndex] as Card),
      copyPureCard(shuffledDeck[nextCardIndex + 1] as Card),
      copyPureCard(shuffledDeck[nextCardIndex + 2] as Card),
    )
    nextCardIndex += 3
  }

  if (boardLength >= 4) {
    burnedCards.push(copyPureCard(shuffledDeck[nextCardIndex] as Card))
    nextCardIndex += 1
    board.push(copyPureCard(shuffledDeck[nextCardIndex] as Card))
    nextCardIndex += 1
  }

  if (boardLength === 5) {
    burnedCards.push(copyPureCard(shuffledDeck[nextCardIndex] as Card))
    nextCardIndex += 1
    board.push(copyPureCard(shuffledDeck[nextCardIndex] as Card))
    nextCardIndex += 1
  }

  return {
    burnedCards,
    board,
    remainingDeck: copyCards(shuffledDeck.slice(nextCardIndex)),
  }
}

function normalizeDealtHand(hand: unknown): DealtHand {
  const record = asRecord(hand, '发牌结果')
  const participantSeatNumbers = buttonRelativeSeatOrder(
    record.buttonSeatNumber,
    record.participantSeatNumbers,
  )
  const suppliedParticipantSeatNumbers =
    record.participantSeatNumbers as number[]

  if (
    !numberArraysMatch(suppliedParticipantSeatNumbers, participantSeatNumbers)
  ) {
    throw new RangeError('有效座位必须按第一轮发牌顺序保存。')
  }

  const shuffledDeck = normalizeStandardDeck(record.shuffledDeck)
  const holeCards = normalizeHoleCards(
    record.holeCards,
    participantSeatNumbers,
    shuffledDeck,
  )
  const burnedCards = normalizeCardArray(record.burnedCards, 'burn 牌')
  const board = normalizeCardArray(record.board, '公共牌')
  const remainingDeck = normalizeCardArray(record.remainingDeck, '剩余牌堆')

  validateCommunityCardCounts(board.length, burnedCards.length)

  const expectedCards = expectedCommunityCards(
    shuffledDeck,
    participantSeatNumbers.length,
    board.length,
  )
  if (
    !cardArraysMatch(burnedCards, expectedCards.burnedCards) ||
    !cardArraysMatch(board, expectedCards.board) ||
    !cardArraysMatch(remainingDeck, expectedCards.remainingDeck)
  ) {
    throw new RangeError('发牌结果无法追溯到完整洗后牌堆。')
  }

  return {
    buttonSeatNumber: record.buttonSeatNumber as number,
    participantSeatNumbers: [...participantSeatNumbers],
    shuffledDeck: copyCards(shuffledDeck),
    remainingDeck: copyCards(remainingDeck),
    holeCards,
    burnedCards: copyCards(burnedCards),
    board: copyCards(board),
  }
}

function appendCommunityCards(
  hand: DealtHand,
  boardCardCount: number,
): DealtHand {
  const burnCard = hand.remainingDeck[0]
  const boardCards = hand.remainingDeck.slice(1, boardCardCount + 1)

  if (burnCard === undefined || boardCards.length !== boardCardCount) {
    throw new RangeError('剩余牌堆不足以发出下一街公共牌。')
  }

  return {
    buttonSeatNumber: hand.buttonSeatNumber,
    participantSeatNumbers: [...hand.participantSeatNumbers],
    shuffledDeck: copyCards(hand.shuffledDeck),
    remainingDeck: copyCards(hand.remainingDeck.slice(boardCardCount + 1)),
    holeCards: hand.holeCards.map((holeCards) => ({
      seatNumber: holeCards.seatNumber,
      cards: [
        copyPureCard(holeCards.cards[0]),
        copyPureCard(holeCards.cards[1]),
      ],
    })),
    burnedCards: [...copyCards(hand.burnedCards), copyPureCard(burnCard)],
    board: [...copyCards(hand.board), ...copyCards(boardCards)],
  }
}

export function dealFlop(hand: DealtHand): DealtHand {
  const normalizedHand = normalizeDealtHand(hand)
  if (
    normalizedHand.board.length !== 0 ||
    normalizedHand.burnedCards.length !== 0
  ) {
    throw new RangeError('只能在翻前发翻牌。')
  }

  return appendCommunityCards(normalizedHand, 3)
}

export function dealTurn(hand: DealtHand): DealtHand {
  const normalizedHand = normalizeDealtHand(hand)
  if (
    normalizedHand.board.length !== 3 ||
    normalizedHand.burnedCards.length !== 1
  ) {
    throw new RangeError('只能在翻牌后发转牌。')
  }

  return appendCommunityCards(normalizedHand, 1)
}

export function dealRiver(hand: DealtHand): DealtHand {
  const normalizedHand = normalizeDealtHand(hand)
  if (
    normalizedHand.board.length !== 4 ||
    normalizedHand.burnedCards.length !== 2
  ) {
    throw new RangeError('只能在转牌后发河牌。')
  }

  return appendCommunityCards(normalizedHand, 1)
}

export function runoutRemainingBoard(hand: DealtHand): DealtHand {
  const normalizedHand = normalizeDealtHand(hand)

  if (normalizedHand.board.length === 0) {
    return dealRiver(dealTurn(dealFlop(normalizedHand)))
  }

  if (normalizedHand.board.length === 3) {
    return dealRiver(dealTurn(normalizedHand))
  }

  if (normalizedHand.board.length === 4) {
    return dealRiver(normalizedHand)
  }

  throw new RangeError('河牌已发出，不能再次补完公共牌。')
}
