import { isDeepStrictEqual } from 'node:util'
import { DecisionAnalysisInputSchema } from '../../poker/decision-analysis-input-schema.js'
import { getProjectedLegalActions } from '../../poker/betting-projection.js'
import { toBettingProjectionState } from '../../poker/decision-analysis-input.js'
import {
  CoachStreetStartStateSchema,
  projectCoachVisibleState,
  projectCoachLegalActions,
} from './analysis-input.js'
import { z } from 'zod'
import {
  CardSchema,
  CoachDecisionIdSchema,
  CoachStreetSchema,
  CoachLegalActionSchema,
  CoachSeatStateSchema,
  CoachPublicActionFactSchema,
  PokerActionSchema,
  PublicLogicalPositionSchema,
  PublicHandCategorySchema,
  SeatNumberSchema,
  HandIdSchema,
  SessionIdSchema,
} from '@tx-holdem-coach/contracts'
import { POKER_RULE_SET_VERSION } from '../../poker/poker-rule-set.js'

export const CoachSequence = z.number().int().nonnegative().safe()
export const CoachVersionReferenceSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9_.:-]{1,160}$/),
  version: z.number().int().positive().safe(),
})
export const CoachVersionsSchema = z.strictObject({
  metrics: CoachVersionReferenceSchema,
  rangeModel: CoachVersionReferenceSchema,
  equityComputation: CoachVersionReferenceSchema,
  settlement: CoachVersionReferenceSchema,
  opponentEvidence: CoachVersionReferenceSchema,
  classifier: CoachVersionReferenceSchema,
  conclusion: CoachVersionReferenceSchema,
  severity: CoachVersionReferenceSchema,
  teaching: CoachVersionReferenceSchema,
})
export const CoachBindingSchema = z.strictObject({
  ownerId: z.string().min(1).max(160),
  sessionId: SessionIdSchema,
  handId: HandIdSchema,
  runId: z.uuid(),
  pokerRuleSetVersion: z.literal(POKER_RULE_SET_VERSION),
  versions: CoachVersionsSchema,
})
export const CoachVisibleStateSchema = z.strictObject({
  heroSeat: SeatNumberSchema,
  heroHoleCards: z.tuple([CardSchema, CardSchema]),
  board: z.array(CardSchema).max(5),
  seats: z.array(CoachSeatStateSchema).min(6).max(9),
  buttonSeat: SeatNumberSchema,
  smallBlindSeat: SeatNumberSchema,
  bigBlindSeat: SeatNumberSchema,
  nominalSmallBlind: CoachSequence,
  nominalBigBlind: CoachSequence,
  actualSmallBlind: CoachSequence,
  actualBigBlind: CoachSequence,
  publicActions: z.array(CoachPublicActionFactSchema),
})
export const CoachHeroDecisionSchema = z
  .strictObject({
    decisionId: CoachDecisionIdSchema,
    eventSeq: CoachSequence,
    stateVersion: CoachSequence,
    street: CoachStreetSchema,
    logicalPosition: PublicLogicalPositionSchema,
    visibleState: CoachVisibleStateSchema,
    analysisInput: DecisionAnalysisInputSchema,
    streetStartState: CoachStreetStartStateSchema,
    legalActions: z.array(CoachLegalActionSchema).min(1),
    actualAction: PokerActionSchema,
    stacksAndContributions: z.array(CoachSeatStateSchema).min(6).max(9),
    // Captured by the authoritative builder at this decision's cutoff, never by derive.
    opponentEvidenceSubjects: z
      .array(
        z.strictObject({
          seatNumber: SeatNumberSchema,
          personaSnapshotId: z
            .string()
            .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/),
        }),
      )
      .max(8),
    opponentEvidenceCutoff: z.strictObject({
      sessionId: SessionIdSchema,
      asOfEventSeq: CoachSequence,
    }),
  })
  .superRefine((d, ctx) => {
    const fail = () =>
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid decision time or visible facts',
      })
    try {
      const input = d.analysisInput
      if (
        !isDeepStrictEqual(projectCoachVisibleState(input), d.visibleState) ||
        !isDeepStrictEqual(projectCoachLegalActions(input), d.legalActions) ||
        !isDeepStrictEqual(
          getProjectedLegalActions(toBettingProjectionState(input)),
          input.legalActions,
        ) ||
        input.street !== d.street ||
        input.publicActions.some((action) => action.eventSeq >= d.eventSeq) ||
        d.opponentEvidenceCutoff.asOfEventSeq !== d.eventSeq - 1 ||
        (d.street === 'preflop') !==
          (d.streetStartState.status === 'notApplicable') ||
        (d.streetStartState.status === 'available' &&
          (d.streetStartState.street !== d.street ||
            d.streetStartState.eventSeq >= d.eventSeq))
      )
        fail()
    } catch {
      fail()
    }
    const [, street, seq] = d.decisionId.split(':')
    if (
      street !== d.street ||
      Number(seq) !== d.eventSeq ||
      d.opponentEvidenceCutoff.asOfEventSeq >= d.eventSeq
    )
      fail()
    if (
      d.visibleState.board.length !==
      { preflop: 0, flop: 3, turn: 4, river: 5 }[d.street]
    )
      fail()
    if (
      d.visibleState.publicActions.some(
        (a) => a.eventSeq > d.opponentEvidenceCutoff.asOfEventSeq,
      )
    )
      fail()
    if (
      d.visibleState.publicActions.some(
        (a, i) =>
          i > 0 && a.eventSeq <= d.visibleState.publicActions[i - 1]!.eventSeq,
      )
    )
      fail()
    const cards = [
      ...d.visibleState.heroHoleCards,
      ...d.visibleState.board,
    ].map((c) => c.rank + c.suit)
    if (new Set(cards).size !== cards.length) fail()
    const seats = d.visibleState.seats.map((s) => s.seatNumber)
    if (
      new Set(seats).size !== seats.length ||
      [
        d.visibleState.heroSeat,
        d.visibleState.buttonSeat,
        d.visibleState.smallBlindSeat,
        d.visibleState.bigBlindSeat,
      ].some((s) => !seats.includes(s))
    )
      fail()
    if (
      d.visibleState.seats.find((s) => s.seatNumber === d.visibleState.heroSeat)
        ?.logicalPosition !== d.logicalPosition
    )
      fail()
    if (
      JSON.stringify(d.visibleState.seats) !==
      JSON.stringify(d.stacksAndContributions)
    )
      fail()
    if (
      new Set(d.opponentEvidenceSubjects.map((s) => s.seatNumber)).size !==
        d.opponentEvidenceSubjects.length ||
      d.opponentEvidenceSubjects.some(
        (subject) =>
          subject.seatNumber === d.visibleState.heroSeat ||
          !d.visibleState.seats.some(
            (seat) =>
              seat.seatNumber === subject.seatNumber &&
              (seat.status === 'active' || seat.status === 'allIn'),
          ),
      )
    )
      fail()
    const legal = d.legalActions.find((a) => a.action === d.actualAction.type)
    if (!legal) fail()
    if (
      'targetStreetCommitment' in d.actualAction &&
      (!legal ||
        legal.minimumTarget === null ||
        legal.maximumTarget === null ||
        d.actualAction.targetStreetCommitment < legal.minimumTarget ||
        d.actualAction.targetStreetCommitment > legal.maximumTarget)
    )
      fail()
  })
