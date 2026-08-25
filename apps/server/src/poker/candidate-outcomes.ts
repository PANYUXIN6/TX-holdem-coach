import type { PokerCommand } from './commands.js'
import { projectContestablePot } from './contestable-pot.js'
import {
  createCandidateActionProof,
  createLegalCandidates,
  type LegalCandidate,
  type LegalCandidateId,
  type LegalCandidateTargetKind,
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
  projectActionContinuation,
  projectBettingTransition,
  type BettingProjectionState,
  type BettingTransitionProjection,
} from './betting-projection.js'

export interface LegalCandidateCatalogEntry {
  readonly candidateSchemaVersion: 1
  readonly candidateId: LegalCandidateId
  readonly action: PokerCommand['action']
  readonly targetStreetCommitment: number | null
  readonly targetKind: LegalCandidateTargetKind
}

export type CandidateSprProjection<TSourceRef> =
  | {
      readonly status: 'available'
      readonly value: readonly {
        readonly opponentSeatNumber: number
        readonly effectiveStack: number
        readonly spr: ExactRatio
      }[]
      readonly sourceRefs: readonly TSourceRef[]
    }
  | {
      readonly status: 'notApplicable'
      readonly reasonCode:
        | 'forcedRunout'
        | 'bettingRoundRemainsOpen'
        | 'handComplete'
        | 'wrongStreet'
        | 'noFutureDecisionStreet'
      readonly sourceRefs: readonly TSourceRef[]
    }

export type CandidateThresholdFact<TSourceRef> =
  | {
      readonly status: 'available'
      readonly value: ExactRatio
      readonly epistemicKind: 'formulaFact'
      readonly sourceRefs: readonly TSourceRef[]
      readonly assumptionCodes: readonly ['ignoresFutureAction']
    }
  | {
      readonly status: 'unavailable'
      readonly reasonCode: 'noJointResponseModel'
      readonly sourceRefs: readonly TSourceRef[]
      readonly assumptionCodes: readonly ['noJointResponseModel']
    }
  | {
      readonly status: 'notApplicable'
      readonly reasonCode: 'notCallingAction' | 'notPureBluffCandidate'
      readonly sourceRefs: readonly TSourceRef[]
      readonly assumptionCodes: readonly []
    }

export interface CandidateOutcomeData<TSourceRef> {
  readonly candidateOutcomeSchemaVersion: 1
  readonly projectorVersion: 1
  readonly sourceRefs: readonly TSourceRef[]
  readonly candidate: LegalCandidateCatalogEntry
  readonly amountToCall: number
  readonly contributionDelta: number
  readonly targetStreetCommitment:
    | { readonly status: 'available'; readonly value: number }
    | { readonly status: 'notApplicable'; readonly reasonCode: 'noTarget' }
  readonly streetContributionAfter: number
  readonly totalContributionAfter: number
  readonly guaranteedUncalledReturn: number
  readonly amountActuallyAtRisk: number
  readonly contestableAmountAdded: number
  readonly potAfterAction: number
  readonly heroContestablePotAfterAction: number
  readonly marginalContestablePot: {
    readonly amountActuallyAtRisk: number
    readonly contestableAmountAdded: number
  }
  readonly actionScale: {
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
  }
  readonly heroStackAfterAction: number
  readonly effectiveStacksByOpponentAfterAction: readonly {
    readonly opponentSeatNumber: number
    readonly currentEffectiveStack: number
    readonly maximumAdditionalMatchedContribution: number
  }[]
  readonly isAllIn: boolean
  readonly handEndsByFold: boolean
  readonly forcesRunout: boolean
  readonly remainingStreetsToDeal: number
  readonly furtherBettingPossible: boolean
  readonly showdownForced: boolean
  readonly responders: readonly number[]
  readonly canRaiseSeats: readonly number[]
  readonly heroActionCompletes: true
  readonly bettingRoundClosesImmediately: boolean
  readonly canFaceFurtherAction: boolean
  readonly legalSuccessorSpace: {
    readonly nextActorSeatNumber: number | null
    readonly possibleActionTypes: readonly PokerCommand['action']['type'][]
    readonly mayReturnToHero: boolean
  }
  readonly projectedFlopSpr: CandidateSprProjection<TSourceRef>
  readonly nextStreetSpr: CandidateSprProjection<TSourceRef>
  readonly minimumRequiredEquityForCall: CandidateThresholdFact<TSourceRef>
  readonly pureBluffBreakEvenFoldRate: CandidateThresholdFact<TSourceRef>
  readonly rangeConditionalEquity: DerivedFact<never, TSourceRef>
  readonly opponentResponseProbability: DerivedFact<never, TSourceRef>
  readonly expectedValue: DerivedFact<never, TSourceRef>
  readonly futureStreetValue: DerivedFact<never, TSourceRef>
  readonly impliedOdds: DerivedFact<never, TSourceRef>
  readonly foldEquity: DerivedFact<never, TSourceRef>
}

