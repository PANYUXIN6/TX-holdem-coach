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
  baselines: readonly {
    readonly actionId: string
    readonly action: PokerAction
  }[] = [],
): CoachActionOutcomes {
  assertCertifiedCoachDecisionInput(input)
  const outcomes: CoachActionOutcomes['outcomes'] = []
  const actions = [
    {
      action: input.decision.actualAction,
      reference: { kind: 'actual' as const, eventSeq: input.decision.eventSeq },
    },
    ...baselines.map((baseline) => ({
      action: baseline.action,
      reference: { kind: 'baseline' as const, actionId: baseline.actionId },
    })),
  ]
  if (
    new Set(baselines.map((baseline) => baseline.actionId)).size !==
    baselines.length
  )
    throw new TypeError('coach_duplicate_baseline_action')
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
