import type { DecisionAnalysisInput } from '../poker/decision-analysis-input.js'
import type { NormalizedDecisionSpotData } from '../poker/decision-spot.js'
import type { RangeApplicability } from './opponent-range-pack.js'

export interface RangeMatchContext {
  readonly tableSize: RangeApplicability['tableSize']
  readonly opponentLogicalPosition: RangeApplicability['opponentLogicalPosition']
  readonly effectiveStackBb: number
  readonly preflopEntryMode: RangeApplicability['preflopEntryMode']
  readonly normalizedPreflopLine: RangeApplicability['normalizedPreflopLine']
  readonly participantTopology: RangeApplicability['participantTopology']
  readonly potType: RangeApplicability['potType']
  readonly street: RangeApplicability['street']
}
export function createRangeMatchContext(
  decision: DecisionAnalysisInput,
  spot: NormalizedDecisionSpotData,
  seatNumber: number,
): RangeMatchContext {
  const position = decision.positions.find(
    (entry) => entry.seatNumber === seatNumber,
  )?.position
  const effective = spot.effectiveStackBandsByOpponent.find(
    (entry) => entry.opponentSeatNumber === seatNumber,
  )
  if (!position || !effective)
    throw new TypeError('range_missing_opponent_context')
  const firstEntry = decision.publicActions.find(
    (entry) =>
      entry.actorSeatNumber === seatNumber &&
      entry.streetBefore === 'preflop' &&
      entry.isVoluntaryPreflopContribution,
  )
  return {
    tableSize: spot.tableSize,
    opponentLogicalPosition: position,
    effectiveStackBb: effective.effectiveStackChips / 20,
    preflopEntryMode: !firstEntry
      ? 'unentered'
      : firstEntry.currentBetAfter > firstEntry.currentBetBefore
        ? 'raise'
        : 'call',
    normalizedPreflopLine: decision.publicActions
      .filter((entry) => entry.streetBefore === 'preflop')
      .map((entry) => {
        const actorPosition = decision.positions.find(
          (seat) => seat.seatNumber === entry.actorSeatNumber,
        )?.position
        if (!actorPosition) throw new TypeError('range_missing_action_position')
        return { actorPosition, action: entry.action.type }
      }),
    participantTopology: {
      remainingSeatCount: spot.playerCounts.notFoldedCount,
      hasSidePot: spot.potType.hasSidePot,
    },
    potType: spot.potType.kind,
    street: decision.street,
  }
}
export function matchesRangeApplicability(
  applicability: RangeApplicability,
  context: RangeMatchContext,
): boolean {
  return (
    applicability.tableSize === context.tableSize &&
    applicability.opponentLogicalPosition === context.opponentLogicalPosition &&
    context.effectiveStackBb >= applicability.effectiveStackIntervalBb.min &&
    context.effectiveStackBb <= applicability.effectiveStackIntervalBb.max &&
    applicability.preflopEntryMode === context.preflopEntryMode &&
    applicability.street === context.street &&
    applicability.potType === context.potType &&
    applicability.participantTopology.remainingSeatCount ===
      context.participantTopology.remainingSeatCount &&
    applicability.participantTopology.hasSidePot ===
      context.participantTopology.hasSidePot &&
    applicability.normalizedPreflopLine.length ===
      context.normalizedPreflopLine.length &&
    applicability.normalizedPreflopLine.every(
      (entry, index) =>
        entry.actorPosition ===
          context.normalizedPreflopLine[index]?.actorPosition &&
        entry.action === context.normalizedPreflopLine[index]?.action,
    )
  )
}