function outcomeSources(): readonly CoreFactSourceRef[] {
  return [
    { kind: 'analysisInputField', path: 'table.seats', eventSeq: null },
    { kind: 'analysisInputField', path: 'hand.pot', eventSeq: null },
    { kind: 'analysisInputField', path: 'hand.bettingRound', eventSeq: null },
    { kind: 'analysisInputField', path: 'hand.legalActions', eventSeq: null },
    {
      kind: 'algorithm',
      algorithmId: 'candidateOutcomeProjector',
      version: 1,
    },
  ]
}

function exactKeys(value: unknown, expected: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  const keys = Reflect.ownKeys(value)
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== expected.length ||
    keys.some((key) => typeof key !== 'string') ||
    keys.map(String).sort().join('|') !== [...expected].sort().join('|')
  ) {
    return false
  }
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return (
      descriptor !== undefined &&
      descriptor.enumerable &&
      'value' in descriptor &&
      descriptor.value !== undefined
    )
  })
}

function catalogShape(candidate: LegalCandidateCatalogEntry): unknown {
  return {
    candidateSchemaVersion: candidate.candidateSchemaVersion,
    candidateId: candidate.candidateId,
    action: { ...candidate.action },
    targetStreetCommitment: candidate.targetStreetCommitment,
    targetKind: candidate.targetKind,
  }
}

function assertCandidateEntryShape(value: unknown): void {
  if (
    !exactKeys(value, [
      'candidateSchemaVersion',
      'candidateId',
      'action',
      'targetStreetCommitment',
      'targetKind',
    ])
  ) {
    throw new RangeError('候选目录必须是精确 JSON 契约。')
  }
  const candidate = value as LegalCandidateCatalogEntry
  const expectedActionKeys =
    candidate.action?.type === 'bet' || candidate.action?.type === 'raise'
      ? ['type', 'targetStreetCommitment']
      : ['type']
  if (!exactKeys(candidate.action, expectedActionKeys)) {
    throw new RangeError('候选动作必须是精确 JSON 契约。')
  }
}

function assertCatalogMatches(
  catalog: readonly LegalCandidateCatalogEntry[],
  freshCandidates: readonly LegalCandidate[],
): void {
  if (
    !Array.isArray(catalog) ||
    Object.keys(catalog).length !== catalog.length ||
    Reflect.ownKeys(catalog).length !== catalog.length + 1 ||
    Reflect.ownKeys(catalog).some((key) => typeof key !== 'string')
  ) {
    throw new RangeError('候选目录必须是稠密 JSON 数组。')
  }
  for (const candidate of catalog) assertCandidateEntryShape(candidate)
  const catalogIds = catalog.map((candidate) => candidate.candidateId)
  const freshIds = freshCandidates.map((candidate) => candidate.candidateId)
  if (
    catalog.length !== freshCandidates.length ||
    new Set(catalogIds).size !== catalogIds.length ||
    new Set(freshIds).size !== freshIds.length ||
    catalogIds.some((id, index) => id !== freshIds[index]) ||
    freshIds.some((id) => !catalogIds.includes(id)) ||
    catalogIds.some((id) => !freshIds.includes(id)) ||
    catalog.some(
      (candidate, index) =>
        JSON.stringify(catalogShape(candidate)) !==
        JSON.stringify(catalogShape(freshCandidates[index]!)),
    )
  ) {
    throw new RangeError('候选目录与当前合法候选不一致。')
  }
}