export const CoachDecisionInputSchema = z
  .strictObject({
    reviewContextVersion: z.literal(1),
    binding: CoachBindingSchema,
    tableSize: z.number().int().min(6).max(9),
    decision: CoachHeroDecisionSchema,
  })
  .superRefine((v, ctx) => {
    if (
      v.decision.decisionId.split(':')[0] !== v.binding.handId ||
      v.decision.opponentEvidenceCutoff.sessionId !== v.binding.sessionId ||
      v.decision.visibleState.seats.length !== v.tableSize
    )
      ctx.addIssue({ code: 'custom', message: 'Decision binding mismatch' })
  })
const ref = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/)
export const CoachRevealedHandRankSchema = z.strictObject({
  factId: ref,
  seatNumber: SeatNumberSchema,
  holeCards: z.tuple([CardSchema, CardSchema]),
  category: PublicHandCategorySchema,
  comparisonTuple: z.array(CoachSequence).min(1).max(6),
  asOfEventSeq: CoachSequence,
})
export const CoachRunoutTransitionSchema = z.strictObject({
  factId: ref,
  eventSeq: CoachSequence,
  street: z.enum(['flop', 'turn', 'river']),
  board: z.array(CardSchema).min(3).max(5),
})
export const CoachPotAwardSchema = z.strictObject({
  factId: ref,
  potId: ref,
  eligibleSeats: z.array(SeatNumberSchema).min(1),
  winnerSeats: z.array(SeatNumberSchema).min(1),
  awards: z
    .array(
      z.strictObject({ seatNumber: SeatNumberSchema, chips: CoachSequence }),
    )
    .min(1),
})
export const CoachUncalledReturnSchema = z.strictObject({
  factId: ref,
  seatNumber: SeatNumberSchema,
  chips: CoachSequence,
})
export const CoachShowdownComparisonSchema = z.strictObject({
  factId: ref,
  potId: ref,
  eligibleSeats: z.array(SeatNumberSchema).min(2),
  winnerSeats: z.array(SeatNumberSchema).min(1),
  handRankRefs: z.array(ref).min(2),
})
export const CoachHindsightFactsSchema = z.strictObject({
  revealedHandRanks: z.array(CoachRevealedHandRankSchema),
  runoutTransitions: z.array(CoachRunoutTransitionSchema),
  actualContinuation: z.array(CoachPublicActionFactSchema),
  potAwards: z.array(CoachPotAwardSchema),
  uncalledReturns: z.array(CoachUncalledReturnSchema),
  heroNetChips: z.number().int().safe(),
  showdownComparisonsByPot: z.array(CoachShowdownComparisonSchema),
})
export const CoachAuditTruthSchema = z.strictObject({
  actualHoleCards: z.array(
    z.strictObject({
      seatNumber: SeatNumberSchema,
      cards: z.tuple([CardSchema, CardSchema]),
    }),
  ),
  actualBoard: z.array(CardSchema).max(5),
  ...CoachHindsightFactsSchema.shape,
})
export const CoachDecisionSourceSchema = z
  .strictObject({
    reviewContextVersion: z.literal(1),
    binding: CoachBindingSchema,
    tableSize: z.number().int().min(6).max(9),
    completedEventSeq: CoachSequence,
    heroDecisions: z.array(CoachHeroDecisionSchema),
  })
  .superRefine((c, ctx) => {
    for (const [i, decision] of c.heroDecisions.entries()) {
      if (
        !CoachDecisionInputSchema.safeParse({
          reviewContextVersion: c.reviewContextVersion,
          binding: c.binding,
          tableSize: c.tableSize,
          decision,
        }).success ||
        decision.eventSeq >= c.completedEventSeq ||
        (i > 0 && decision.eventSeq <= c.heroDecisions[i - 1]!.eventSeq)
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Invalid authoritative decision list',
        })
    }
  })
