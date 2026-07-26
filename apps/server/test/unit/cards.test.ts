import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import {
  CARD_BACK_RESOURCE_FILENAME,
  CARD_RESOURCE_FILENAMES,
  JOKER_BLACK_RESOURCE_FILENAME,
  JOKER_RED_RESOURCE_FILENAME,
  STANDARD_DECK,
} from '../../src/poker/cards.js'

const pokerResourceDirectory = fileURLToPath(
  new URL('../../../web/public/poker/', import.meta.url),
)
const pokerResourceFilenames = new Set(readdirSync(pokerResourceDirectory))

describe('standard card catalog', () => {
  test('contains exactly 52 unique standard cards', () => {
    expect(STANDARD_DECK).toHaveLength(52)
    expect(new Set(STANDARD_DECK.map((card) => card.code)).size).toBe(52)
    expect(
      new Set(STANDARD_DECK.map((card) => `${card.suit}:${card.rank}`)).size,
    ).toBe(52)
  })

  test('maps every standard card to an existing poker resource', () => {
    const mappedResourceFilenames = STANDARD_DECK.map(
      (card) => CARD_RESOURCE_FILENAMES[card.code],
    )

    expect(new Set(mappedResourceFilenames).size).toBe(52)

    for (const filename of mappedResourceFilenames) {
      expect(pokerResourceFilenames.has(filename)).toBe(true)
    }
  })

  test('excludes the card back and Jokers from the standard deck', () => {
    const standardResourceFilenames = new Set(
      Object.values(CARD_RESOURCE_FILENAMES),
    )

    expect(pokerResourceFilenames.has(CARD_BACK_RESOURCE_FILENAME)).toBe(true)
    expect(pokerResourceFilenames.has(JOKER_BLACK_RESOURCE_FILENAME)).toBe(true)
    expect(pokerResourceFilenames.has(JOKER_RED_RESOURCE_FILENAME)).toBe(true)
    expect(standardResourceFilenames).not.toContain(CARD_BACK_RESOURCE_FILENAME)
    expect(standardResourceFilenames).not.toContain(
      JOKER_BLACK_RESOURCE_FILENAME,
    )
    expect(standardResourceFilenames).not.toContain(JOKER_RED_RESOURCE_FILENAME)
  })
})
