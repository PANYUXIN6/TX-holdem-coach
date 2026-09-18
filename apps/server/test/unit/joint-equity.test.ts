import { describe, expect, it } from 'vitest'
import { STANDARD_DECK } from '../../src/poker/cards.js'
import {
  computeJointEquity,
  type JointEquityInput,
} from '../../src/poker-range/joint-equity.js'
const card = (
  rank: (typeof STANDARD_DECK)[number]['rank'],
  suit: (typeof STANDARD_DECK)[number]['suit'] = 'clubs',
) => ({ rank, suit })
function input(): JointEquityInput {
  return {
    tableSize: 6,
    heroSeatNumber: 1,
    heroHoleCards: [card('2'), card('3')],
    board: ['T', 'J', 'Q', 'K', 'A'].map((r) => card(r as 'T', 'spades')),
    opponents: [
      { seatNumber: 2, combos: [{ cards: [card('4'), card('5')], weight: 1 }] },
      { seatNumber: 3, combos: [{ cards: [card('6'), card('7')], weight: 1 }] },
    ],
    pots: [
      { potIndex: 0, amount: 101, eligibleSeatNumbers: [1, 2, 3] },
      { potIndex: 1, amount: 11, eligibleSeatNumbers: [1, 2] },
      { potIndex: 2, amount: 7, eligibleSeatNumbers: [2, 3] },
    ],
    buttonSeatNumber: 0,
    decisionId: 'decision-1',
    rangePackRef: 'fixture@1',
    jointScenarioId: 'base',
    policyVersion: 1,
  }
}
describe('joint equity over one collision-free deck', () => {
  it('uses per-pot eligibility, ties and production odd-chip awards in exact enumeration', async () => {
    const result = await computeJointEquity(input())
    expect(result.status).toBe('available')
    if (result.status !== 'available') return
    expect(result.method).toBe('exactEnumeration')
    expect(result.exactStates).toBe(1)
    expect(result.pots.map((p) => p.expectedReturn)).toEqual([34, 6])
    expect(
      result.pots.map((p) => [
        p.winProbability,
        p.tieProbability,
        p.lossProbability,
      ]),
    ).toEqual([
      [0, 1, 0],
      [0, 1, 0],
    ])
    expect(result.expectedHeroReturn).toBe(40)
    expect(result.totalStandardError).toBeNull()
  })
  it('conditions product weights on conflicts, rather than sequential seat sampling', async () => {
    const source = input()
    const result = await computeJointEquity({
      ...source,
      opponents: [
        {
          seatNumber: 2,
          combos: [
            { cards: [card('4'), card('5')], weight: 2 },
            { cards: [card('6'), card('7')], weight: 1 },
          ],
        },
        {
          seatNumber: 3,
          combos: [{ cards: [card('4'), card('8')], weight: 1 }],
        },
      ],
    })
    expect(result.status === 'available' && result.exactStates).toBe(1)
    const impossible = await computeJointEquity({
      ...source,
      opponents: [
        source.opponents[0]!,
        { seatNumber: 3, combos: source.opponents[0]!.combos },
      ],
    })
    expect(impossible).toEqual({
      status: 'unavailable',
      reasonCode: 'noLegalJointStates',
    })
  })
  it('reproduces Monte Carlo, is invariant to opponent array order, and agrees with the exact board tie', async () => {
    const source = input()
    const known = [...source.heroHoleCards, ...source.board].map(
      (c) => `${c.rank}${c.suit}`,
    )
    const available = STANDARD_DECK.filter(
      (c) => !known.includes(`${c.rank}${c.suit}`),
    )
    const combos = available.flatMap((a, i) =>
      available
        .slice(i + 1)
        .map((b) => ({ cards: [a, b] as const, weight: 1 })),
    )
    const opponents = [
      { seatNumber: 2, combos },
      { seatNumber: 3, combos },
    ]
    const first = await computeJointEquity({ ...source, opponents })
    const second = await computeJointEquity({
      ...source,
      opponents: [...opponents].reverse(),
    })
    expect(first).toEqual(second)
    expect(first.status).toBe('available')
    if (first.status !== 'available') return
    expect(first.method).toBe('monteCarlo')
    expect(first.acceptedSamples).toBeGreaterThanOrEqual(5000)
    expect(first.proposedSamples).toBeGreaterThan(first.acceptedSamples)
    expect(first.expectedHeroReturn).toBe(40)
    expect(first.totalConfidenceInterval).toEqual({ lower: 40, upper: 40 })
  }, 30_000)
  it('rejects invalid table identities and cancels without a partial result', async () => {
    await expect(
      computeJointEquity({ ...input(), tableSize: 2 }),
    ).rejects.toThrow('invalid_joint_equity_input')
    const controller = new AbortController()
    controller.abort()
    await expect(
      computeJointEquity({ ...input(), signal: controller.signal }),
    ).rejects.toThrow()
  })
})

