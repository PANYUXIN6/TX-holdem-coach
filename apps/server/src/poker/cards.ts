import { CARD_RANKS, CARD_SUITS, type Card } from '@tx-holdem-coach/contracts'

export const STANDARD_DECK = Object.freeze(
  CARD_SUITS.flatMap((suit) =>
    CARD_RANKS.map((rank) =>
      Object.freeze({
        rank,
        suit,
      }),
    ),
  ),
) as readonly Card[]