export type CoachDecisionSource = z.infer<typeof CoachDecisionSourceSchema>

export const HandReviewCaseSchema = z
  .strictObject({
    ...CoachDecisionSourceSchema.shape,
    auditTruth: CoachAuditTruthSchema,
  })
  .superRefine((c, ctx) => {
    const { auditTruth: _audit, ...decisionSource } = c
    if (!CoachDecisionSourceSchema.safeParse(decisionSource).success)
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid authoritative decision list',
      })
    const board = c.auditTruth.actualBoard
    if (![0, 3, 4, 5].includes(board.length))
      ctx.addIssue({ code: 'custom', message: 'Invalid actual board' })
    const usedCards = [
      ...board,
      ...c.auditTruth.actualHoleCards.flatMap((h) => h.cards),
    ].map((card) => card.rank + card.suit)
    if (
      new Set(usedCards).size !== usedCards.length ||
      new Set(c.auditTruth.actualHoleCards.map((h) => h.seatNumber)).size !==
        c.auditTruth.actualHoleCards.length
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Duplicate actual cards or seats',
      })
    for (const d of c.heroDecisions) {
      const hero = c.auditTruth.actualHoleCards.find(
        (h) => h.seatNumber === d.visibleState.heroSeat,
      )
      if (
        JSON.stringify(d.visibleState.board) !==
          JSON.stringify(board.slice(0, d.visibleState.board.length)) ||
        !hero ||
        JSON.stringify(hero.cards) !==
          JSON.stringify(d.visibleState.heroHoleCards)
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Decision visible source mismatch',
        })
    }
    if (
      c.auditTruth.runoutTransitions.some(
        (t) => t.eventSeq > c.completedEventSeq,
      ) ||
      c.auditTruth.revealedHandRanks.some(
        (r) => r.asOfEventSeq > c.completedEventSeq,
      ) ||
      c.auditTruth.actualContinuation.some(
        (a) => a.eventSeq > c.completedEventSeq,
      )
    )
      ctx.addIssue({ code: 'custom', message: 'Facts after hand completion' })
  })
export type HandReviewCase = z.infer<typeof HandReviewCaseSchema>
export type CoachDecisionInput = z.infer<typeof CoachDecisionInputSchema>
export type CoachHindsightFacts = z.infer<typeof CoachHindsightFactsSchema>

/** Reject accessors before parsing so getters cannot supply a different source on a later read. */
export function assertCoachPlainData(
  value: unknown,
  seen = new Set<object>(),
): void {
  if (value === null || typeof value !== 'object') {
    if (
      typeof value === 'function' ||
      typeof value === 'symbol' ||
      typeof value === 'bigint'
    )
      throw new TypeError('coach_invalid_data')
    return
  }
  if (seen.has(value)) throw new TypeError('coach_cyclic_data')
  seen.add(value)
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new TypeError('coach_invalid_prototype')
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (typeof key === 'symbol' || descriptor.get || descriptor.set)
      throw new TypeError('coach_invalid_accessor')
    assertCoachPlainData(descriptor.value, seen)
  }
  seen.delete(value)
}
export function freezeCoachData<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) freezeCoachData(nested)
    Object.freeze(value)
  }
  return value
}
