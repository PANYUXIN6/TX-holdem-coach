import type { PokerCommand } from '../../poker/commands.js'
import type { PlayerPersonaPolicy } from './player-decision-reference.js'

export interface PolicyCandidate {
  readonly candidateId: string
  readonly action: PokerCommand['action']
  readonly targetStreetCommitment: number | null
  readonly contributionDelta: number
}

export interface WeightedPolicyCandidate extends PolicyCandidate {
  readonly weightBasisPoints: number
  readonly commitmentRiskBand?: 'zero' | 'low' | 'medium' | 'high' | 'allIn'
}

export interface HeuristicCandidateResult {
  readonly heuristicCandidatePolicyVersion: 1
  readonly confidence: 'low'
  readonly reasonCode: 'legalFallbackCandidate'
  readonly unsupportedReasonCode: 'noAuthorizedCoverage'
  readonly candidates: readonly (WeightedPolicyCandidate & {
    readonly commitmentRiskBand: 'zero' | 'low' | 'medium' | 'high' | 'allIn'
  })[]
}

export interface PersonaAdjustmentResult {
  readonly personaDeviationPolicyVersion: 1
  readonly candidates: readonly WeightedPolicyCandidate[]
  readonly adjustments: readonly {
    readonly ruleId: string
    readonly fromCandidateId: string | null
    readonly toCandidateId: string | null
    readonly transferredBasisPoints: number
    readonly status: 'applied' | 'notApplicable'
    readonly reasonCode: string
  }[]
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

function distribute(total: number, count: number): readonly number[] {
  if (count <= 0) return []
  const base = Math.floor(total / count)
  const remainder = total % count
  return Array.from(
    { length: count },
    (_, index) => base + (index < remainder ? 1 : 0),
  )
}

function riskBand(
  candidate: PolicyCandidate,
  heroStackBefore: number,
): 'zero' | 'low' | 'medium' | 'high' | 'allIn' {
  if (candidate.action.type === 'allIn') return 'allIn'
  if (candidate.contributionDelta === 0) return 'zero'
  const ratio = Math.floor(
    (candidate.contributionDelta * 10_000) / heroStackBefore,
  )
  if (ratio <= 2_500) return 'low'
  if (ratio <= 5_000) return 'medium'
  return 'high'
}

export function generateHeuristicCandidates(input: {
  readonly candidates: readonly PolicyCandidate[]
  readonly heroStackBefore: number
  readonly unsupportedReasonCode: 'noAuthorizedCoverage'
}): HeuristicCandidateResult {
  if (
    input.candidates.length === 0 ||
    !Number.isSafeInteger(input.heroStackBefore) ||
    input.heroStackBefore <= 0 ||
    new Set(input.candidates.map((candidate) => candidate.candidateId)).size !==
      input.candidates.length
  ) {
    throw new RangeError('Heuristic 候选输入无效。')
  }
  const familyOrder: PokerCommand['action']['type'][] = []
  const byFamily = new Map<PokerCommand['action']['type'], PolicyCandidate[]>()
  for (const candidate of input.candidates) {
    const family = candidate.action.type
    const entries = byFamily.get(family)
    if (entries === undefined) {
      familyOrder.push(family)
      byFamily.set(family, [candidate])
    } else {
      entries.push(candidate)
    }
  }
  const familyWeights = distribute(10_000, familyOrder.length)
  const weightById = new Map<string, number>()
  familyOrder.forEach((family, familyIndex) => {
    const entries = byFamily.get(family)!
    const entryWeights = distribute(familyWeights[familyIndex]!, entries.length)
    entries.forEach((entry, entryIndex) => {
      weightById.set(entry.candidateId, entryWeights[entryIndex]!)
    })
  })
  return deepFreeze({
    heuristicCandidatePolicyVersion: 1,
    confidence: 'low',
    reasonCode: 'legalFallbackCandidate',
    unsupportedReasonCode: input.unsupportedReasonCode,
    candidates: input.candidates.map((candidate) => ({
      ...candidate,
      weightBasisPoints: weightById.get(candidate.candidateId)!,
      commitmentRiskBand: riskBand(candidate, input.heroStackBefore),
    })),
  })
}

function centeredTransfer(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new RangeError('人物政策维度必须是 0 到 100 的整数。')
  }
  return Math.floor((Math.abs(value - 50) * 1_000) / 50)
}

