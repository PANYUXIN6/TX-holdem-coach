import type { LegalAction } from '@tx-holdem-coach/contracts'
import { projectContestablePot } from './contestable-pot.js'
import {
  createCandidateActionProof,
  createLegalCandidates,
} from './decision-candidates.js'
import {
  toBettingProjectionState,
  type DecisionAnalysisInput,
} from './decision-analysis-input.js'
import {
  createExactRatio,
  deepFreezeDecisionValue,
  type CoreFactSourceRef,
  type DerivedFact,
  type ExactRatio,
} from './decision-analysis-types.js'
import {
  getProjectedLegalActions,
  projectBettingTransition,
} from './betting-projection.js'

export interface DecisionMetricsData<TSourceRef> {
  readonly decisionMetricsSchemaVersion: 1
  readonly engineVersion: 1
  readonly sourceRefs: readonly TSourceRef[]
  readonly amounts: {
    readonly amountToCall: number
    readonly currentStreetContribution: number
    readonly currentTotalContribution: number
    readonly minimumBetOrRaiseTarget: number | null
    readonly maximumOrdinaryTarget: number | null
    readonly allInTarget: number | null
  }
  readonly potOdds: DerivedFact<ExactRatio, TSourceRef>
  readonly currentSpr: DerivedFact<
    {
      readonly byOpponent: readonly {
        readonly opponentSeatNumber: number
        readonly effectiveStack: number
        readonly spr: ExactRatio
      }[]
      readonly maximumOpponentEffectiveSpr: {
        readonly effectiveStack: number
        readonly spr: ExactRatio
      }
    },
    TSourceRef
  >
  readonly publicActionScales: readonly {
    readonly eventSeq: number
    readonly contributionDeltaToPotBefore: {
      readonly ratioKind: 'contributionDeltaToPotBefore'
      readonly value: ExactRatio
    }
    readonly targetStreetCommitmentToPotBefore:
      | {
          readonly status: 'available'
          readonly ratioKind: 'targetStreetCommitmentToPotBefore'
          readonly value: ExactRatio
        }
      | {
          readonly status: 'notApplicable'
          readonly reasonCode: 'noTarget'
        }
    readonly sourceRefs: readonly TSourceRef[]
  }[]
}

function inputSource(
  path: Extract<CoreFactSourceRef, { kind: 'analysisInputField' }>['path'],
): CoreFactSourceRef {
  return { kind: 'analysisInputField', path, eventSeq: null }
}

function metricSources(): readonly CoreFactSourceRef[] {
  return [
    inputSource('table.seats'),
    inputSource('hand.pot'),
    inputSource('hand.bettingRound'),
    inputSource('hand.legalActions'),
    {
      kind: 'algorithm',
      algorithmId: 'decisionMetricsEngine',
      version: 1,
    },
  ]
}

function ordinaryAggressiveAction(
  legalActions: DecisionAnalysisInput['legalActions'],
): Extract<LegalAction, { type: 'bet' | 'raise' }> | undefined {
  return legalActions.find(
    (action): action is Extract<LegalAction, { type: 'bet' | 'raise' }> =>
      action.type === 'bet' || action.type === 'raise',
  )
}

