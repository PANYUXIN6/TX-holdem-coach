import { describe, expect, test } from 'vitest'
import {
  createControlledRandom,
  createDeterministicDeck,
  createFakeClock,
  createFixedIdGenerator,
} from '../tools.js'

describe('createDeterministicDeck', () => {
  test('keeps independent draw cursors for each deck instance', () => {
    const firstDeck = createDeterministicDeck(['first', 'second'])
    const secondDeck = createDeterministicDeck(['first', 'second'])

    expect(firstDeck.draw()).toBe('first')
    expect(firstDeck.draw()).toBe('second')
    expect(secondDeck.draw()).toBe('first')
  })
})

describe('createControlledRandom', () => {
  test('keeps independent cursors for each random source', () => {
    const firstRandom = createControlledRandom([0.1, 0.9])
    const secondRandom = createControlledRandom([0.1, 0.9])

    expect(firstRandom.next()).toBe(0.1)
    expect(firstRandom.next()).toBe(0.9)
    expect(secondRandom.next()).toBe(0.1)
  })
})

describe('createFakeClock', () => {
  test('keeps time isolated for each clock instance', () => {
    const firstClock = createFakeClock(1_000)
    const secondClock = createFakeClock(1_000)

    firstClock.advanceBy(500)

    expect(firstClock.now()).toBe(1_500)
    expect(secondClock.now()).toBe(1_000)
  })
})

describe('createFixedIdGenerator', () => {
  test('keeps ID scripts isolated for each generator instance', () => {
    const firstGenerator = createFixedIdGenerator(['first-id', 'second-id'])
    const secondGenerator = createFixedIdGenerator(['first-id', 'second-id'])

    expect(firstGenerator.next()).toBe('first-id')
    expect(firstGenerator.next()).toBe('second-id')
    expect(secondGenerator.next()).toBe('first-id')
  })
})
