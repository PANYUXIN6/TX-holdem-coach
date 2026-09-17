import { COACH_METRICS_VERSION } from './analysis-results.js'
import {
  CoachPublicFactSchema,
  type CoachPublicFact,
} from '@tx-holdem-coach/contracts'
import { CoreFactSourceRefSchema } from '../../poker/core-fact-source-schema.js'
import type { CoreFactSourceRef } from '../../poker/decision-analysis-types.js'
import type { CertifiedCoachDecisionInput } from './frozen-analysis.js'
import { assertCertifiedCoachDecisionInput } from './frozen-analysis.js'
import type { CoachDecisionMetrics } from './decision-metrics.js'
import { freezeCoachData } from './review-case.js'
import { isDeepStrictEqual } from 'node:util'

// Producer identity remains present in available, unavailable and notApplicable facts.
export const COACH_METRIC_FACT_ALGORITHM_VERSION = `${COACH_METRICS_VERSION.id}:${COACH_METRICS_VERSION.version}`

export function mapCoachMetricSource(
  input: CertifiedCoachDecisionInput,
  raw: CoreFactSourceRef,
) {
  const source = CoreFactSourceRefSchema.parse(raw)
  if (
    source.kind === 'analysisInputField' &&
    source.eventSeq !== null &&
    (source.eventSeq > input.decision.opponentEvidenceCutoff.asOfEventSeq ||
      !input.decision.analysisInput.publicActions.some(
        (action) => action.eventSeq === source.eventSeq,
      ))
  )
    throw new TypeError('coach_metric_source_cutoff')
  return {
    decisionId: input.decision.decisionId,
    asOfEventSeq: input.decision.opponentEvidenceCutoff.asOfEventSeq,
    source,
  }
}

/** Public projection is deliberately narrower than the server's typed metric tree. */
export function projectCoachDecisionFacts(
  input: CertifiedCoachDecisionInput,
  metrics: CoachDecisionMetrics,
): readonly CoachPublicFact[] {
  assertCertifiedCoachDecisionInput(input)
  if (
    !isDeepStrictEqual(input.binding, metrics.binding) ||
    input.decision.decisionId !== metrics.decisionId ||
    input.decision.stateVersion !== metrics.stateVersion ||
    input.decision.opponentEvidenceCutoff.asOfEventSeq !== metrics.asOfEventSeq
  )
    throw new TypeError('coach_metrics_binding')
  const publicSources = (sources: readonly CoreFactSourceRef[]) => {
    const refs = sources.map((raw) => {
      const { source } = mapCoachMetricSource(input, raw)
      if (source.kind === 'algorithm')
        return {
          kind: 'algorithm' as const,
          algorithmId: source.algorithmId,
          version: source.version,
        }
      if (source.kind === 'ruleSet')
        return {
          kind: 'rule' as const,
          pokerRuleSetVersion: source.pokerRuleSetVersion,
        }
      return {
        kind: 'event' as const,
        sessionId: input.binding.sessionId,
        handId: input.binding.handId,
        eventSeq: source.eventSeq ?? metrics.asOfEventSeq,
      }
    })
    return [...new Map(refs.map((ref) => [JSON.stringify(ref), ref])).values()]
  }
  const base = {
    scope: 'decision' as const,
    epistemicKind: 'formulaFact' as const,
    schemaVersion: 1 as const,
    algorithmVersion: COACH_METRIC_FACT_ALGORITHM_VERSION,
    dataVersion: null,
    asOfEventSeq: metrics.asOfEventSeq,
    assumptions: [] as string[],
  }
  const facts: CoachPublicFact[] = [
    CoachPublicFactSchema.parse({
      ...base,
      sourceRefs: publicSources(metrics.contestablePot.sourceRefs),
      factId: 'metrics.contestablePot',
      status: 'available',
      value: {
        kind: 'chips',
        metric: 'contestablePot',
        seatNumber: input.decision.visibleState.heroSeat,
        value: metrics.contestablePot.heroContestablePotBefore,
      },
    }),
  ]
  const odds = metrics.currentMetrics.potOdds
  if (odds.status === 'available') {
    const value = odds.value as { numerator: number; denominator: number }
    facts.push(
      CoachPublicFactSchema.parse({
        ...base,
        sourceRefs: publicSources(odds.sourceRefs),
        factId: 'metrics.potOdds',
        assumptions: [...odds.assumptionCodes],
        status: 'available',
        value: {
          kind: 'ratio',
          metric: 'potOdds',
          value: { numerator: value.numerator, denominator: value.denominator },
        },
      }),
    )
  } else
    facts.push(
      CoachPublicFactSchema.parse({
        ...base,
        sourceRefs: publicSources(odds.sourceRefs),
        factId: 'metrics.potOdds',
        status: 'notApplicable',
        kind: 'ratio',
        reasonCode: 'notApplicable',
      }),
    )
  return freezeCoachData(facts)
}
