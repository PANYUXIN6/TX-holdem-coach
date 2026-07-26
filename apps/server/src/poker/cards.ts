import { CARD_RANKS, CARD_SUITS } from '@poker-practice/contracts'
import type { Card, CardRank, CardSuit } from '@poker-practice/contracts'

const RESOURCE_SUIT_NAMES = {
  clubs: 'club',
  diamonds: 'diamond',
  hearts: 'heart',
  spades: 'spade',
} as const satisfies Record<CardSuit, string>

const RESOURCE_RANK_NAMES = {
  '2': '2',
  '3': '3',
  '4': '4',
  '5': '5',
  '6': '6',
  '7': '7',
  '8': '8',
  '9': '9',
  T: '10',
  J: 'J',
  Q: 'Q',
  K: 'K',
  A: 'A',
} as const satisfies Record<CardRank, string>

type ResourceSuitName = (typeof RESOURCE_SUIT_NAMES)[CardSuit]
type ResourceRankName = (typeof RESOURCE_RANK_NAMES)[CardRank]

export type CardCode = `${ResourceSuitName}_${ResourceRankName}`
export type CardResourceFilename = `${CardCode}.png`

export interface StandardCard extends Card {
  readonly code: CardCode
}

export const CARD_BACK_RESOURCE_FILENAME = 'card_back.png' as const
export const JOKER_BLACK_RESOURCE_FILENAME = 'joker_black.png' as const
export const JOKER_RED_RESOURCE_FILENAME = 'joker_red.png' as const

export function toCardCode(card: Card): CardCode {
  return `${RESOURCE_SUIT_NAMES[card.suit]}_${RESOURCE_RANK_NAMES[card.rank]}`
}

export const STANDARD_DECK = Object.freeze(
  CARD_SUITS.flatMap((suit) =>
    CARD_RANKS.map((rank) =>
      Object.freeze({
        rank,
        suit,
        code: toCardCode({ rank, suit }),
      }),
    ),
  ),
) as readonly StandardCard[]

const cardResourceFilenames = Object.fromEntries(
  STANDARD_DECK.map((card) => [
    card.code,
    `${card.code}.png` as CardResourceFilename,
  ]),
) as Record<CardCode, CardResourceFilename>

export const CARD_RESOURCE_FILENAMES: Readonly<
  Record<CardCode, CardResourceFilename>
> = Object.freeze(cardResourceFilenames)