function guaranteedUncalledReturn(
  transition: BettingTransitionProjection,
): number {
  const hero = transition.state.seats.find(
    (seat) => seat.seatNumber === transition.actorSeatNumber,
  )
  if (hero === undefined) throw new RangeError('候选结果缺少 Hero。')
  const participants = new Set(transition.state.participantSeatNumbers)
  const maximumOtherReach = Math.max(
    0,
    ...transition.state.seats
      .filter(
        (seat) =>
          participants.has(seat.seatNumber) &&
          seat.seatNumber !== hero.seatNumber,
      )
      .map((seat) => {
        const maximumReach =
          seat.status === 'active'
            ? seat.totalContribution + seat.stack
            : seat.totalContribution
        if (!Number.isSafeInteger(maximumReach)) {
          throw new RangeError('对手最大可匹配投入超出安全整数范围。')
        }
        return maximumReach
      }),
  )
  const unmatched = Math.max(0, hero.totalContribution - maximumOtherReach)
  return Math.min(transition.contributionDelta, unmatched)
}

function riskAdjustedState(
  transition: BettingTransitionProjection,
  guaranteedReturn: number,
): BettingProjectionState {
  if (guaranteedReturn === 0) return transition.state
  return {
    ...transition.state,
    pot: transition.state.pot - guaranteedReturn,
    seats: transition.state.seats.map((seat) =>
      seat.seatNumber === transition.actorSeatNumber
        ? {
            ...seat,
            stack: seat.stack + guaranteedReturn,
            status: seat.status === 'allIn' ? ('active' as const) : seat.status,
            streetContribution: seat.streetContribution - guaranteedReturn,
            totalContribution: seat.totalContribution - guaranteedReturn,
          }
        : { ...seat },
    ),
  }
}

function projectedSpr(
  status: 'available' | 'notApplicable',
  reasonCode:
    | 'forcedRunout'
    | 'bettingRoundRemainsOpen'
    | 'handComplete'
    | 'wrongStreet'
    | 'noFutureDecisionStreet',
  contestablePot: ReturnType<typeof projectContestablePot<CoreFactSourceRef>>,
  sources: readonly CoreFactSourceRef[],
): CandidateSprProjection<CoreFactSourceRef> {
  if (status === 'notApplicable') {
    return { status, reasonCode, sourceRefs: sources }
  }
  if (contestablePot.heroContestablePotBefore <= 0) {
    throw new RangeError('下一街 SPR 缺少可争夺底池。')
  }
  return {
    status,
    value: contestablePot.effectiveStacksByOpponent.map((opponent) => ({
      opponentSeatNumber: opponent.opponentSeatNumber,
      effectiveStack: opponent.currentEffectiveStack,
      spr: createExactRatio(
        opponent.currentEffectiveStack,
        contestablePot.heroContestablePotBefore,
      ),
    })),
    sourceRefs: sources,
  }
}

