import { z } from 'zod'
import type { AuditVersionReference } from '../audit/audit-primitives.js'
import { CoachVersionsSchema, freezeCoachData } from './review-case.js'

export const COACH_POLICY_DEPENDENCY_IDS = Object.freeze({
  metrics: 'coach.review.metrics',
  rangeModel: 'coach.review.range-model',
  equityComputation: 'coach.review.equity-computation',
  settlement: 'coach.review.settlement-projection',
  opponentEvidence: 'coach.review.opponent-evidence',
  classifier: 'coach.review.classifier',
  conclusion: 'coach.review.conditional-conclusion-policy',
  severity: 'coach.review.severity-policy',
  teaching: 'coach.review.teaching-policy',
} as const)
export type CoachPolicyVersions = z.infer<typeof CoachVersionsSchema>

/** Callers supply versions of actually installed producers; no current-version defaults. */
export function writeCoachPolicyDependencies(
  producers: CoachPolicyVersions,
): readonly AuditVersionReference[] {
  const parsed = CoachVersionsSchema.parse(producers)
  return freezeCoachData(
    Object.entries(COACH_POLICY_DEPENDENCY_IDS).map(([role, id]) => {
      const reference = parsed[role as keyof CoachPolicyVersions]
      if (reference.id !== id)
        throw new TypeError('coach_policy_identity_mismatch')
      return { id, version: reference.version }
    }),
  )
}

export function readCoachPolicyVersions(
  dependencies: readonly AuditVersionReference[],
  supported: CoachPolicyVersions,
): CoachPolicyVersions {
  const expected = writeCoachPolicyDependencies(supported)
  const entries = Object.entries(COACH_POLICY_DEPENDENCY_IDS).map(
    ([role, id], index) => {
      const matches = dependencies.filter((reference) => reference.id === id)
      if (
        matches.length !== 1 ||
        matches[0]!.version !== expected[index]!.version
      )
        throw new TypeError('coach_policy_version_unsupported')
      return [role, { id, version: matches[0]!.version }]
    },
  )
  return freezeCoachData(CoachVersionsSchema.parse(Object.fromEntries(entries)))
}
