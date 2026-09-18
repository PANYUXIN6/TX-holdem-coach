import { createHash } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { STANDARD_DECK } from '../poker/cards.js'
import { handEvaluator, type HandEvaluation } from '../poker/hand-evaluator.js'
import { projectShowdownAwards } from '../poker/showdown-awards.js'

type Card = HandEvaluation['bestFive'][number]
export interface EquityCombo {
  readonly cards: readonly [Card, Card]
  readonly weight: number
}
export interface EquityPot {
  readonly potIndex: number
  readonly amount: number
  readonly eligibleSeatNumbers: readonly number[]
}
export interface JointEquityInput {
  readonly tableSize: number
  readonly heroSeatNumber: number
  readonly heroHoleCards: readonly [Card, Card]
  readonly board: readonly Card[]
  readonly opponents: readonly {
    readonly seatNumber: number
    readonly combos: readonly EquityCombo[]
  }[]
  readonly pots: readonly EquityPot[]
  readonly buttonSeatNumber: number
  readonly decisionId: string
  readonly rangePackRef: string
  readonly jointScenarioId: string
  readonly policyVersion: 1
  readonly signal?: AbortSignal
}
export const EQUITY_COMPUTATION_POLICY = Object.freeze({
  version: 1,
  exactStateLimit: 200_000,
  minimumAcceptedSamples: 5_000,
  maximumAcceptedSamples: 25_000,
  maximumProposals: 500_000,
  batchSize: 250,
  targetHalfWidth: 0.01,
})
export interface EquityInterval {
  readonly lower: number
  readonly upper: number
}
export interface JointEquityAvailable {
  readonly status: 'available'
  readonly method: 'exactEnumeration' | 'monteCarlo'
  readonly seed: string
  readonly policyVersion: 1
  readonly exactStates: number | null
  readonly proposedSamples: number
  readonly acceptedSamples: number
  readonly pots: readonly (EquityPot & {
    readonly winProbability: number
    readonly tieProbability: number
    readonly lossProbability: number
    readonly expectedAllocationShare: number
    readonly expectedReturn: number
    readonly standardError: number | null
    readonly confidenceInterval: EquityInterval | null
  })[]
  readonly expectedHeroReturn: number
  readonly totalStandardError: number | null
  readonly totalConfidenceInterval: EquityInterval | null
}
export type JointEquityResult =
  | JointEquityAvailable
  | {
      readonly status: 'unavailable'
      readonly reasonCode:
        | 'emptyRange'
        | 'noLegalJointStates'
        | 'insufficientAcceptedSamples'
        | 'noContestablePot'
    }
