import { isDeepStrictEqual } from 'node:util'
import {
  assertCoachPlainData,
  freezeCoachData,
  HandReviewCaseSchema,
  CoachHindsightFactsSchema,
  type CoachDecisionSource,
  type HandReviewCase,
  type CoachHindsightFacts,
  type CoachDecisionInput,
} from './review-case.js'

/** Projector outputs must be subsets of actual completed facts, never hypothetical runouts. */
function validateHindsightFacts(
  source: HandReviewCase,
  input: CoachDecisionInput,
  facts: CoachHindsightFacts,
): void {
  const fail = () => {
    throw new TypeError('coach_hindsight_source_mismatch')
  }
  for (const key of [
    'revealedHandRanks',
    'runoutTransitions',
    'actualContinuation',
    'potAwards',
    'uncalledReturns',
    'showdownComparisonsByPot',
  ] as const) {
    for (const fact of facts[key])
      if (
        !source.auditTruth[key].some((actual) =>
          isDeepStrictEqual(actual, fact),
        )
      )
        fail()
    if (
      new Set(facts[key].map((f) => JSON.stringify(f))).size !==
      facts[key].length
    )
      fail()
  }
  if (facts.heroNetChips !== source.auditTruth.heroNetChips) fail()
  if (
    facts.runoutTransitions.some(
      (t) => t.eventSeq <= input.decision.eventSeq,
    ) ||
    facts.actualContinuation.some((t) => t.eventSeq <= input.decision.eventSeq)
  )
    fail()
  for (const rank of facts.revealedHandRanks)
    if (
      !source.auditTruth.actualHoleCards.some(
        (h) =>
          h.seatNumber === rank.seatNumber &&
          isDeepStrictEqual(h.cards, rank.holeCards),
      )
    )
      fail()
  for (const transition of facts.runoutTransitions) {
    if (
      transition.board.length !==
        { flop: 3, turn: 4, river: 5 }[transition.street] ||
      !isDeepStrictEqual(
        transition.board,
        source.auditTruth.actualBoard.slice(0, transition.board.length),
      )
    )
      fail()
  }
  const allIds = [
    ...facts.revealedHandRanks,
    ...facts.runoutTransitions,
    ...facts.potAwards,
    ...facts.uncalledReturns,
    ...facts.showdownComparisonsByPot,
  ].map((f) => f.factId)
  if (new Set(allIds).size !== allIds.length) fail()
  for (const pot of facts.potAwards) {
    if (
      pot.winnerSeats.some((s) => !pot.eligibleSeats.includes(s)) ||
      pot.awards.some((a) => !pot.winnerSeats.includes(a.seatNumber))
    )
      fail()
  }
  for (const comparison of facts.showdownComparisonsByPot) {
    const pot = facts.potAwards.find((p) => p.potId === comparison.potId)
    const ranks = comparison.handRankRefs.map((ref) =>
      facts.revealedHandRanks.find((r) => r.factId === ref),
    )
    if (
      !pot ||
      !isDeepStrictEqual(pot.eligibleSeats, comparison.eligibleSeats) ||
      !isDeepStrictEqual(pot.winnerSeats, comparison.winnerSeats) ||
      ranks.some((r) => !r) ||
      !isDeepStrictEqual(
        ranks.map((r) => r!.seatNumber).sort((a, b) => a - b),
        [...comparison.eligibleSeats].sort((a, b) => a - b),
      )
    )
      fail()
  }
}

/** The complete source and actual-fact validation stay inside this Projector.
 * The boundary owns the phase gate; ports are trusted composition, never model input. */
export function createHindsightFactProjector<
  Input extends CoachDecisionInput,
>(ports: {
  decisionSource: Readonly<CoachDecisionSource>
  canRead: () => boolean
  readSource: () => unknown
  project: (
    source: Readonly<HandReviewCase>,
    input: Input,
  ) => CoachHindsightFacts
}) {
  const { decisionSource, canRead, readSource, project } = ports
  let source: Readonly<HandReviewCase> | undefined
  function prepare(): void {
    if (!canRead()) throw new TypeError('coach_process_incomplete')
    if (source) return
    const raw = readSource()
    assertCoachPlainData(raw)
    const complete = HandReviewCaseSchema.parse(raw)
    const { auditTruth: _audit, ...safeSource } = complete
    if (!isDeepStrictEqual(safeSource, decisionSource))
      throw new TypeError('coach_hindsight_source_mismatch')
    source = freezeCoachData(complete)
  }
  return Object.freeze({
    prepare,
    project(input: Input): Readonly<CoachHindsightFacts> {
      if (!canRead() || !source)
        throw new TypeError('coach_hindsight_not_ready')
      const raw = project(source, input)
      assertCoachPlainData(raw)
      const facts = CoachHindsightFactsSchema.parse(raw)
      validateHindsightFacts(source, input, facts)
      return freezeCoachData(facts)
    },
  })
}