export function computeDecisionMetrics(
  input: DecisionAnalysisInput,
): DecisionMetricsData<CoreFactSourceRef> {
  const state = toBettingProjectionState(input)
  const hero = state.seats.find(
    (seat) => seat.seatNumber === input.heroSeatNumber,
  )
  if (hero === undefined || hero.status !== 'active' || hero.stack <= 0) {
    throw new RangeError('决策指标要求可行动的 Hero。')
  }

  const candidates = createLegalCandidates(state)
  if (
    JSON.stringify(input.legalActions) !==
    JSON.stringify(getProjectedLegalActions(state))
  ) {
    throw new RangeError('决策指标合法动作与当前下注状态不一致。')
  }
  const evidenceCandidate = candidates[0]
  if (evidenceCandidate === undefined) {
    throw new RangeError('决策指标缺少合法候选。')
  }
  const evidenceTransition = projectBettingTransition(
    state,
    createCandidateActionProof(state, evidenceCandidate),
  )
  const amountToCall = evidenceTransition.amountToCallBefore
  const ordinaryAction = ordinaryAggressiveAction(input.legalActions)
  const allInAction = input.legalActions.find(
    (action): action is Extract<LegalAction, { type: 'allIn' }> =>
      action.type === 'allIn',
  )
  const sources = metricSources()
  const contestablePot = projectContestablePot({
    heroSeatNumber: input.heroSeatNumber,
    pot: input.pot,
    seats: input.seats,
    sourceRefs: sources,
  })
  if (
    contestablePot.potBreakdown.length === 0 ||
    (input.street !== 'preflop' && contestablePot.heroContestablePotBefore <= 0)
  ) {
    throw new RangeError('当前底池或 Hero 可争夺底池无效。')
  }

  let potOdds: DecisionMetricsData<CoreFactSourceRef>['potOdds']
  if (amountToCall === 0) {
    potOdds = {
      status: 'notApplicable',
      reasonCode: 'noCallRequired',
      sourceRefs: sources,
      assumptionCodes: [],
    }
  } else {
    const callCandidate = candidates.find(
      (candidate) =>
        candidate.action.type === 'call' ||
        (candidate.action.type === 'allIn' &&
          candidate.targetStreetCommitment !== null &&
          candidate.targetStreetCommitment <= state.bettingRound.currentBet),
    )
    if (callCandidate === undefined) {
      throw new RangeError('面对下注时必须存在可证明的跟注候选。')
    }
    const callTransition = projectBettingTransition(
      state,
      createCandidateActionProof(state, callCandidate),
    )
    const afterCall = projectContestablePot({
      heroSeatNumber: input.heroSeatNumber,
      pot: callTransition.state.pot,
      seats: callTransition.state.seats,
      sourceRefs: sources,
    })
    if (afterCall.heroContestablePotBefore <= 0) {
      throw new RangeError('跟注后 Hero 必须有可争夺底池。')
    }
    potOdds = {
      status: 'available',
      value: createExactRatio(
        callTransition.contributionDelta,
        afterCall.heroContestablePotBefore,
      ),
      epistemicKind: 'formulaFact',
      sourceRefs: sources,
      assumptionCodes: ['ignoresFutureAction'],
    }
  }

  let currentSpr: DecisionMetricsData<CoreFactSourceRef>['currentSpr']
  if (input.street === 'preflop') {
    currentSpr = {
      status: 'notApplicable',
      reasonCode: 'preflopCurrentSprUndefined',
      sourceRefs: sources,
      assumptionCodes: [],
    }
  } else {
    const byOpponent = contestablePot.effectiveStacksByOpponent.map(
      (opponent) => ({
        opponentSeatNumber: opponent.opponentSeatNumber,
        effectiveStack: opponent.currentEffectiveStack,
        spr: createExactRatio(
          opponent.currentEffectiveStack,
          contestablePot.heroContestablePotBefore,
        ),
      }),
    )
    if (byOpponent.length === 0) {
      throw new RangeError('翻后 SPR 必须存在仍竞争的对手。')
    }
    const maximumEffectiveStack = Math.max(
      ...byOpponent.map((opponent) => opponent.effectiveStack),
    )
    currentSpr = {
      status: 'available',
      value: {
        byOpponent,
        maximumOpponentEffectiveSpr: {
          effectiveStack: maximumEffectiveStack,
          spr: createExactRatio(
            maximumEffectiveStack,
            contestablePot.heroContestablePotBefore,
          ),
        },
      },
      epistemicKind: 'formulaFact',
      sourceRefs: sources,
      assumptionCodes: [],
    }
  }

  return deepFreezeDecisionValue({
    decisionMetricsSchemaVersion: 1 as const,
    engineVersion: 1 as const,
    sourceRefs: [...sources],
    amounts: {
      amountToCall,
      currentStreetContribution: hero.streetContribution,
      currentTotalContribution: hero.totalContribution,
      minimumBetOrRaiseTarget: ordinaryAction?.minTarget ?? null,
      maximumOrdinaryTarget: ordinaryAction?.maxTarget ?? null,
      allInTarget: allInAction?.target ?? null,
    },
    potOdds,
    currentSpr,
    publicActionScales: input.publicActions.map((action) => {
      const actionSources: readonly CoreFactSourceRef[] = [
        {
          kind: 'analysisInputField',
          path: 'hand.publicActions',
          eventSeq: action.eventSeq,
        },
        {
          kind: 'algorithm',
          algorithmId: 'decisionMetricsEngine',
          version: 1,
        },
      ]
      return {
        eventSeq: action.eventSeq,
        contributionDeltaToPotBefore: {
          ratioKind: 'contributionDeltaToPotBefore' as const,
          value: createExactRatio(action.contributionDelta, action.potBefore),
        },
        targetStreetCommitmentToPotBefore:
          action.action.type === 'fold' || action.action.type === 'check'
            ? {
                status: 'notApplicable' as const,
                reasonCode: 'noTarget' as const,
              }
            : {
                status: 'available' as const,
                ratioKind: 'targetStreetCommitmentToPotBefore' as const,
                value: createExactRatio(
                  action.targetStreetCommitmentAfter,
                  action.potBefore,
                ),
              },
        sourceRefs: actionSources,
      }
    }),
  })
}
