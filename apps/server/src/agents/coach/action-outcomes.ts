import { PokerActionSchema, type PokerAction } from '@tx-holdem-coach/contracts'
import { projectActionOutcome } from '../../poker/candidate-outcomes.js'
import { freezeCoachData } from './review-case.js'
import {
  assertCertifiedCoachDecisionInput,
  type CertifiedCoachDecisionInput,
} from './frozen-analysis.js'
import {
  CoachActionOutcomesSchema,
  type CoachActionOutcomes,
} from './analysis-results.js'
export { type CoachActionOutcomes } from './analysis-results.js'
const computedOutcomes = new WeakSet<object>()
export function assertComputedCoachActionOutcomes(
  value: CoachActionOutcomes,
): void {
  if (!computedOutcomes.has(value))
    throw new TypeError('coach_untrusted_outcomes')
}
export function computeCoachActionOutcomes(
  input: CertifiedCoachDecisionInput,
): CoachActionOutcomes {
  assertCertifiedCoachDecisionInput(input)
  const outcomes: CoachActionOutcomes['outcomes'] = []
  const actions = [
    {
      action: input.decision.actualAction,
      reference: { kind: 'actual' as const, eventSeq: input.decision.eventSeq },
    },
  ] as {
    action: PokerAction
    reference: { kind: 'actual'; eventSeq: number } | { kind: 'callComparison' }
  }[]
  const hero = input.decision.stacksAndContributions.find(
    (s) => s.seatNumber === input.decision.visibleState.heroSeat,
  )!
  const legalCall = input.decision.legalActions.some((a) => a.action === 'call')
  const callingAllIn =
    input.decision.legalActions.some((a) => a.action === 'allIn') &&
    hero.streetCommitment + hero.stack <=
      input.decision.analysisInput.bettingRound.currentBet
  if (legalCall || callingAllIn)
    actions.push({
      action: { type: legalCall ? 'call' : 'allIn' },
      reference: { kind: 'callComparison' },
    })
  for (const entry of actions) {
    const action = PokerActionSchema.parse(entry.action)
    const existing = outcomes.find(
      (outcome) => JSON.stringify(outcome.action) === JSON.stringify(action),
    )
    if (existing) existing.references.push(entry.reference)
    else
      outcomes.push({
        action,
        references: [entry.reference],
        result: projectActionOutcome({
          analysisInput: input.decision.analysisInput,
          action,
        }) as CoachActionOutcomes['outcomes'][number]['result'],
      })
  }
  const result = freezeCoachData(
    CoachActionOutcomesSchema.parse({
      binding: input.binding,
      decisionId: input.decision.decisionId,
      stateVersion: input.decision.stateVersion,
      asOfEventSeq: input.decision.opponentEvidenceCutoff.asOfEventSeq,
      outcomes,
    }),
  )
  computedOutcomes.add(result)
  return result
}
