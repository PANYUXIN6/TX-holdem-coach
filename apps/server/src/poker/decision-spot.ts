import { createHash } from 'node:crypto'

import { canonicalJson, type JsonValue } from '../persisted-json.js'
import {
  createCandidateActionProof,
  createLegalCandidates,
} from './decision-candidates.js'
import {
  toBettingProjectionState,
  type DecisionAnalysisInput,
  type DecisionAnalysisPublicAction,
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
} from './betting-projection.js'
import {
  assignLogicalPositions,
  clockwiseParticipantSeatNumbersAfter,
  type LogicalPosition,
} from './positioning.js'
import type { PokerCommand } from './commands.js'

type Street = DecisionAnalysisInput['street']
type ActionType = PokerCommand['action']['type']

export type RelativePosition = 'inPosition' | 'outOfPosition'

export interface OpponentPositionRelation {
  readonly opponentSeatNumber: number
  readonly opponentPosition: LogicalPosition
  readonly preflopActsBeforeHero: boolean
  readonly currentStreetActsBeforeHero: boolean
  readonly relativePosition: RelativePosition
}

export interface PlayerCountFacts {
  readonly dealtCount: number
  readonly remainingSeatCount: number
  readonly notFoldedCount: number
  readonly activeCount: number
  readonly allInCount: number
  readonly voluntaryPreflopParticipantCount: number
  readonly currentlyOwingActionCount: number
}

export interface ForcedPostFact {
  readonly seatNumber: number
  readonly kind: 'smallBlind' | 'bigBlind'
  readonly nominalAmount: 10 | 20
  readonly actualAmount: number
  readonly isAllIn: boolean
}

export type PreflopNodeKind =
  | 'unopened'
  | 'limped'
  | 'singleRaised'
  | 'squeezed'
  | 'threeBet'
  | 'fourBetOrMore'
  | 'shortAllInTree'
  | 'notApplicable'

export interface PreflopNode {
  readonly kind: PreflopNodeKind
  readonly fullRaiseCount: number
  readonly limperCount: number
  readonly callerCount: number
  readonly hasShortAllInRaise: boolean
}

export type PotTypeKind =
  | 'singleRaised'
  | 'threeBet'
  | 'fourBetOrMore'
  | 'limped'
  | 'unraisedPostflop'
  | 'multiwaySidePot'
  | 'other'

export interface PotType {
  readonly kind: PotTypeKind
  readonly isHeadsUp: boolean
  readonly isMultiway: boolean
  readonly hasSidePot: boolean
}

export interface InitiativeFacts {
  readonly lastPreflopFullAggressorSeatNumber: number | null
  readonly lastPreflopFullAggressorStillInHand: boolean | null
  readonly lastCurrentStreetFullAggressorSeatNumber: number | null
  readonly lastCurrentStreetFullAggressorStillInHand: boolean | null
}

export interface NormalizedAction {
  readonly eventSeq: number
  readonly street: Street
  readonly actorSeatNumber: number
  readonly actionType: ActionType
  readonly amountToCallBefore: number
  readonly contributionDelta: number
  readonly targetStreetCommitmentAfter: number
  readonly totalContributionAfter: number
  readonly potBefore: number
  readonly contributionToPotRatio: ExactRatio
  readonly targetToPotRatio: ExactRatio
  readonly currentBetBefore: number
  readonly currentBetAfter: number
  readonly minimumFullRaiseIncrementBefore: number
  readonly minimumFullRaiseIncrementAfter: number
  readonly isVoluntaryPreflopContribution: boolean
  readonly isFullRaise: boolean
}

export interface FullRaiseFact {
  readonly targetStreetCommitment: number
  readonly increment: number
  readonly source: 'action' | 'forcedBigBlind'
  readonly actorSeatNumber: number | null
  readonly eventSeq: number | null
}

export type LastFullRaiseFact<TSourceRef = CoreFactSourceRef> =
  | DerivedFact<FullRaiseFact, TSourceRef>
  | {
      readonly status: 'notApplicable'
      readonly reasonCode: 'noFullRaiseOnStreet'
      readonly sourceRefs: readonly TSourceRef[]
      readonly assumptionCodes: readonly []
    }

