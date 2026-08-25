import { describe, expect, test } from 'vitest'
import {
  applyExploitAdjustmentPolicyV1,
  applyPersonaDeviationPolicy,
  generateHeuristicCandidates,
} from '../../src/agents/player/player-decision-policies.js'

const candidates = [
  {
    candidateId: 'fold',
    action: { type: 'fold' as const },
    targetStreetCommitment: null,
    contributionDelta: 0,
  },
  {
    candidateId: 'call:20',
    action: { type: 'call' as const },
    targetStreetCommitment: 20,
    contributionDelta: 20,
  },
  {
    candidateId: 'raise:40',
    action: { type: 'raise' as const, targetStreetCommitment: 40 },
    targetStreetCommitment: 40,
    contributionDelta: 40,
  },
  {
    candidateId: 'raise:80',
    action: { type: 'raise' as const, targetStreetCommitment: 80 },
    targetStreetCommitment: 80,
    contributionDelta: 80,
  },
  {
    candidateId: 'allIn:2000',
    action: { type: 'allIn' as const },
    targetStreetCommitment: 2_000,
    contributionDelta: 2_000,
  },
]

describe('Player deterministic policies', () => {
  test('uses low-confidence family-balanced heuristic fallback', () => {
    const result = generateHeuristicCandidates({
      candidates,
      heroStackBefore: 2_000,
      unsupportedReasonCode: 'noAuthorizedCoverage',
    })

    expect(result.confidence).toBe('low')
    expect(
      result.candidates.map((candidate) => candidate.weightBasisPoints),
    ).toEqual([2_500, 2_500, 1_250, 1_250, 2_500])
    expect(result.candidates.at(-1)?.commitmentRiskBand).toBe('allIn')
  })

  test('keeps persona transfers conservative, closed and within both caps', () => {
    const baseline = generateHeuristicCandidates({
      candidates,
      heroStackBefore: 2_000,
      unsupportedReasonCode: 'noAuthorizedCoverage',
    }).candidates
    const adjusted = applyPersonaDeviationPolicy({
      personaPolicy: {
        tightness: 0,
        aggression: 100,
        bluffTendency: 100,
        pressureCallTendency: 100,
        riskPreference: 100,
      },
      candidates: baseline,
    })

    expect(
      adjusted.candidates.map((candidate) => candidate.candidateId),
    ).toEqual(candidates.map((candidate) => candidate.candidateId))
    expect(
      adjusted.candidates.reduce(
        (total, candidate) => total + candidate.weightBasisPoints,
        0,
      ),
    ).toBe(10_000)
    adjusted.candidates.forEach((candidate, index) => {
      expect(
        Math.abs(
          candidate.weightBasisPoints - baseline[index]!.weightBasisPoints,
        ),
      ).toBeLessThanOrEqual(2_000)
    })
    expect(adjusted.adjustments).toContainEqual(
      expect.objectContaining({
        ruleId: 'bluffTendency',
        status: 'notApplicable',
        reasonCode: 'noRangeBasedBluffClassification',
      }),
    )
  })

  test('v1 exploit adjustment is always exactly zero', () => {
    const weighted = generateHeuristicCandidates({
      candidates,
      heroStackBefore: 2_000,
      unsupportedReasonCode: 'noAuthorizedCoverage',
    }).candidates
    const result = applyExploitAdjustmentPolicyV1({
      evidenceId: 'evidence-1',
      asOfEventSeq: 4,
      candidates: weighted,
    })

    expect(result.status).toBe('insufficientEvidence')
    expect(result.candidates).toEqual(weighted)
  })
})