it('uses collision-conditioned product mass for wins and remains stable at tiny legal mass', async () => {
  const source = input()
  const base: JointEquityInput = {
    ...source,
    heroHoleCards: [card('A'), card('A', 'diamonds')],
    board: [
      card('2'),
      card('7', 'diamonds'),
      card('9', 'hearts'),
      card('J', 'spades'),
      card('Q'),
    ],
    pots: [{ potIndex: 0, amount: 90, eligibleSeatNumbers: [1, 2, 3] }],
    opponents: [
      {
        seatNumber: 2,
        combos: [
          { cards: [card('K'), card('K', 'diamonds')], weight: 2 },
          { cards: [card('Q', 'hearts'), card('Q', 'diamonds')], weight: 1 },
        ],
      },
      {
        seatNumber: 3,
        combos: [
          { cards: [card('K'), card('3')], weight: 3 },
          { cards: [card('4'), card('5')], weight: 1 },
        ],
      },
    ],
  }
  // Legal product masses: Hero wins KK/45 with 2; loses QQ/K3 with 3 and QQ/45 with 1.
  const result = await computeJointEquity(base)
  expect(result.status).toBe('available')
  if (result.status !== 'available') return
  expect(result.exactStates).toBe(3)
  expect(result.pots[0]!.winProbability).toBeCloseTo(1 / 3, 12)
  expect(result.expectedHeroReturn).toBeCloseTo(30, 12)
  // Both dominant combos collide; each surviving product is below IEEE-754 minimum before conditioning.
  const tiny = await computeJointEquity({
    ...base,
    opponents: [
      {
        seatNumber: 2,
        combos: [
          { cards: [card('K'), card('K', 'diamonds')], weight: 1e-300 },
          { cards: [card('4'), card('6')], weight: 1e300 },
        ],
      },
      {
        seatNumber: 3,
        combos: [{ cards: [card('4'), card('5')], weight: 1e-300 }],
      },
    ],
  })
  expect(tiny.status === 'available' && tiny.expectedHeroReturn).toBe(90)
})

it('Monte Carlo estimates a nonconstant exact hypergeometric share and correlated total uncertainty', async () => {
  const source: JointEquityInput = {
    ...input(),
    heroHoleCards: [card('A'), card('K')],
    board: [
      card('2'),
      card('2', 'diamonds'),
      card('2', 'hearts'),
      card('2', 'spades'),
      card('3'),
    ],
    pots: [
      { potIndex: 0, amount: 600, eligibleSeatNumbers: [1, 2, 3] },
      { potIndex: 1, amount: 1200, eligibleSeatNumbers: [1, 2, 3] },
    ],
  }
  const known = new Set(
    [...source.heroHoleCards, ...source.board].map((c) => `${c.rank}${c.suit}`),
  )
  const deck = STANDARD_DECK.filter((c) => !known.has(`${c.rank}${c.suit}`))
  const combos = deck.flatMap((a, i) =>
    deck.slice(i + 1).map((b) => ({ cards: [a, b] as const, weight: 1 })),
  )
  const result = await computeJointEquity({
    ...source,
    opponents: [
      { seatNumber: 2, combos },
      { seatNumber: 3, combos },
    ],
  })
  expect(result.status).toBe('available')
  if (result.status !== 'available') return
  const win = (42 * 41 * 40 * 39) / (45 * 44 * 43 * 42)
  const bothHaveAce = 1 - (2 * (42 * 41)) / (45 * 44) + win
  const share = win + (1 - win - bothHaveAce) / 2 + bothHaveAce / 3
  expect(result.method).toBe('monteCarlo')
  expect(Math.abs(result.pots[0]!.winProbability - win)).toBeLessThan(0.025)
  expect(
    Math.abs(result.pots[0]!.expectedAllocationShare - share),
  ).toBeLessThan(0.015)
  expect(result.pots[0]!.standardError).toBeGreaterThan(0)
  expect(result.totalStandardError).toBeCloseTo(
    result.pots[0]!.standardError! * 1800,
    10,
  )
  expect(
    result.totalConfidenceInterval!.upper -
      result.totalConfidenceInterval!.lower,
  ).toBeLessThanOrEqual(36)
}, 30_000)

it('executes the proposal cap for impossible ranges and yields to cancellation during computation', async () => {
  const source = { ...input(), board: [], pots: [input().pots[0]!] }
  const opponent = source.opponents[0]!
  const impossible = {
    ...source,
    opponents: [opponent, { ...opponent, seatNumber: 3 }],
  }
  await expect(computeJointEquity(impossible)).resolves.toEqual({
    status: 'unavailable',
    reasonCode: 'insufficientAcceptedSamples',
  })
  const controller = new AbortController()
  const running = computeJointEquity({
    ...impossible,
    signal: controller.signal,
  })
  setImmediate(() => controller.abort(new Error('cancel-during-batch')))
  await expect(running).rejects.toThrow('cancel-during-batch')
}, 30_000)

it('allows six seated players to use physical seat eight', async () => {
  const source = input()
  await expect(
    computeJointEquity({ ...source, buttonSeatNumber: 8 }),
  ).resolves.toMatchObject({ status: 'available' })
})