export type EffectiveStackBand =
  'lt20bb' | '20to39bb' | '40to79bb' | '80to149bb' | 'ge150bb'

export interface EffectiveStackBandFact {
  readonly opponentSeatNumber: number
  readonly opponentPosition: LogicalPosition
  readonly effectiveStackChips: number
  readonly effectiveStackBigBlinds: ExactRatio
  readonly band: EffectiveStackBand
}

export interface LegalActionTopologyClass {
  readonly actionType: ActionType
  readonly targetStreetCommitment: number | null
  readonly heroActionCompletes: true
  readonly bettingRoundClosesImmediately: boolean
  readonly canFaceFurtherAction: boolean
}

export interface NormalizedDecisionSpotData<TSourceRef = CoreFactSourceRef> {
  readonly spotSchemaVersion: 1
  readonly normalizerVersion: 1
  readonly spotKey: string
  readonly tableSize: 6 | 7 | 8 | 9
  readonly heroPosition: LogicalPosition
  readonly positionsByOpponent: readonly OpponentPositionRelation[]
  readonly street: Street
  readonly playerCounts: PlayerCountFacts
  readonly actionOrder: readonly number[]
  readonly playersBehindHero: readonly number[]
  readonly forcedPosts: readonly ForcedPostFact[]
  readonly bigBlindOptionAvailable: boolean
  readonly preflopNode: PreflopNode
  readonly potType: PotType
  readonly initiative: InitiativeFacts
  readonly actionLine: readonly NormalizedAction[]
  readonly lastFullRaise: LastFullRaiseFact<TSourceRef>
  readonly raiseReopenedForHero: boolean
  readonly effectiveStackBandsByOpponent: readonly EffectiveStackBandFact[]
  readonly decisionTopology: readonly LegalActionTopologyClass[]
}

const SMALL_BLIND = 10
const BIG_BLIND = 20

function fail(message: string): never {
  throw new Error(`Invalid decision analysis input: ${message}`)
}

function assertSafeNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a non-negative safe integer`)
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function validateInput(input: DecisionAnalysisInput): void {
  if (![6, 7, 8, 9].includes(input.participantSeatNumbers.length)) {
    fail('participantSeatNumbers must contain 6, 7, 8, or 9 seats')
  }

  const participants = new Set(input.participantSeatNumbers)
  if (participants.size !== input.participantSeatNumbers.length) {
    fail('participantSeatNumbers must be unique')
  }
  if (!participants.has(input.heroSeatNumber)) {
    fail('heroSeatNumber must be a participant')
  }

  for (const [label, values] of [
    ['positions', input.positions.map(({ seatNumber }) => seatNumber)],
    [
      'startingStacks',
      input.startingStacks.map(({ seatNumber }) => seatNumber),
    ],
  ] as const) {
    const seats = new Set(values)
    if (
      seats.size !== participants.size ||
      [...participants].some((seat) => !seats.has(seat))
    ) {
      fail(`${label} must cover every participant exactly once`)
    }
  }
  for (const { seatNumber, stack } of input.startingStacks) {
    if (!Number.isSafeInteger(stack) || stack <= 0) {
      fail(
        `starting stack for seat ${seatNumber} must be a positive safe integer`,
      )
    }
  }

  const expectedPositions = assignLogicalPositions(
    input.buttonSeatNumber,
    input.participantSeatNumbers,
  )
  const expectedPositionBySeat = new Map(
    expectedPositions.map(({ seatNumber, position }) => [seatNumber, position]),
  )
  for (const { seatNumber, position } of input.positions) {
    if (expectedPositionBySeat.get(seatNumber) !== position) {
      fail(
        `position for seat ${seatNumber} does not match the button and participant topology`,
      )
    }
  }

  let previousEventSeq = -1
  for (const action of input.publicActions) {
    assertSafeNonNegativeInteger(action.eventSeq, 'publicActions.eventSeq')
    if (action.eventSeq <= previousEventSeq) {
      fail('publicActions must be strictly ordered by eventSeq')
    }
    if (!participants.has(action.actorSeatNumber)) {
      fail(
        `public action actor seat ${action.actorSeatNumber} is not a participant`,
      )
    }
    previousEventSeq = action.eventSeq
  }

  const state = toBettingProjectionState(input)
  const projectedLegalActions = getProjectedLegalActions(state)
  if (!sameJson(projectedLegalActions, input.legalActions)) {
    fail(
      'legalActions do not match the betting projection for the supplied state',
    )
  }
}

function seatStatusIsStillInHand(
  status: DecisionAnalysisInput['seats'][number]['status'],
): boolean {
  return status === 'active' || status === 'allIn'
}

function seatStillOwesAction(
  input: DecisionAnalysisInput,
  seatNumber: number,
): boolean {
  const seat = input.seats.find(
    (candidate) => candidate.seatNumber === seatNumber,
  )
  const roundState = input.bettingRound.seatStates.find(
    (candidate) => candidate.seatNumber === seatNumber,
  )
  if (
    seat?.status !== 'active' ||
    seat.stack <= 0 ||
    roundState === undefined
  ) {
    return false
  }
  return (
    roundState.betLevelAfterLastAction === null ||
    seat.streetContribution < input.bettingRound.currentBet
  )
}

function positionFacts(input: DecisionAnalysisInput): {
  heroPosition: LogicalPosition
  positionsByOpponent: OpponentPositionRelation[]
} {
  const positionBySeat = new Map(
    input.positions.map(({ seatNumber, position }) => [seatNumber, position]),
  )
  const heroPosition = positionBySeat.get(input.heroSeatNumber)
  if (heroPosition === undefined) {
    fail('hero position is missing')
  }

  const preflopOrder = assignLogicalPositions(
    input.buttonSeatNumber,
    input.participantSeatNumbers,
  ).map(({ seatNumber }) => seatNumber)
  const postflopOrder = clockwiseParticipantSeatNumbersAfter(
    input.buttonSeatNumber,
    input.participantSeatNumbers,
  )
  const currentOrder = input.street === 'preflop' ? preflopOrder : postflopOrder
  const heroPreflopIndex = preflopOrder.indexOf(input.heroSeatNumber)
  const heroCurrentIndex = currentOrder.indexOf(input.heroSeatNumber)
  const heroPostflopIndex = postflopOrder.indexOf(input.heroSeatNumber)

  const positionsByOpponent = input.participantSeatNumbers
    .filter((seatNumber) => seatNumber !== input.heroSeatNumber)
    .map((opponentSeatNumber): OpponentPositionRelation => {
      const opponentPosition = positionBySeat.get(opponentSeatNumber)
      if (opponentPosition === undefined) {
        fail(`position for opponent seat ${opponentSeatNumber} is missing`)
      }
      return {
        opponentSeatNumber,
        opponentPosition,
        preflopActsBeforeHero:
          preflopOrder.indexOf(opponentSeatNumber) < heroPreflopIndex,
        currentStreetActsBeforeHero:
          currentOrder.indexOf(opponentSeatNumber) < heroCurrentIndex,
        relativePosition:
          heroPostflopIndex > postflopOrder.indexOf(opponentSeatNumber)
            ? 'inPosition'
            : 'outOfPosition',
      }
    })
    .sort((left, right) => left.opponentSeatNumber - right.opponentSeatNumber)

  return { heroPosition, positionsByOpponent }
}

function playerCountFacts(input: DecisionAnalysisInput): PlayerCountFacts {
  const participantSet = new Set(input.participantSeatNumbers)
  const seats = input.seats.filter(({ seatNumber }) =>
    participantSet.has(seatNumber),
  )
  const voluntaryPreflopSeats = new Set(
    input.publicActions
      .filter(
        (action) =>
          action.streetBefore === 'preflop' &&
          action.isVoluntaryPreflopContribution,
      )
      .map(({ actorSeatNumber }) => actorSeatNumber),
  )
  return {
    dealtCount: input.participantSeatNumbers.length,
    remainingSeatCount: seats.filter(({ status }) => status !== 'out').length,
    notFoldedCount: seats.filter(({ status }) =>
      seatStatusIsStillInHand(status),
    ).length,
    activeCount: seats.filter(({ status }) => status === 'active').length,
    allInCount: seats.filter(({ status }) => status === 'allIn').length,
    voluntaryPreflopParticipantCount: voluntaryPreflopSeats.size,
    currentlyOwingActionCount: input.participantSeatNumbers.filter(
      (seatNumber) => seatStillOwesAction(input, seatNumber),
    ).length,
  }
}

function forcedPostFacts(input: DecisionAnalysisInput): ForcedPostFact[] {
  const startingStackBySeat = new Map(
    input.startingStacks.map(({ seatNumber, stack }) => [seatNumber, stack]),
  )
  const posts: readonly {
    readonly seatNumber: number
    readonly kind: ForcedPostFact['kind']
    readonly nominalAmount: ForcedPostFact['nominalAmount']
  }[] = [
    {
      seatNumber: input.smallBlindSeatNumber,
      kind: 'smallBlind',
      nominalAmount: SMALL_BLIND,
    },
    {
      seatNumber: input.bigBlindSeatNumber,
      kind: 'bigBlind',
      nominalAmount: BIG_BLIND,
    },
  ]
  return posts.map(({ seatNumber, kind, nominalAmount }): ForcedPostFact => {
    const startingStack = startingStackBySeat.get(seatNumber)
    if (startingStack === undefined) {
      fail(`${kind} seat has no starting stack`)
    }
    return {
      seatNumber,
      kind,
      nominalAmount,
      actualAmount: Math.min(startingStack, nominalAmount),
      isAllIn: startingStack <= nominalAmount,
    }
  })
}

function isAggressiveAction(action: DecisionAnalysisPublicAction): boolean {
  return (
    action.action.type === 'bet' ||
    action.action.type === 'raise' ||
    action.action.type === 'allIn'
  )
}

function buildPreflopNode(input: DecisionAnalysisInput): PreflopNode {
  const preflopActions = input.publicActions.filter(
    ({ streetBefore }) => streetBefore === 'preflop',
  )
  const fullRaiseIndexes = preflopActions
    .map((action, index) => ({ action, index }))
    .filter(({ action }) => action.isFullRaise && isAggressiveAction(action))
  const firstFullRaiseIndex =
    fullRaiseIndexes[0]?.index ?? Number.POSITIVE_INFINITY
  const limperCount = preflopActions.filter(
    (action, index) =>
      index < firstFullRaiseIndex &&
      action.action.type === 'call' &&
      action.currentBetBefore === BIG_BLIND,
  ).length
  const callerCount = preflopActions.filter(
    (action, index) =>
      action.action.type === 'call' &&
      !(index < firstFullRaiseIndex && action.currentBetBefore === BIG_BLIND),
  ).length
  const hasShortAllInRaise = preflopActions.some(
    (action) =>
      action.action.type === 'allIn' &&
      action.currentBetAfter > action.currentBetBefore &&
      !action.isFullRaise,
  )
  const secondFullRaiseIndex = fullRaiseIndexes[1]?.index
  const isSqueeze =
    secondFullRaiseIndex !== undefined &&
    preflopActions
      .slice(firstFullRaiseIndex + 1, secondFullRaiseIndex)
      .some(({ action }) => action.type === 'call')

  let kind: PreflopNodeKind
  if (input.street !== 'preflop') {
    kind = 'notApplicable'
  } else if (hasShortAllInRaise) {
    kind = 'shortAllInTree'
  } else if (fullRaiseIndexes.length === 0) {
    kind = limperCount > 0 ? 'limped' : 'unopened'
  } else if (fullRaiseIndexes.length === 1) {
    kind = 'singleRaised'
  } else if (fullRaiseIndexes.length === 2) {
    kind = isSqueeze ? 'squeezed' : 'threeBet'
  } else {
    kind = 'fourBetOrMore'
  }

  return {
    kind,
    fullRaiseCount: fullRaiseIndexes.length,
    limperCount,
    callerCount,
    hasShortAllInRaise,
  }
}

function buildPotType(
  input: DecisionAnalysisInput,
  preflopNode: PreflopNode,
): PotType {
  const contenders = input.seats.filter(({ status }) =>
    seatStatusIsStillInHand(status),
  )
  const contributionLevels = new Set(
    contenders
      .map(({ totalContribution }) => totalContribution)
      .filter((amount) => amount > 0),
  )
  const hasSidePot =
    contenders.some(({ status }) => status === 'allIn') &&
    contributionLevels.size > 1

  let kind: PotTypeKind
  if (hasSidePot) {
    kind = 'multiwaySidePot'
  } else if (preflopNode.fullRaiseCount >= 3) {
    kind = 'fourBetOrMore'
  } else if (preflopNode.fullRaiseCount === 2) {
    kind = 'threeBet'
  } else if (preflopNode.fullRaiseCount === 1) {
    kind = 'singleRaised'
  } else if (preflopNode.limperCount > 0) {
    kind = 'limped'
  } else if (input.street !== 'preflop') {
    kind = 'unraisedPostflop'
  } else {
    kind = 'other'
  }

  return {
    kind,
    isHeadsUp: contenders.length === 2,
    isMultiway: contenders.length > 2,
    hasSidePot,
  }
}

function lastFullAggressor(
  input: DecisionAnalysisInput,
  street: Street,
): { seatNumber: number; stillInHand: boolean } | null {
  const action = [...input.publicActions]
    .reverse()
    .find(
      (candidate) =>
        candidate.streetBefore === street &&
        candidate.isFullRaise &&
        isAggressiveAction(candidate),
    )
  if (action === undefined) {
    return null
  }
  const seat = input.seats.find(
    ({ seatNumber }) => seatNumber === action.actorSeatNumber,
  )
  return {
    seatNumber: action.actorSeatNumber,
    stillInHand: seat !== undefined && seatStatusIsStillInHand(seat.status),
  }
}

function initiativeFacts(input: DecisionAnalysisInput): InitiativeFacts {
  const preflop = lastFullAggressor(input, 'preflop')
  const current = lastFullAggressor(input, input.street)
  return {
    lastPreflopFullAggressorSeatNumber: preflop?.seatNumber ?? null,
    lastPreflopFullAggressorStillInHand: preflop?.stillInHand ?? null,
    lastCurrentStreetFullAggressorSeatNumber: current?.seatNumber ?? null,
    lastCurrentStreetFullAggressorStillInHand: current?.stillInHand ?? null,
  }
}

function normalizeActionLine(input: DecisionAnalysisInput): NormalizedAction[] {
  return input.publicActions.map((action) => ({
    eventSeq: action.eventSeq,
    street: action.streetBefore,
    actorSeatNumber: action.actorSeatNumber,
    actionType: action.action.type,
    amountToCallBefore: action.amountToCallBefore,
    contributionDelta: action.contributionDelta,
    targetStreetCommitmentAfter: action.targetStreetCommitmentAfter,
    totalContributionAfter: action.totalContributionAfter,
    potBefore: action.potBefore,
    contributionToPotRatio: createExactRatio(
      action.contributionDelta,
      action.potBefore,
    ),
    targetToPotRatio: createExactRatio(
      action.targetStreetCommitmentAfter,
      action.potBefore,
    ),
    currentBetBefore: action.currentBetBefore,
    currentBetAfter: action.currentBetAfter,
    minimumFullRaiseIncrementBefore: action.minimumFullRaiseIncrementBefore,
    minimumFullRaiseIncrementAfter: action.minimumFullRaiseIncrementAfter,
    isVoluntaryPreflopContribution: action.isVoluntaryPreflopContribution,
    isFullRaise: action.isFullRaise,
  }))
}

function buildLastFullRaise(input: DecisionAnalysisInput): LastFullRaiseFact {
  const action = [...input.publicActions]
    .reverse()
    .find(
      (candidate) =>
        candidate.streetBefore === input.street &&
        candidate.isFullRaise &&
        isAggressiveAction(candidate),
    )
  if (action !== undefined) {
    return {
      status: 'available',
      epistemicKind: 'formulaFact',
      value: {
        targetStreetCommitment: action.currentBetAfter,
        increment: action.currentBetAfter - action.currentBetBefore,
        source: 'action',
        actorSeatNumber: action.actorSeatNumber,
        eventSeq: action.eventSeq,
      },
      sourceRefs: [
        {
          kind: 'analysisInputField',
          path: 'hand.publicActions',
          eventSeq: action.eventSeq,
        },
      ],
      assumptionCodes: [],
    }
  }
  if (input.street === 'preflop') {
    return {
      status: 'available',
      epistemicKind: 'ruleFact',
      value: {
        targetStreetCommitment: BIG_BLIND,
        increment: BIG_BLIND,
        source: 'forcedBigBlind',
        actorSeatNumber: input.bigBlindSeatNumber,
        eventSeq: null,
      },
      sourceRefs: [
        {
          kind: 'ruleSet',
          pokerRuleSetVersion: input.pokerRuleSetVersion,
          factId: 'nominalBlinds',
        },
      ],
      assumptionCodes: [],
    }
  }
  if (input.bettingRound.currentBet > 0) {
    return {
      status: 'notApplicable',
      reasonCode: 'noFullRaiseOnStreet',
      sourceRefs: [
        {
          kind: 'analysisInputField',
          path: 'hand.publicActions',
          eventSeq: null,
        },
        {
          kind: 'analysisInputField',
          path: 'hand.bettingRound',
          eventSeq: null,
        },
      ],
      assumptionCodes: [],
    }
  }
  return {
    status: 'notApplicable',
    reasonCode: 'noBetOnStreet',
    sourceRefs: [
      {
        kind: 'analysisInputField',
        path: 'hand.publicActions',
        eventSeq: null,
      },
      { kind: 'analysisInputField', path: 'hand.bettingRound', eventSeq: null },
    ],
    assumptionCodes: [],
  }
}

function raiseReopenedForHero(input: DecisionAnalysisInput): boolean {
  const heroRoundState = input.bettingRound.seatStates.find(
    ({ seatNumber }) => seatNumber === input.heroSeatNumber,
  )
  if (heroRoundState === undefined) {
    fail('hero betting-round state is missing')
  }
  return (
    heroRoundState.betLevelAfterLastAction === null ||
    input.bettingRound.currentBet - heroRoundState.betLevelAfterLastAction >=
      input.bettingRound.minimumFullRaiseIncrement
  )
}

function effectiveStackBand(chips: number): EffectiveStackBand {
  if (chips < 20 * BIG_BLIND) return 'lt20bb'
  if (chips < 40 * BIG_BLIND) return '20to39bb'
  if (chips < 80 * BIG_BLIND) return '40to79bb'
  if (chips < 150 * BIG_BLIND) return '80to149bb'
  return 'ge150bb'
}

function effectiveStackFacts(
  input: DecisionAnalysisInput,
  positionBySeat: ReadonlyMap<number, LogicalPosition>,
): EffectiveStackBandFact[] {
  const hero = input.seats.find(
    ({ seatNumber }) => seatNumber === input.heroSeatNumber,
  )
  if (hero === undefined) {
    fail('hero seat state is missing')
  }
  return input.seats
    .filter(
      (seat) =>
        seat.seatNumber !== input.heroSeatNumber &&
        seatStatusIsStillInHand(seat.status),
    )
    .map((opponent): EffectiveStackBandFact => {
      const opponentPosition = positionBySeat.get(opponent.seatNumber)
      if (opponentPosition === undefined) {
        fail(`opponent position for seat ${opponent.seatNumber} is missing`)
      }
      const effectiveStackChips = Math.min(hero.stack, opponent.stack)
      return {
        opponentSeatNumber: opponent.seatNumber,
        opponentPosition,
        effectiveStackChips,
        effectiveStackBigBlinds: createExactRatio(
          effectiveStackChips,
          BIG_BLIND,
        ),
        band: effectiveStackBand(effectiveStackChips),
      }
    })
    .sort((left, right) => left.opponentSeatNumber - right.opponentSeatNumber)
}

function bigBlindOptionAvailable(input: DecisionAnalysisInput): boolean {
  const hero = input.seats.find(
    ({ seatNumber }) => seatNumber === input.heroSeatNumber,
  )
  const heroHasVoluntarilyActed = input.publicActions.some(
    (action) =>
      action.streetBefore === 'preflop' &&
      action.actorSeatNumber === input.heroSeatNumber &&
      action.isVoluntaryPreflopContribution,
  )
  const hasCheck = input.legalActions.some(({ type }) => type === 'check')
  const hasIncreasingAggression = input.legalActions.some(
    (action) =>
      (action.type === 'raise' &&
        action.maxTarget > input.bettingRound.currentBet) ||
      (action.type === 'allIn' &&
        action.target > input.bettingRound.currentBet),
  )
  const amountToCall = Math.max(
    0,
    input.bettingRound.currentBet - (hero?.streetContribution ?? 0),
  )
  return (
    input.street === 'preflop' &&
    input.heroSeatNumber === input.bigBlindSeatNumber &&
    hero?.status === 'active' &&
    hero.stack > 0 &&
    !heroHasVoluntarilyActed &&
    input.bettingRound.currentBet === BIG_BLIND &&
    amountToCall === 0 &&
    hasCheck &&
    hasIncreasingAggression
  )
}

function buildDecisionTopology(
  input: DecisionAnalysisInput,
): LegalActionTopologyClass[] {
  const state = toBettingProjectionState(input)
  return createLegalCandidates(state).map((candidate) => {
    const proof = createCandidateActionProof(state, candidate)
    const transition = projectBettingTransition(state, proof)
    const continuation = projectActionContinuation(
      transition.state,
      input.heroSeatNumber,
    )
    const heroAfter = transition.state.seats.find(
      ({ seatNumber }) => seatNumber === input.heroSeatNumber,
    )
    return {
      actionType: candidate.action.type,
      targetStreetCommitment: candidate.targetStreetCommitment,
      heroActionCompletes: true,
      bettingRoundClosesImmediately: continuation.bettingRoundClosesImmediately,
      canFaceFurtherAction:
        heroAfter?.status === 'active' &&
        heroAfter.stack > 0 &&
        continuation.canRaiseSeatNumbers.length > 0,
    }
  })
}

function buildSpotKey(
  input: DecisionAnalysisInput,
  fields: Omit<
    NormalizedDecisionSpotData,
    | 'spotSchemaVersion'
    | 'normalizerVersion'
    | 'spotKey'
    | 'decisionTopology'
    | 'forcedPosts'
    | 'initiative'
    | 'lastFullRaise'
    | 'bigBlindOptionAvailable'
    | 'actionOrder'
    | 'playersBehindHero'
  >,
  lastFullRaise: LastFullRaiseFact,
): string {
  const positionBySeat = new Map(
    input.positions.map(({ seatNumber, position }) => [seatNumber, position]),
  )
  const byPosition = <Value extends { readonly opponentPosition: string }>(
    left: Value,
    right: Value,
  ): number =>
    left.opponentPosition < right.opponentPosition
      ? -1
      : left.opponentPosition > right.opponentPosition
        ? 1
        : 0
  const lastFullRaiseForKey = (() => {
    if (lastFullRaise.status !== 'available') {
      return {
        status: lastFullRaise.status,
        reasonCode: lastFullRaise.reasonCode,
      }
    }
    const actorPosition =
      lastFullRaise.value.actorSeatNumber === null
        ? null
        : positionBySeat.get(lastFullRaise.value.actorSeatNumber)
    if (actorPosition === undefined) {
      fail(
        `last full-raise actor position for seat ${lastFullRaise.value.actorSeatNumber} is missing`,
      )
    }
    return {
      status: lastFullRaise.status,
      value: {
        targetStreetCommitment: lastFullRaise.value.targetStreetCommitment,
        increment: lastFullRaise.value.increment,
        source: lastFullRaise.value.source,
        actorPosition,
      },
    }
  })()
  const canonicalInput = {
    pokerRuleSetVersion: input.pokerRuleSetVersion,
    tableSize: fields.tableSize,
    street: fields.street,
    heroPosition: fields.heroPosition,
    positionsByOpponent: fields.positionsByOpponent
      .map(
        ({
          opponentPosition,
          preflopActsBeforeHero,
          currentStreetActsBeforeHero,
          relativePosition,
        }) => ({
          opponentPosition,
          preflopActsBeforeHero,
          currentStreetActsBeforeHero,
          relativePosition,
        }),
      )
      .sort(byPosition),
    playerCounts: fields.playerCounts,
    preflopNode: fields.preflopNode,
    potType: fields.potType,
    raiseTree: {
      preflopFullRaiseCount: fields.preflopNode.fullRaiseCount,
      lastFullRaise: lastFullRaiseForKey,
    },
    effectiveStackBandsByOpponent: fields.effectiveStackBandsByOpponent
      .map(({ opponentPosition, band }) => ({
        opponentPosition,
        band,
      }))
      .sort(byPosition),
    currentBet: input.bettingRound.currentBet,
    minimumFullRaiseIncrement: input.bettingRound.minimumFullRaiseIncrement,
    raiseReopenedForHero: fields.raiseReopenedForHero,
    actionLine: fields.actionLine.map(
      ({ eventSeq: _eventSeq, actorSeatNumber, ...action }) => {
        const actorPosition = positionBySeat.get(actorSeatNumber)
        if (actorPosition === undefined) {
          fail(`action actor position for seat ${actorSeatNumber} is missing`)
        }
        return { ...action, actorPosition }
      },
    ),
  } as unknown as JsonValue
  return createHash('sha256')
    .update(canonicalJson(canonicalInput))
    .digest('hex')
}

/**
 * Converts one certified player DecisionAnalysisInput into the deterministic,
 * strategy-facing spot vocabulary defined by M4.5 §10.
 */
export function normalizeDecisionSpot(
  input: DecisionAnalysisInput,
): NormalizedDecisionSpotData {
  validateInput(input)
  const { heroPosition, positionsByOpponent } = positionFacts(input)
  const playerCounts = playerCountFacts(input)
  const actionOrder = clockwiseParticipantSeatNumbersAfter(
    input.heroSeatNumber,
    input.participantSeatNumbers,
  )
  const playersBehindHero = actionOrder.filter((seatNumber) => {
    const seat = input.seats.find(
      (candidate) => candidate.seatNumber === seatNumber,
    )
    return (
      seatNumber !== input.heroSeatNumber &&
      seat?.status === 'active' &&
      seat.stack > 0
    )
  })
  const preflopNode = buildPreflopNode(input)
  const potType = buildPotType(input, preflopNode)
  const actionLine = normalizeActionLine(input)
  const lastFullRaise = buildLastFullRaise(input)
  const raiseReopened = raiseReopenedForHero(input)
  const positionBySeat = new Map(
    input.positions.map(({ seatNumber, position }) => [seatNumber, position]),
  )
  const effectiveStackBandsByOpponent = effectiveStackFacts(
    input,
    positionBySeat,
  )
  const keyFields = {
    tableSize: input.participantSeatNumbers.length as 6 | 7 | 8 | 9,
    heroPosition,
    positionsByOpponent,
    street: input.street,
    playerCounts,
    preflopNode,
    potType,
    actionLine,
    raiseReopenedForHero: raiseReopened,
    effectiveStackBandsByOpponent,
  }
  const spotKey = buildSpotKey(input, keyFields, lastFullRaise)

  return deepFreezeDecisionValue({
    spotSchemaVersion: 1,
    normalizerVersion: 1,
    spotKey,
    ...keyFields,
    actionOrder,
    playersBehindHero,
    forcedPosts: forcedPostFacts(input),
    bigBlindOptionAvailable: bigBlindOptionAvailable(input),
    initiative: initiativeFacts(input),
    lastFullRaise,
    decisionTopology: buildDecisionTopology(input),
  })
}