const key = (card: Card) => `${card.rank}:${card.suit}`
function combinations(n: number, k: number): number {
  let result = 1
  for (let i = 1; i <= k; i++) result = (result * (n - i + 1)) / i
  return Math.round(result)
}
function randomGenerator(seed: string): () => number {
  let state = Number.parseInt(seed.slice(0, 8), 16) >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let n = Math.imul(state ^ (state >>> 15), 1 | state)
    n ^= n + Math.imul(n ^ (n >>> 7), 61 | n)
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296
  }
}
interface Moment {
  mass: number
  mean: number
  m2: number
}
const moment = (): Moment => ({ mass: 0, mean: 0, m2: 0 })
function add(stat: Moment, value: number, weight: number): void {
  if (weight === 0) return
  const mass = stat.mass + weight
  const delta = value - stat.mean
  stat.mean += (delta * weight) / mass
  stat.m2 += weight * delta * (value - stat.mean)
  stat.mass = mass
}
function standardError(stat: Moment): number {
  return Math.sqrt(Math.max(0, stat.m2 / (stat.mass - 1)) / stat.mass)
}
function interval(mean: number, se: number, max: number): EquityInterval {
  return {
    lower: Math.max(0, mean - 1.96 * se),
    upper: Math.min(max, mean + 1.96 * se),
  }
}
function* boards(
  deck: readonly Card[],
  missing: number,
  offset = 0,
  prefix: Card[] = [],
): Generator<readonly Card[]> {
  if (missing === 0) {
    yield prefix
    return
  }
  for (let i = offset; i <= deck.length - missing; i++)
    yield* boards(deck, missing - 1, i + 1, [...prefix, deck[i]!])
}
/** Product ranges conditioned on a single collision-free deck, never sequential renormalization. */
export async function computeJointEquity(
  input: JointEquityInput,
): Promise<JointEquityResult> {
  const policy = EQUITY_COMPUTATION_POLICY
  input.signal?.throwIfAborted()
  const known = [...input.heroHoleCards, ...input.board]
  const knownKeys = new Set(known.map(key))
  const deckKeys = new Set(STANDARD_DECK.map(key))
  const seats = [
    input.heroSeatNumber,
    ...input.opponents.map((o) => o.seatNumber),
  ]
  if (
    !Number.isInteger(input.tableSize) ||
    input.tableSize < 6 ||
    input.tableSize > 9 ||
    input.policyVersion !== 1 ||
    input.opponents.length < 1 ||
    input.opponents.length > 8 ||
    input.opponents.length + 1 > input.tableSize ||
    ![0, 3, 4, 5].includes(input.board.length) ||
    input.heroHoleCards.length !== 2 ||
    knownKeys.size !== known.length ||
    known.some((c) => !deckKeys.has(key(c))) ||
    new Set(seats).size !== seats.length ||
    seats.some((s) => !Number.isInteger(s) || s < 0 || s > 8) ||
    !Number.isInteger(input.buttonSeatNumber) ||
    input.buttonSeatNumber < 0 ||
    input.buttonSeatNumber > 8 ||
    !input.decisionId ||
    !input.rangePackRef ||
    !input.jointScenarioId ||
    new Set(input.pots.map((p) => p.potIndex)).size !== input.pots.length ||
    input.pots.some(
      (p) =>
        !Number.isSafeInteger(p.potIndex) ||
        p.potIndex < 0 ||
        !Number.isSafeInteger(p.amount) ||
        p.amount <= 0 ||
        p.eligibleSeatNumbers.length === 0 ||
        new Set(p.eligibleSeatNumbers).size !== p.eligibleSeatNumbers.length ||
        p.eligibleSeatNumbers.some((s) => !seats.includes(s)),
    )
  )
    throw new TypeError('invalid_joint_equity_input')
  const pots = input.pots.filter((p) =>
    p.eligibleSeatNumbers.includes(input.heroSeatNumber),
  )
  if (pots.length === 0)
    return { status: 'unavailable', reasonCode: 'noContestablePot' }
  const opponents = [...input.opponents]
    .sort((a, b) => a.seatNumber - b.seatNumber)
    .map((opponent) => {
      const identities = new Set<string>()
      for (const combo of opponent.combos) {
        const id = combo.cards.map(key).sort().join('|')
        if (
          combo.cards.length !== 2 ||
          key(combo.cards[0]) === key(combo.cards[1]) ||
          combo.cards.some((c) => !deckKeys.has(key(c))) ||
          !Number.isFinite(combo.weight) ||
          combo.weight < 0 ||
          identities.has(id)
        )
          throw new TypeError('invalid_joint_equity_range')
        identities.add(id)
      }
      const combos = opponent.combos.filter(
        (c) =>
          c.weight > 0 && c.cards.every((card) => !knownKeys.has(key(card))),
      )
      const maximum = Math.max(0, ...combos.map((c) => c.weight))
      const scaled = combos.map((c) => ({
        ...c,
        weight: c.weight / maximum,
        logWeight: Math.log(c.weight),
      }))
      const sum = scaled.reduce((n, c) => n + c.weight, 0)
      return {
        seatNumber: opponent.seatNumber,
        combos: scaled.map((c) => ({ ...c, weight: c.weight / sum })),
      }
    })
  if (opponents.some((o) => o.combos.length === 0))
    return { status: 'unavailable', reasonCode: 'emptyRange' }
  const seed = createHash('sha256')
    .update(
      JSON.stringify([
        input.decisionId,
        input.rangePackRef,
        input.jointScenarioId,
        input.policyVersion,
      ]),
    )
    .digest('hex')
  const random = randomGenerator(seed)
  const missing = 5 - input.board.length
  const runouts = combinations(
    52 - known.length - opponents.length * 2,
    missing,
  )
  const handLimit = Math.floor(policy.exactStateLimit / runouts)
  type Assignment = { combos: EquityCombo[]; logWeight: number }
  // Yield visited edges as well as assignments so impossible sparse products remain bounded and cancellable.
  function* joint(
    depth = 0,
    used = knownKeys,
    selected: EquityCombo[] = [],
    logWeight = 0,
  ): Generator<Assignment | null> {
    if (depth === opponents.length) {
      yield { combos: selected, logWeight }
      return
    }
    for (const combo of opponents[depth]!.combos) {
      yield null
      if (combo.cards.some((c) => used.has(key(c)))) continue
      yield* joint(
        depth + 1,
        new Set([...used, ...combo.cards.map(key)]),
        [...selected, combo],
        logWeight + combo.logWeight,
      )
    }
  }
  let hands: Assignment[] | null = handLimit > 0 ? [] : null
  let visits = 0
  if (hands) {
    for (const assignment of joint()) {
      visits++
      if (visits % policy.batchSize === 0) {
        await setImmediate()
        input.signal?.throwIfAborted()
      }
      if (assignment) hands.push(assignment)
      if (hands.length > handLimit || visits >= policy.maximumProposals) {
        hands = null
        break
      }
    }
    if (hands?.length === 0)
      return { status: 'unavailable', reasonCode: 'noLegalJointStates' }
  }
  const stats = pots.map(() => ({
    win: moment(),
    tie: moment(),
    loss: moment(),
    share: moment(),
  }))
  const total = moment()
  const contestable = pots.reduce((n, p) => n + p.amount, 0)
  if (!Number.isSafeInteger(contestable))
    throw new TypeError('invalid_joint_equity_pot_total')
  const layers = pots.map((p, index) => ({
    layerIndex: index,
    lowerContributionExclusive: 0,
    upperContributionInclusive: p.amount,
    amount: p.amount,
    contributingSeatNumbers: p.eligibleSeatNumbers,
    eligibleSeatNumbers: p.eligibleSeatNumbers,
  }))
  function record(
    assignment: readonly EquityCombo[],
    runout: readonly Card[],
    weight: number,
  ): void {
    const board = [...input.board, ...runout]
    const evaluations = new Map<number, HandEvaluation>([
      [
        input.heroSeatNumber,
        handEvaluator.evaluate([...input.heroHoleCards, ...board]),
      ],
    ])
    opponents.forEach((opponent, i) =>
      evaluations.set(
        opponent.seatNumber,
        handEvaluator.evaluate([...assignment[i]!.cards, ...board]),
      ),
    )
    const awards = projectShowdownAwards({
      layers,
      evaluations,
      buttonSeatNumber: input.buttonSeatNumber,
    })
    let returned = 0
    awards.forEach((pot, i) => {
      const award =
        pot.awards.find((a) => a.seatNumber === input.heroSeatNumber)?.amount ??
        0
      const wins = pot.winningSeatNumbers.includes(input.heroSeatNumber)
      add(
        stats[i]!.win,
        Number(wins && pot.winningSeatNumbers.length === 1),
        weight,
      )
      add(
        stats[i]!.tie,
        Number(wins && pot.winningSeatNumbers.length > 1),
        weight,
      )
      add(stats[i]!.loss, Number(!wins), weight)
      add(stats[i]!.share, award / pot.amount, weight)
      returned += award
    })
    add(total, returned, weight)
  }
  let accepted = 0
  let proposed = 0
  if (hands) {
    // Scale only after collision conditioning: all legal products may be tiny even
    // when each opponent's dominant combination has substantial marginal mass.
    const maximumLogWeight = hands.reduce(
      (max, assignment) => Math.max(max, assignment.logWeight),
      -Infinity,
    )
    for (const assignment of hands) {
      const used = new Set([
        ...knownKeys,
        ...assignment.combos.flatMap((c) => c.cards.map(key)),
      ])
      const deck = STANDARD_DECK.filter((c) => !used.has(key(c)))
      for (const runout of boards(deck, missing)) {
        record(
          assignment.combos,
          runout,
          Math.exp(assignment.logWeight - maximumLogWeight),
        )
        accepted++
        if (accepted % policy.batchSize === 0) {
          await setImmediate()
          input.signal?.throwIfAborted()
        }
      }
    }
  } else {
    const cumulative = opponents.map((o) => {
      let sum = 0
      return o.combos.map((c) => (sum += c.weight))
    })
    while (
      proposed < policy.maximumProposals &&
      accepted < policy.maximumAcceptedSamples
    ) {
      proposed++
      const assignment = opponents.map((o, i) => {
        const draw = random()
        let low = 0,
          high = o.combos.length - 1
        while (low < high) {
          const middle = (low + high) >>> 1
          if (draw < cumulative[i]![middle]!) high = middle
          else low = middle + 1
        }
        return o.combos[low]!
      })
      const used = new Set([
        ...knownKeys,
        ...assignment.flatMap((c) => c.cards.map(key)),
      ])
      if (used.size === known.length + opponents.length * 2) {
        const deck = STANDARD_DECK.filter((c) => !used.has(key(c)))
        for (let i = 0; i < missing; i++) {
          const j = i + Math.floor(random() * (deck.length - i))
          ;[deck[i], deck[j]] = [deck[j]!, deck[i]!]
        }
        record(assignment, deck.slice(0, missing), 1)
        accepted++
      }
      if (proposed % policy.batchSize === 0) {
        await setImmediate()
        input.signal?.throwIfAborted()
        if (
          accepted >= policy.minimumAcceptedSamples &&
          stats.every(
            (s) => 1.96 * standardError(s.share) <= policy.targetHalfWidth,
          ) &&
          (1.96 * standardError(total)) / contestable <= policy.targetHalfWidth
        )
          break
      }
    }
    if (accepted < policy.minimumAcceptedSamples)
      return {
        status: 'unavailable',
        reasonCode: 'insufficientAcceptedSamples',
      }
  }
  input.signal?.throwIfAborted()
  const exact = hands !== null
  return {
    status: 'available',
    method: exact ? 'exactEnumeration' : 'monteCarlo',
    seed,
    policyVersion: 1,
    exactStates: exact ? accepted : null,
    proposedSamples: exact ? 0 : proposed,
    acceptedSamples: exact ? 0 : accepted,
    pots: pots.map((pot, i) => ({
      ...pot,
      winProbability: stats[i]!.win.mean,
      tieProbability: stats[i]!.tie.mean,
      lossProbability: stats[i]!.loss.mean,
      expectedAllocationShare: stats[i]!.share.mean,
      expectedReturn: stats[i]!.share.mean * pot.amount,
      standardError: exact ? null : standardError(stats[i]!.share),
      confidenceInterval: exact
        ? null
        : interval(stats[i]!.share.mean, standardError(stats[i]!.share), 1),
    })),
    expectedHeroReturn: total.mean,
    totalStandardError: exact ? null : standardError(total),
    totalConfidenceInterval: exact
      ? null
      : interval(total.mean, standardError(total), contestable),
  }
}
