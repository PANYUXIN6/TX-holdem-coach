import { z } from 'zod'
import { M45AssumptionCodeSchema } from './decision-analysis-types.js'
const SafeNonnegativeIntegerSchema = z.number().int().nonnegative().safe()
const SeatNumberSchema = z.number().int().min(0).max(8)
const ActionTypeSchema = z.enum([
  'fold',
  'check',
  'call',
  'bet',
  'raise',
  'allIn',
])
const ExactRatioSchema = z.strictObject({
  numerator: SafeNonnegativeIntegerSchema,
  denominator: SafeNonnegativeIntegerSchema.positive(),
  basisPoints: SafeNonnegativeIntegerSchema,
})
export function createActionOutcomeSchema<TSource extends z.ZodType>(
  FactSourceRefSchema: TSource,
) {
  const CandidateSprProjectionSchema = z.discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('available'),
      value: z.array(
        z.strictObject({
          opponentSeatNumber: SeatNumberSchema,
          effectiveStack: SafeNonnegativeIntegerSchema,
          spr: ExactRatioSchema,
        }),
      ),
      sourceRefs: z.array(FactSourceRefSchema),
    }),
    z.strictObject({
      status: z.literal('notApplicable'),
      reasonCode: z.enum([
        'forcedRunout',
        'bettingRoundRemainsOpen',
        'handComplete',
        'wrongStreet',
        'noFutureDecisionStreet',
      ]),
      sourceRefs: z.array(FactSourceRefSchema),
    }),
  ])

  const CandidateThresholdFactSchema = z.discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('available'),
      value: ExactRatioSchema,
      epistemicKind: z.literal('formulaFact'),
      sourceRefs: z.array(FactSourceRefSchema),
      assumptionCodes: z.tuple([z.literal('ignoresFutureAction')]),
    }),
    z.strictObject({
      status: z.literal('unavailable'),
      reasonCode: z.literal('noJointResponseModel'),
      sourceRefs: z.array(FactSourceRefSchema),
      assumptionCodes: z.tuple([z.literal('noJointResponseModel')]),
    }),
    z.strictObject({
      status: z.literal('notApplicable'),
      reasonCode: z.enum(['notCallingAction', 'notPureBluffCandidate']),
      sourceRefs: z.array(FactSourceRefSchema),
      assumptionCodes: z.tuple([]),
    }),
  ])

  const UnavailableOutcomeFactSchema = z.strictObject({
    status: z.literal('unavailable'),
    reasonCode: z.enum(['noVersionedOpponentRange', 'noJointResponseModel']),
    sourceRefs: z.array(FactSourceRefSchema),
    assumptionCodes: z.array(M45AssumptionCodeSchema),
  })

  const ActionOutcomeDataSchema = z.strictObject({
    candidateOutcomeSchemaVersion: z.literal(1),
    projectorVersion: z.literal(1),
    sourceRefs: z.array(FactSourceRefSchema),
    amountToCall: SafeNonnegativeIntegerSchema,
    contributionDelta: SafeNonnegativeIntegerSchema,
    targetStreetCommitment: z.discriminatedUnion('status', [
      z.strictObject({
        status: z.literal('available'),
        value: SafeNonnegativeIntegerSchema,
      }),
      z.strictObject({
        status: z.literal('notApplicable'),
        reasonCode: z.literal('noTarget'),
      }),
    ]),
    streetContributionAfter: SafeNonnegativeIntegerSchema,
    totalContributionAfter: SafeNonnegativeIntegerSchema,
    guaranteedUncalledReturn: SafeNonnegativeIntegerSchema,
    amountActuallyAtRisk: SafeNonnegativeIntegerSchema,
    contestableAmountAdded: SafeNonnegativeIntegerSchema,
    potAfterAction: SafeNonnegativeIntegerSchema,
    heroContestablePotAfterAction: SafeNonnegativeIntegerSchema,
    marginalContestablePot: z.strictObject({
      amountActuallyAtRisk: SafeNonnegativeIntegerSchema,
      contestableAmountAdded: SafeNonnegativeIntegerSchema,
    }),
    actionScale: z.strictObject({
      contributionDeltaToPotBefore: z.strictObject({
        ratioKind: z.literal('contributionDeltaToPotBefore'),
        value: ExactRatioSchema,
      }),
      targetStreetCommitmentToPotBefore: z.discriminatedUnion('status', [
        z.strictObject({
          status: z.literal('available'),
          ratioKind: z.literal('targetStreetCommitmentToPotBefore'),
          value: ExactRatioSchema,
        }),
        z.strictObject({
          status: z.literal('notApplicable'),
          reasonCode: z.literal('noTarget'),
        }),
      ]),
    }),
    heroStackAfterAction: SafeNonnegativeIntegerSchema,
    effectiveStacksByOpponentAfterAction: z.array(
      z.strictObject({
        opponentSeatNumber: SeatNumberSchema,
        currentEffectiveStack: SafeNonnegativeIntegerSchema,
        maximumAdditionalMatchedContribution: SafeNonnegativeIntegerSchema,
      }),
    ),
    isAllIn: z.boolean(),
    handEndsByFold: z.boolean(),
    forcesRunout: z.boolean(),
    remainingStreetsToDeal: SafeNonnegativeIntegerSchema,
    furtherBettingPossible: z.boolean(),
    showdownForced: z.boolean(),
    responders: z.array(SeatNumberSchema),
    canRaiseSeats: z.array(SeatNumberSchema),
    heroActionCompletes: z.literal(true),
    bettingRoundClosesImmediately: z.boolean(),
    canFaceFurtherAction: z.boolean(),
    legalSuccessorSpace: z.strictObject({
      nextActorSeatNumber: SeatNumberSchema.nullable(),
      possibleActionTypes: z.array(ActionTypeSchema),
      mayReturnToHero: z.boolean(),
    }),
    projectedFlopSpr: CandidateSprProjectionSchema,
    nextStreetSpr: CandidateSprProjectionSchema,
    minimumRequiredEquityForCall: CandidateThresholdFactSchema,
    pureBluffBreakEvenFoldRate: CandidateThresholdFactSchema,
    rangeConditionalEquity: UnavailableOutcomeFactSchema,
    opponentResponseProbability: UnavailableOutcomeFactSchema,
    expectedValue: UnavailableOutcomeFactSchema,
    futureStreetValue: UnavailableOutcomeFactSchema,
    impliedOdds: UnavailableOutcomeFactSchema,
    foldEquity: UnavailableOutcomeFactSchema,
  })

  return ActionOutcomeDataSchema
}