export function projectCandidateOutcomes(input: {
  readonly analysisInput: DecisionAnalysisInput
  readonly candidateCatalog: readonly LegalCandidateCatalogEntry[]
}): readonly CandidateOutcomeData<CoreFactSourceRef>[] {
  const state = toBettingProjectionState(input.analysisInput)
  if (
    JSON.stringify(input.analysisInput.legalActions) !==
    JSON.stringify(getProjectedLegalActions(state))
  ) {
    throw new RangeError('候选结果合法动作与当前下注状态不一致。')
  }
  const freshCandidates = createLegalCandidates(state)
  assertCatalogMatches(input.candidateCatalog, freshCandidates)
  const sources = outcomeSources()
  const before = projectContestablePot({
    heroSeatNumber: input.analysisInput.heroSeatNumber,
    pot: input.analysisInput.pot,
    seats: input.analysisInput.seats,
    sourceRefs: sources,
  })

  return deepFreezeDecisionValue(
    freshCandidates.map((freshCandidate) => {
      const transition = projectBettingTransition(
        state,
        createCandidateActionProof(state, freshCandidate),
      )
      const continuation = projectActionContinuation(
        transition.state,
        transition.actorSeatNumber,
      )
      const guaranteedReturn = guaranteedUncalledReturn(transition)
      const amountActuallyAtRisk =
        transition.contributionDelta - guaranteedReturn
      const adjustedState = riskAdjustedState(transition, guaranteedReturn)
      const heroAfter = transition.state.seats.find(
        (seat) => seat.seatNumber === transition.actorSeatNumber,
      )
      if (heroAfter === undefined) throw new RangeError('候选结果缺少 Hero。')
      const heroFolded = heroAfter.status === 'folded'
      const after = heroFolded
        ? null
        : projectContestablePot({
            heroSeatNumber: transition.actorSeatNumber,
            pot: adjustedState.pot,
            seats: adjustedState.seats,
            sourceRefs: sources,
          })
      const heroContestablePotAfterAction = after?.heroContestablePotBefore ?? 0
      const contestableAmountAdded =
        heroContestablePotAfterAction - before.heroContestablePotBefore
      const topology = {
        responders: continuation.responderSeatNumbers,
        canRaiseSeats: continuation.canRaiseSeatNumbers,
      }
      const nextState =
        continuation.kind === 'sameStreet' || continuation.kind === 'nextStreet'
          ? continuation.state
          : null
      const possibleActionTypes =
        nextState === null
          ? []
          : [
              ...new Set(
                getProjectedLegalActions(nextState).map(
                  (action) => action.type,
                ),
              ),
            ]
      const forcesRunout = continuation.forcesRunout
      const canFaceFurtherAction =
        heroAfter.status === 'active' &&
        heroAfter.stack > 0 &&
        topology.canRaiseSeats.length > 0
      const nextStreetContestable = after ?? before
      const projectedFlopSpr =
        input.analysisInput.street !== 'preflop'
          ? projectedSpr(
              'notApplicable',
              'wrongStreet',
              nextStreetContestable,
              sources,
            )
          : forcesRunout
            ? projectedSpr(
                'notApplicable',
                'forcedRunout',
                nextStreetContestable,
                sources,
              )
            : continuation.kind === 'nextStreet'
              ? projectedSpr(
                  'available',
                  'wrongStreet',
                  nextStreetContestable,
                  sources,
                )
              : projectedSpr(
                  'notApplicable',
                  continuation.kind === 'sameStreet'
                    ? 'bettingRoundRemainsOpen'
                    : 'handComplete',
                  nextStreetContestable,
                  sources,
                )
      const nextStreetSpr =
        input.analysisInput.street === 'preflop'
          ? projectedSpr(
              'notApplicable',
              'wrongStreet',
              nextStreetContestable,
              sources,
            )
          : forcesRunout
            ? projectedSpr(
                'notApplicable',
                'forcedRunout',
                nextStreetContestable,
                sources,
              )
            : continuation.kind === 'nextStreet'
              ? projectedSpr(
                  'available',
                  'wrongStreet',
                  nextStreetContestable,
                  sources,
                )
              : projectedSpr(
                  'notApplicable',
                  input.analysisInput.street === 'river'
                    ? 'noFutureDecisionStreet'
                    : continuation.kind === 'sameStreet'
                      ? 'bettingRoundRemainsOpen'
                      : 'handComplete',
                  nextStreetContestable,
                  sources,
                )
      const isCallingAction =
        freshCandidate.action.type === 'call' ||
        (freshCandidate.action.type === 'allIn' &&
          transition.currentBetAfter === transition.currentBetBefore)
      const minimumRequiredEquityForCall: CandidateThresholdFact<CoreFactSourceRef> =
        isCallingAction
          ? {
              status: 'available',
              value: createExactRatio(
                amountActuallyAtRisk,
                heroContestablePotAfterAction,
              ),
              epistemicKind: 'formulaFact',
              sourceRefs: sources,
              assumptionCodes: ['ignoresFutureAction'],
            }
          : {
              status: 'notApplicable',
              reasonCode: 'notCallingAction',
              sourceRefs: sources,
              assumptionCodes: [],
            }
      const isAggressive =
        freshCandidate.action.type === 'bet' ||
        freshCandidate.action.type === 'raise' ||
        (freshCandidate.action.type === 'allIn' &&
          transition.currentBetAfter > transition.currentBetBefore)
      const hasSidePotAmbiguity = before.potBreakdown.some(
        (pot) =>
          pot.eligibleSeatNumbers.join('|') !==
          before.potBreakdown[0]?.eligibleSeatNumbers.join('|'),
      )
      const pureBluffBreakEvenFoldRate: CandidateThresholdFact<CoreFactSourceRef> =
        !isAggressive
          ? {
              status: 'notApplicable',
              reasonCode: 'notPureBluffCandidate',
              sourceRefs: sources,
              assumptionCodes: [],
            }
          : topology.responders.length !== 1 || hasSidePotAmbiguity
            ? {
                status: 'unavailable',
                reasonCode: 'noJointResponseModel',
                sourceRefs: sources,
                assumptionCodes: ['noJointResponseModel'],
              }
            : {
                status: 'available',
                value: createExactRatio(
                  amountActuallyAtRisk,
                  transition.potBefore + amountActuallyAtRisk,
                ),
                epistemicKind: 'formulaFact',
                sourceRefs: sources,
                assumptionCodes: ['ignoresFutureAction'],
              }
      const unavailableRangeFact = {
        status: 'unavailable' as const,
        reasonCode: 'noVersionedOpponentRange' as const,
        sourceRefs: sources,
        assumptionCodes: ['noVersionedOpponentRange'] as const,
      }
      const unavailableResponseFact = {
        status: 'unavailable' as const,
        reasonCode: 'noJointResponseModel' as const,
        sourceRefs: sources,
        assumptionCodes: ['noJointResponseModel'] as const,
      }

      return {
        candidateOutcomeSchemaVersion: 1 as const,
        projectorVersion: 1 as const,
        sourceRefs: [...sources],
        candidate: catalogShape(freshCandidate) as LegalCandidateCatalogEntry,
        amountToCall: transition.amountToCallBefore,
        contributionDelta: transition.contributionDelta,
        targetStreetCommitment:
          freshCandidate.targetStreetCommitment === null
            ? {
                status: 'notApplicable' as const,
                reasonCode: 'noTarget' as const,
              }
            : {
                status: 'available' as const,
                value: freshCandidate.targetStreetCommitment,
              },
        streetContributionAfter: transition.targetStreetCommitmentAfter,
        totalContributionAfter: transition.totalContributionAfter,
        guaranteedUncalledReturn: guaranteedReturn,
        amountActuallyAtRisk,
        contestableAmountAdded,
        potAfterAction: transition.state.pot,
        heroContestablePotAfterAction,
        marginalContestablePot: {
          amountActuallyAtRisk,
          contestableAmountAdded,
        },
        actionScale: {
          contributionDeltaToPotBefore: {
            ratioKind: 'contributionDeltaToPotBefore' as const,
            value: createExactRatio(
              transition.contributionDelta,
              transition.potBefore,
            ),
          },
          targetStreetCommitmentToPotBefore:
            freshCandidate.targetStreetCommitment === null
              ? {
                  status: 'notApplicable' as const,
                  reasonCode: 'noTarget' as const,
                }
              : {
                  status: 'available' as const,
                  ratioKind: 'targetStreetCommitmentToPotBefore' as const,
                  value: createExactRatio(
                    freshCandidate.targetStreetCommitment,
                    transition.potBefore,
                  ),
                },
        },
        heroStackAfterAction: heroAfter.stack,
        effectiveStacksByOpponentAfterAction:
          after?.effectiveStacksByOpponent ?? [],
        isAllIn: heroAfter.status === 'allIn',
        handEndsByFold: continuation.handEndsByFold,
        forcesRunout,
        remainingStreetsToDeal: forcesRunout
          ? continuation.remainingStreetsToDeal
          : 0,
        furtherBettingPossible: continuation.furtherBettingPossible,
        showdownForced: continuation.showdownForced,
        responders: topology.responders,
        canRaiseSeats: topology.canRaiseSeats,
        heroActionCompletes: true as const,
        bettingRoundClosesImmediately:
          continuation.bettingRoundClosesImmediately,
        canFaceFurtherAction,
        legalSuccessorSpace: {
          nextActorSeatNumber: nextState?.currentActorSeatNumber ?? null,
          possibleActionTypes,
          mayReturnToHero: canFaceFurtherAction,
        },
        projectedFlopSpr,
        nextStreetSpr,
        minimumRequiredEquityForCall,
        pureBluffBreakEvenFoldRate,
        rangeConditionalEquity: unavailableRangeFact,
        opponentResponseProbability: unavailableResponseFact,
        expectedValue: unavailableRangeFact,
        futureStreetValue: unavailableRangeFact,
        impliedOdds: unavailableRangeFact,
        foldEquity: unavailableResponseFact,
      }
    }),
  )
}
