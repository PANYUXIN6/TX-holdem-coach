import { describe, expect, test } from 'vitest'
import { STANDARD_DECK } from '../../src/poker/cards.js'

describe('standard card catalog', () => {
  test('contains exactly 52 unique standard cards', () => {
    expect(STANDARD_DECK).toHaveLength(52)
    expect(
      new Set(STANDARD_DECK.map((card) => `${card.suit}:${card.rank}`)).size,
    ).toBe(52)
  })
})
