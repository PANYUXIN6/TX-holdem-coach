import { buildDecisionAnalysisCore } from '../../poker/decision-analysis-core.js'
import {
  createExactRatio,
  type CoreFactSourceRef,
} from '../../poker/decision-analysis-types.js'
import { projectContestablePot } from '../../poker/contestable-pot.js'
import { freezeCoachData } from './review-case.js'
import {
  assertCertifiedCoachDecisionInput,
  type CertifiedCoachDecisionInput,
} from './frozen-analysis.js'
import { mapCoachMetricSource } from './decision-fact-projector.js'
import {
  CoachDecisionMetricsSchema,
  COACH_METRICS_VERSION,
  type CoachDecisionMetrics,
} from './analysis-results.js'
export {
  COACH_METRICS_VERSION,
  type CoachDecisionMetrics,
} from './analysis-results.js'
const computedMetrics = new WeakSet<object>()
export function assertComputedCoachMetrics(value: CoachDecisionMetrics): void {
  if (!computedMetrics.has(value))
    throw new TypeError('coach_untrusted_metrics')
}
export function computeCoachDecisionMetrics(
  input: CertifiedCoachDecisionInput,
): CoachDecisionMetrics {
  assertCertifiedCoachDecisionInput(input)
  if (
    input.binding.versions.metrics.id !== COACH_METRICS_VERSION.id ||
    input.binding.versions.metrics.version !== COACH_METRICS_VERSION.version
  )
    throw new TypeError('coach_metrics_version_unsupported')
  const result = buildDecisionAnalysisCore(input.decision.analysisInput)
  const start = input.decision.streetStartState
  const pot =
    start.status === 'available'
      ? projectContestablePot({
          heroSeatNumber: input.decision.analysisInput.heroSeatNumber,
          pot: start.pot,
          seats: start.seats,
          sourceRefs: [],
        })
      : null
  const factManifest: CoachDecisionMetrics['factManifest'] = []
  const visit = (
    value: unknown,
    path: string,
    inherited: readonly CoreFactSourceRef[] = [],
  ) => {
    if (value === null || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    const sources = Array.isArray(record.sourceRefs)
      ? (record.sourceRefs as CoreFactSourceRef[])
      : inherited
    if (
      'status' in record &&
      ['available', 'unavailable', 'notApplicable'].includes(
        String(record.status),
      )
    ) {
      factManifest.push({
        factId: `metrics.${path}`,
        valuePath: path,
        status: record.status as 'available' | 'unavailable' | 'notApplicable',
        epistemicKind: (record.epistemicKind ??
          (path.startsWith('handFeatures')
            ? 'ruleFact'
            : 'formulaFact')) as CoachDecisionMetrics['factManifest'][number]['epistemicKind'],
        sourceRefs: sources.map((source) =>
          mapCoachMetricSource(input, source),
        ),
        assumptionCodes: Array.isArray(record.assumptionCodes)
          ? (record.assumptionCodes as string[])
          : [],
        reasonCode:
          typeof record.reasonCode === 'string' ? record.reasonCode : null,
      })
    }
    for (const [key, nested] of Object.entries(record))
      if (key !== 'sourceRefs') visit(nested, `${path}.${key}`, sources)
  }
  for (const key of [
    'normalizedSpot',
    'handFeatures',
    'contestablePot',
    'currentMetrics',
  ] as const)
    visit(result[key], key)
  const streetStartMetrics: CoachDecisionMetrics['streetStartMetrics'] =
    start.status === 'available' && pot
      ? {
          status: 'available',
          eventSeq: start.eventSeq,
          heroContestablePot: pot.heroContestablePotBefore,
          byOpponent: pot.effectiveStacksByOpponent.map((opponent) => ({
            opponentSeatNumber: opponent.opponentSeatNumber,
            effectiveStack: opponent.currentEffectiveStack,
            spr: createExactRatio(
              opponent.currentEffectiveStack,
              pot.heroContestablePotBefore,
            ),
          })),
        }
      : { status: 'notApplicable', reasonCode: 'preflop' }
  factManifest.push({
    factId: 'metrics.streetStartMetrics',
    valuePath: 'streetStartMetrics',
    status: streetStartMetrics.status,
    epistemicKind: 'formulaFact',
    sourceRefs:
      start.status === 'available'
        ? [
            {
              decisionId: input.decision.decisionId,
              asOfEventSeq: input.decision.opponentEvidenceCutoff.asOfEventSeq,
              source: {
                kind: 'streetStartState',
                eventSeq: start.eventSeq,
                fields: ['seats', 'pot'],
              },
            },
          ]
        : [
            mapCoachMetricSource(input, {
              kind: 'analysisInputField',
              path: 'hand.street',
              eventSeq: null,
            }),
          ],
    assumptionCodes: [],
    reasonCode:
      streetStartMetrics.status === 'notApplicable'
        ? streetStartMetrics.reasonCode
        : null,
  })
  const metrics = freezeCoachData(
    CoachDecisionMetricsSchema.parse({
      binding: input.binding,
      decisionId: input.decision.decisionId,
      stateVersion: input.decision.stateVersion,
      asOfEventSeq: input.decision.opponentEvidenceCutoff.asOfEventSeq,
      normalizedSpot: result.normalizedSpot,
      handFeatures: result.handFeatures,
      contestablePot: result.contestablePot,
      currentMetrics: result.currentMetrics,
      streetStartMetrics,
      factManifest,
      algorithmVersions: {
        spotSchema: result.normalizedSpot.spotSchemaVersion,
        normalizer: result.normalizedSpot.normalizerVersion,
        handFeatureSchema: result.handFeatures.handFeatureSchemaVersion,
        handFeatureAnalyzer: result.handFeatures.analyzerVersion,
        potSchema: result.contestablePot.contestablePotSchemaVersion,
        potProjector: result.contestablePot.projectorVersion,
        metricsSchema: result.currentMetrics.decisionMetricsSchemaVersion,
        metricsEngine: result.currentMetrics.engineVersion,
        actionOutcomeSchema: 1,
        actionOutcomeProjector: 1,
        coachAdapter: 1,
        streetStart: 1,
      },
    }),
  )
  computedMetrics.add(metrics)
  return metrics
}