export function applyPersonaDeviationPolicy(input: {
  readonly personaPolicy: PlayerPersonaPolicy
  readonly candidates: readonly WeightedPolicyCandidate[]
}): PersonaAdjustmentResult {
  if (
    input.candidates.length === 0 ||
    input.candidates.reduce(
      (total, candidate) => total + candidate.weightBasisPoints,
      0,
    ) !== 10_000
  ) {
    throw new RangeError('人物政策输入权重必须精确闭合。')
  }
  const weights = new Map(
    input.candidates.map((candidate) => [
      candidate.candidateId,
      candidate.weightBasisPoints,
    ]),
  )
  const baseline = new Map(weights)
  const adjustments: PersonaAdjustmentResult['adjustments'][number][] = []
  const candidatesOf = (types: readonly PokerCommand['action']['type'][]) =>
    input.candidates.filter((candidate) =>
      types.includes(candidate.action.type),
    )

  const transfer = (
    ruleId: string,
    sources: readonly WeightedPolicyCandidate[],
    targets: readonly WeightedPolicyCandidate[],
    requested: number,
  ) => {
    if (sources.length === 0 || targets.length === 0 || requested <= 0) {
      adjustments.push({
        ruleId,
        fromCandidateId: null,
        toCandidateId: null,
        transferredBasisPoints: 0,
        status: 'notApplicable',
        reasonCode: 'requiredCandidateFamilyMissing',
      })
      return
    }
    let remaining = Math.min(1_000, requested)
    for (const source of sources) {
      if (remaining <= 0) break
      const current = weights.get(source.candidateId)!
      const original = baseline.get(source.candidateId)!
      const sourceCap = Math.max(0, current - Math.max(0, original - 2_000))
      const movedFromSource = Math.min(current, sourceCap, remaining)
      if (movedFromSource <= 0) continue
      const targetShares = distribute(movedFromSource, targets.length)
      let actuallyMoved = 0
      targets.forEach((target, index) => {
        const targetCurrent = weights.get(target.candidateId)!
        const targetOriginal = baseline.get(target.candidateId)!
        const targetCap = Math.max(0, targetOriginal + 2_000 - targetCurrent)
        const amount = Math.min(targetShares[index]!, targetCap)
        if (amount > 0) {
          weights.set(target.candidateId, targetCurrent + amount)
          actuallyMoved += amount
          adjustments.push({
            ruleId,
            fromCandidateId: source.candidateId,
            toCandidateId: target.candidateId,
            transferredBasisPoints: amount,
            status: 'applied',
            reasonCode: 'boundedPersonaTransfer',
          })
        }
      })
      weights.set(source.candidateId, current - actuallyMoved)
      remaining -= actuallyMoved
    }
    if (remaining === requested || adjustments.at(-1)?.ruleId !== ruleId) {
      adjustments.push({
        ruleId,
        fromCandidateId: null,
        toCandidateId: null,
        transferredBasisPoints: 0,
        status: 'notApplicable',
        reasonCode: 'candidateCapReached',
      })
    }
  }

  const fold = candidatesOf(['fold'])
  const call = candidatesOf(['call'])
  const check = candidatesOf(['check'])
  const bet = candidatesOf(['bet'])
  const raise = candidatesOf(['raise'])
  const continueCandidates = candidatesOf([
    'check',
    'call',
    'bet',
    'raise',
    'allIn',
  ])

  const tightnessAmount = centeredTransfer(input.personaPolicy.tightness)
  if (input.personaPolicy.tightness >= 50) {
    transfer('tightness', continueCandidates, fold, tightnessAmount)
  } else {
    transfer('tightness', fold, continueCandidates, tightnessAmount)
  }
  const pressureAmount = centeredTransfer(
    input.personaPolicy.pressureCallTendency,
  )
  if (input.personaPolicy.pressureCallTendency >= 50) {
    transfer('pressureCall', fold, call, pressureAmount)
  } else {
    transfer('pressureCall', call, fold, pressureAmount)
  }
  const aggressionAmount = centeredTransfer(input.personaPolicy.aggression)
  if (input.personaPolicy.aggression >= 50) {
    if (check.length > 0)
      transfer('aggressionCheckBet', check, bet, aggressionAmount)
    else transfer('aggressionCallRaise', call, raise, aggressionAmount)
  } else {
    if (bet.length > 0)
      transfer('aggressionCheckBet', bet, check, aggressionAmount)
    else transfer('aggressionCallRaise', raise, call, aggressionAmount)
  }
  const aggressive = candidatesOf(['bet', 'raise']).sort(
    (left, right) =>
      (left.targetStreetCommitment ?? 0) - (right.targetStreetCommitment ?? 0),
  )
  const riskAmount = centeredTransfer(input.personaPolicy.riskPreference)
  const small = aggressive.length > 1 ? [aggressive[0]!] : []
  const large = aggressive.length > 1 ? [aggressive.at(-1)!] : []
  if (input.personaPolicy.riskPreference >= 50) {
    transfer('riskPreference', small, large, riskAmount)
  } else {
    transfer('riskPreference', large, small, riskAmount)
  }
  adjustments.push({
    ruleId: 'bluffTendency',
    fromCandidateId: null,
    toCandidateId: null,
    transferredBasisPoints: 0,
    status: 'notApplicable',
    reasonCode: 'noRangeBasedBluffClassification',
  })

  const candidates = input.candidates.map((candidate) => ({
    ...candidate,
    weightBasisPoints: weights.get(candidate.candidateId)!,
  }))
  if (
    candidates.reduce(
      (total, candidate) => total + candidate.weightBasisPoints,
      0,
    ) !== 10_000 ||
    candidates.some(
      (candidate) =>
        Math.abs(
          candidate.weightBasisPoints - baseline.get(candidate.candidateId)!,
        ) > 2_000,
    )
  ) {
    throw new RangeError('人物政策违反权重守恒或单候选累计上限。')
  }
  return deepFreeze({
    personaDeviationPolicyVersion: 1,
    candidates,
    adjustments,
  })
}

export function applyExploitAdjustmentPolicyV1(input: {
  readonly evidenceId: string
  readonly asOfEventSeq: number
  readonly candidates: readonly WeightedPolicyCandidate[]
}) {
  return deepFreeze({
    exploitAdjustmentPolicyVersion: 1 as const,
    evidenceId: input.evidenceId,
    asOfEventSeq: input.asOfEventSeq,
    status: 'insufficientEvidence' as const,
    // M4.9 已把跨手统计纳入 evidence；v1 仍没有获准将统计转换为权重偏移的
    // exploit baseline，因此保持零偏移并明确该边界。
    reasonCode: 'noApprovedExploitBaseline' as const,
    candidates: input.candidates.map((candidate) => ({ ...candidate })),
  })
}
