import {
  LegalActionsSchema,
  type LegalAction,
  type LegalActions,
  type SuggestedTarget,
} from '@tx-holdem-coach/contracts'
import { PokerCommandSchema, type PokerCommand } from './commands.js'
import {
  clockwiseParticipantSeatNumbersAfter,
  findPostflopFirstActionableSeatNumber,
  findPreflopFirstActionableSeatNumber,
  getBlindSeatNumbers,
} from './positioning.js'

export type BettingProjectionStreet = 'preflop' | 'flop' | 'turn' | 'river'
export type BettingProjectionSeatStatus = 'active' | 'folded' | 'allIn' | 'out'

export interface BettingProjectionSeat {
  readonly seatNumber: number
  readonly status: BettingProjectionSeatStatus
  readonly stack: number
  readonly streetContribution: number
  readonly totalContribution: number
}

export interface BettingProjectionRound {
  readonly currentBet: number
  readonly minimumFullRaiseIncrement: number
  readonly seatStates: readonly {
    readonly seatNumber: number
    readonly betLevelAfterLastAction: number | null
  }[]
}

export interface BettingProjectionState {
  readonly buttonSeatNumber: number
  readonly participantSeatNumbers: readonly number[]
  readonly street: BettingProjectionStreet
  readonly currentActorSeatNumber: number
  readonly pot: number
  readonly seats: readonly BettingProjectionSeat[]
  readonly bettingRound: BettingProjectionRound
}

declare const committedBettingActionBrand: unique symbol

export type CommittedBettingActionProof = Readonly<{
  command: PokerCommand
  legalActionsBefore: LegalActions
  readonly [committedBettingActionBrand]: never
}>

export interface BettingTransitionProjection {
  readonly state: BettingProjectionState
  readonly actorSeatNumber: number
  readonly action: PokerCommand['action']
  readonly amountToCallBefore: number
  readonly contributionDelta: number
  readonly targetStreetCommitmentAfter: number
  readonly totalContributionAfter: number
  readonly potBefore: number
  readonly currentBetBefore: number
  readonly currentBetAfter: number
  readonly minimumFullRaiseIncrementBefore: number
  readonly minimumFullRaiseIncrementAfter: number
  readonly isVoluntaryPreflopContribution: boolean
  readonly isFullRaise: boolean
}

export interface BettingActionEvidence {
  readonly action: PokerCommand
  readonly amountToCallBefore: number
  readonly contributionDelta: number
  readonly targetStreetCommitmentAfter: number
  readonly totalContributionAfter: number
  readonly potBefore: number
  readonly currentBetBefore: number
  readonly currentBetAfter: number
  readonly minimumFullRaiseIncrementBefore: number
  readonly minimumFullRaiseIncrementAfter: number
  readonly isVoluntaryPreflopContribution: boolean
  readonly isFullRaise: boolean
}

export type BettingContinuationProjection =
  | {
      readonly kind: 'sameStreet'
      readonly state: BettingProjectionState
    }
  | {
      readonly kind: 'nextStreet'
      readonly state: BettingProjectionState
    }
  | {
      readonly kind: 'showdown'
      readonly seats: readonly BettingProjectionSeat[]
      readonly forcesRunout: boolean
    }
  | {
      readonly kind: 'complete'
      readonly seats: readonly BettingProjectionSeat[]
    }

const ACTION_STREETS = new Set<BettingProjectionStreet>([
  'preflop',
  'flop',
  'turn',
  'river',
])
const committedBettingActions = new WeakSet<object>()

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

function isChipAmount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function assertProjectionState(
  state: BettingProjectionState,
  requireActiveActor = true,
): asserts state is BettingProjectionState {
  if (
    state === null ||
    typeof state !== 'object' ||
    !ACTION_STREETS.has(state.street) ||
    !Number.isInteger(state.buttonSeatNumber) ||
    state.buttonSeatNumber < 0 ||
    state.buttonSeatNumber > 8 ||
    !Number.isInteger(state.currentActorSeatNumber) ||
    state.currentActorSeatNumber < 0 ||
    state.currentActorSeatNumber > 8 ||
    !isChipAmount(state.pot) ||
    !isChipAmount(state.bettingRound.currentBet) ||
    !isChipAmount(state.bettingRound.minimumFullRaiseIncrement) ||
    state.bettingRound.minimumFullRaiseIncrement < 20
  ) {
    throw new RangeError('下注投影状态无效。')
  }
  const participantSet = new Set(state.participantSeatNumbers)
  const seatNumbers = state.seats.map((seat) => seat.seatNumber)
  const roundSeatNumbers = state.bettingRound.seatStates.map(
    (seat) => seat.seatNumber,
  )
  if (
    state.participantSeatNumbers.length < 6 ||
    state.participantSeatNumbers.length > 9 ||
    participantSet.size !== state.participantSeatNumbers.length ||
    new Set(seatNumbers).size !== seatNumbers.length ||
    !participantSet.has(state.buttonSeatNumber) ||
    !participantSet.has(state.currentActorSeatNumber) ||
    roundSeatNumbers.length !== participantSet.size ||
    new Set(roundSeatNumbers).size !== roundSeatNumbers.length ||
    roundSeatNumbers.some((seatNumber) => !participantSet.has(seatNumber))
  ) {
    throw new RangeError('下注投影参与座位无效。')
  }
  for (const seatNumber of state.participantSeatNumbers) {
    if (!seatNumbers.includes(seatNumber)) {
      throw new RangeError('下注投影缺少参与座位。')
    }
  }
  for (const seat of state.seats) {
    if (seat.streetContribution > state.bettingRound.currentBet) {
      throw new RangeError('行动者本街投入不得高于当前下注。')
    }
    if (
      !Number.isInteger(seat.seatNumber) ||
      seat.seatNumber < 0 ||
      seat.seatNumber > 8 ||
      !isChipAmount(seat.stack) ||
      !isChipAmount(seat.streetContribution) ||
      !isChipAmount(seat.totalContribution) ||
      seat.totalContribution < seat.streetContribution ||
      (!participantSet.has(seat.seatNumber) && seat.status !== 'out')
    ) {
      throw new RangeError('下注投影座位状态无效。')
    }
  }
  for (const seatState of state.bettingRound.seatStates) {
    if (
      seatState.betLevelAfterLastAction !== null &&
      (!isChipAmount(seatState.betLevelAfterLastAction) ||
        seatState.betLevelAfterLastAction > state.bettingRound.currentBet)
    ) {
      throw new RangeError('下注投影行动层级无效。')
    }
  }
  const actor = state.seats.find(
    (seat) => seat.seatNumber === state.currentActorSeatNumber,
  )
  if (
    actor === undefined ||
    (requireActiveActor && (actor.status !== 'active' || actor.stack <= 0))
  ) {
    throw new RangeError('下注投影当前行动者无效。')
  }
  if (
    state.pot !==
    state.seats.reduce((total, seat) => total + seat.totalContribution, 0)
  ) {
    throw new RangeError('下注投影底池与投入不守恒。')
  }
}

function ceilDivide(dividend: number, divisor: number): number {
  return Math.floor((dividend + divisor - 1) / divisor)
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}

function createSuggestedTargets(
  currentBet: number,
  callAmount: number,
  pot: number,
  minTarget: number,
  maxTarget: number,
): readonly SuggestedTarget[] {
  const potAfterCall = pot + callAmount
  const candidates: readonly SuggestedTarget[] = [
    { kind: 'minimum', targetStreetCommitment: minTarget },
    {
      kind: 'halfPot',
      targetStreetCommitment: currentBet + ceilDivide(potAfterCall, 2),
    },
    {
      kind: 'twoThirdsPot',
      targetStreetCommitment: currentBet + ceilDivide(potAfterCall * 2, 3),
    },
    {
      kind: 'pot',
      targetStreetCommitment: currentBet + potAfterCall,
    },
  ]
  const seenTargets = new Set<number>()
  const result: SuggestedTarget[] = []
  for (const candidate of candidates) {
    const targetStreetCommitment = clamp(
      candidate.targetStreetCommitment,
      minTarget,
      maxTarget,
    )
    if (!seenTargets.has(targetStreetCommitment)) {
      seenTargets.add(targetStreetCommitment)
      result.push({ kind: candidate.kind, targetStreetCommitment })
    }
  }
  return result
}

function getBettingFacts(state: BettingProjectionState) {
  assertProjectionState(state)
  const participants = new Set(state.participantSeatNumbers)
  const contenders = state.seats.filter(
    (seat) =>
      participants.has(seat.seatNumber) &&
      (seat.status === 'active' || seat.status === 'allIn'),
  )
  const actionable = contenders.filter(
    (seat) => seat.status === 'active' && seat.stack > 0,
  )
  const actor = state.seats.find(
    (seat) => seat.seatNumber === state.currentActorSeatNumber,
  )!
  const actorRoundState = state.bettingRound.seatStates.find(
    (seat) => seat.seatNumber === actor.seatNumber,
  )!
  if (contenders.length < 2 || actionable.length === 0) {
    throw new RangeError('当前手牌已经无需继续行动。')
  }
  const amountToCall =
    actionable.length === 1
      ? Math.max(
          0,
          Math.max(
            ...contenders
              .filter((seat) => seat.seatNumber !== actor.seatNumber)
              .map((seat) => seat.streetContribution),
          ) - actor.streetContribution,
        )
      : state.bettingRound.currentBet - actor.streetContribution
  if (actionable.length === 1 && amountToCall === 0) {
    throw new RangeError('当前手牌已经无需继续行动。')
  }
  return { actor, actorRoundState, actionable, amountToCall }
}

export function getProjectedLegalActions(
  state: BettingProjectionState,
): LegalActions {
  const { actor, actorRoundState, actionable, amountToCall } =
    getBettingFacts(state)
  if (actionable.length === 1) {
    return LegalActionsSchema.parse([
      { type: 'fold' },
      actor.stack > amountToCall
        ? { type: 'call', amount: amountToCall }
        : {
            type: 'allIn',
            target: actor.streetContribution + actor.stack,
          },
    ])
  }
  const allInTarget = actor.streetContribution + actor.stack
  const ordinaryMaxTarget = allInTarget - 1
  const minTarget =
    state.bettingRound.currentBet === 0
      ? 20
      : state.bettingRound.currentBet +
        state.bettingRound.minimumFullRaiseIncrement
  const raiseReopened =
    actorRoundState.betLevelAfterLastAction === null ||
    state.bettingRound.currentBet - actorRoundState.betLevelAfterLastAction >=
      state.bettingRound.minimumFullRaiseIncrement
  const actions: unknown[] = [{ type: 'fold' }]
  if (amountToCall === 0) actions.push({ type: 'check' })
  else if (amountToCall < actor.stack) {
    actions.push({ type: 'call', amount: amountToCall })
  }
  if (
    minTarget <= ordinaryMaxTarget &&
    (state.bettingRound.currentBet === 0 || raiseReopened)
  ) {
    actions.push({
      type: state.bettingRound.currentBet === 0 ? 'bet' : 'raise',
      minTarget,
      maxTarget: ordinaryMaxTarget,
      suggestedTargets: createSuggestedTargets(
        state.bettingRound.currentBet,
        amountToCall,
        state.pot,
        minTarget,
        ordinaryMaxTarget,
      ),
    })
  }
  if (actor.stack <= amountToCall || raiseReopened) {
    actions.push({ type: 'allIn', target: allInTarget })
  }
  return LegalActionsSchema.parse(actions)
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function createCommittedActionProof(
  command: PokerCommand,
  legalActionsBefore: LegalActions,
): CommittedBettingActionProof {
  const parsedCommand = PokerCommandSchema.parse(command)
  const parsedLegalActions = LegalActionsSchema.parse(legalActionsBefore)
  const legalAction = parsedLegalActions.find(
    (candidate) => candidate.type === parsedCommand.action.type,
  )
  if (
    legalAction === undefined ||
    ((parsedCommand.action.type === 'bet' ||
      parsedCommand.action.type === 'raise') &&
      (legalAction.type !== parsedCommand.action.type ||
        parsedCommand.action.targetStreetCommitment < legalAction.minTarget ||
        parsedCommand.action.targetStreetCommitment > legalAction.maxTarget))
  ) {
    throw new RangeError('已提交动作与合法动作证明不一致。')
  }
  const proof = deepFreeze({
    command: parsedCommand,
    legalActionsBefore: parsedLegalActions,
  } as unknown as CommittedBettingActionProof)
  committedBettingActions.add(proof)
  return proof
}

export function projectBettingTransition(
  state: BettingProjectionState,
  proof: CommittedBettingActionProof,
): BettingTransitionProjection {
  if (!committedBettingActions.has(proof)) {
    throw new RangeError('下注行动证明无效。')
  }
  const { actor, amountToCall } = getBettingFacts(state)
  const expectedLegalActions = getProjectedLegalActions(state)
  if (
    !sameJson(proof.legalActionsBefore, expectedLegalActions) ||
    proof.command.actorSeatNumber !== state.currentActorSeatNumber
  ) {
    throw new RangeError('下注行动证明与当前状态不一致。')
  }
  const action = proof.command.action
  let contributionDelta = 0
  switch (action.type) {
    case 'call':
      contributionDelta = amountToCall
      break
    case 'bet':
    case 'raise':
      contributionDelta =
        action.targetStreetCommitment - actor.streetContribution
      break
    case 'allIn':
      contributionDelta = actor.stack
      break
    case 'check':
    case 'fold':
      break
  }
  const targetStreetCommitmentAfter =
    actor.streetContribution + contributionDelta
  const allInLegalAction = expectedLegalActions.find(
    (candidate): candidate is Extract<LegalAction, { type: 'allIn' }> =>
      candidate.type === 'allIn',
  )
  if (
    contributionDelta < 0 ||
    contributionDelta > actor.stack ||
    (action.type === 'allIn' &&
      allInLegalAction?.target !== targetStreetCommitmentAfter)
  ) {
    throw new RangeError('下注行动金额证明无效。')
  }
  const currentBetBefore = state.bettingRound.currentBet
  const minimumFullRaiseIncrementBefore =
    state.bettingRound.minimumFullRaiseIncrement
  const currentBetAfter = Math.max(
    currentBetBefore,
    targetStreetCommitmentAfter,
  )
  const betLevelIncrease = currentBetAfter - currentBetBefore
  const isFullRaise =
    betLevelIncrease > 0 && betLevelIncrease >= minimumFullRaiseIncrementBefore
  const minimumFullRaiseIncrementAfter = isFullRaise
    ? betLevelIncrease
    : minimumFullRaiseIncrementBefore
  const remainingStack = actor.stack - contributionDelta
  const seats = state.seats.map((seat) =>
    seat.seatNumber === actor.seatNumber
      ? {
          ...seat,
          stack: remainingStack,
          status:
            action.type === 'fold'
              ? ('folded' as const)
              : action.type === 'allIn'
                ? ('allIn' as const)
                : ('active' as const),
          streetContribution: targetStreetCommitmentAfter,
          totalContribution: seat.totalContribution + contributionDelta,
        }
      : { ...seat },
  )
  const seatStates = state.bettingRound.seatStates.map((seatState) =>
    seatState.seatNumber === actor.seatNumber
      ? { ...seatState, betLevelAfterLastAction: currentBetAfter }
      : { ...seatState },
  )
  const nextState = deepFreeze({
    ...state,
    participantSeatNumbers: [...state.participantSeatNumbers],
    pot: state.pot + contributionDelta,
    seats,
    bettingRound: {
      currentBet: currentBetAfter,
      minimumFullRaiseIncrement: minimumFullRaiseIncrementAfter,
      seatStates,
    },
  })
  return deepFreeze({
    state: nextState,
    actorSeatNumber: actor.seatNumber,
    action,
    amountToCallBefore: amountToCall,
    contributionDelta,
    targetStreetCommitmentAfter,
    totalContributionAfter: actor.totalContribution + contributionDelta,
    potBefore: state.pot,
    currentBetBefore,
    currentBetAfter,
    minimumFullRaiseIncrementBefore,
    minimumFullRaiseIncrementAfter,
    isVoluntaryPreflopContribution:
      state.street === 'preflop' &&
      ['call', 'bet', 'raise', 'allIn'].includes(action.type),
    isFullRaise,
  })
}

export function verifyBettingActionEvidence(
  state: BettingProjectionState,
  evidence: BettingActionEvidence,
): BettingTransitionProjection {
  const legalActions = getProjectedLegalActions(state)
  const transition = projectBettingTransition(
    state,
    createCommittedActionProof(evidence.action, legalActions),
  )
  if (
    evidence.amountToCallBefore !== transition.amountToCallBefore ||
    evidence.contributionDelta !== transition.contributionDelta ||
    evidence.targetStreetCommitmentAfter !==
      transition.targetStreetCommitmentAfter ||
    evidence.totalContributionAfter !== transition.totalContributionAfter ||
    evidence.potBefore !== transition.potBefore ||
    evidence.currentBetBefore !== transition.currentBetBefore ||
    evidence.currentBetAfter !== transition.currentBetAfter ||
    evidence.minimumFullRaiseIncrementBefore !==
      transition.minimumFullRaiseIncrementBefore ||
    evidence.minimumFullRaiseIncrementAfter !==
      transition.minimumFullRaiseIncrementAfter ||
    evidence.isVoluntaryPreflopContribution !==
      transition.isVoluntaryPreflopContribution ||
    evidence.isFullRaise !== transition.isFullRaise
  ) {
    throw new RangeError('公开下注行动证明与投影不一致。')
  }
  return transition
}

function stillOwesAction(
  seatNumber: number,
  state: BettingProjectionState,
): boolean {
  const seat = state.seats.find(
    (candidate) => candidate.seatNumber === seatNumber,
  )
  const roundState = state.bettingRound.seatStates.find(
    (candidate) => candidate.seatNumber === seatNumber,
  )
  return (
    seat?.status === 'active' &&
    seat.stack > 0 &&
    (roundState?.betLevelAfterLastAction === null ||
      seat.streetContribution < state.bettingRound.currentBet)
  )
}

export function projectActionContinuation(
  stateAfterAction: BettingProjectionState,
  actorSeatNumber: number,
): BettingContinuationProjection {
  assertProjectionState(stateAfterAction, false)
  if (
    !stateAfterAction.participantSeatNumbers.includes(actorSeatNumber) ||
    stateAfterAction.currentActorSeatNumber !== actorSeatNumber
  ) {
    throw new RangeError('下注行动锚点无效。')
  }
  const participants = new Set(stateAfterAction.participantSeatNumbers)
  const contenders = stateAfterAction.seats.filter(
    (seat) =>
      participants.has(seat.seatNumber) &&
      (seat.status === 'active' || seat.status === 'allIn'),
  )
  if (contenders.length === 0) throw new RangeError('手牌不得没有竞争者。')
  if (contenders.length === 1) {
    return deepFreeze({ kind: 'complete', seats: stateAfterAction.seats })
  }
  const actionable = contenders.filter(
    (seat) => seat.status === 'active' && seat.stack > 0,
  )
  if (actionable.length === 0) {
    return deepFreeze({
      kind: 'showdown',
      seats: stateAfterAction.seats,
      forcesRunout: stateAfterAction.street !== 'river',
    })
  }
  if (actionable.length === 1) {
    const onlyActor = actionable[0]!
    const matchableLevel = Math.max(
      ...contenders
        .filter((seat) => seat.seatNumber !== onlyActor.seatNumber)
        .map((seat) => seat.streetContribution),
    )
    if (Math.max(0, matchableLevel - onlyActor.streetContribution) > 0) {
      return deepFreeze({
        kind: 'sameStreet',
        state: {
          ...stateAfterAction,
          currentActorSeatNumber: onlyActor.seatNumber,
        },
      })
    }
    return deepFreeze({
      kind: 'showdown',
      seats: stateAfterAction.seats,
      forcesRunout: stateAfterAction.street !== 'river',
    })
  }
  const nextActorSeatNumber = clockwiseParticipantSeatNumbersAfter(
    actorSeatNumber,
    stateAfterAction.participantSeatNumbers,
  ).find((seatNumber) => stillOwesAction(seatNumber, stateAfterAction))
  if (nextActorSeatNumber !== undefined) {
    return deepFreeze({
      kind: 'sameStreet',
      state: {
        ...stateAfterAction,
        currentActorSeatNumber: nextActorSeatNumber,
      },
    })
  }
  if (stateAfterAction.street === 'river') {
    return deepFreeze({
      kind: 'showdown',
      seats: stateAfterAction.seats,
      forcesRunout: false,
    })
  }
  const nextStreet =
    stateAfterAction.street === 'preflop'
      ? ('flop' as const)
      : stateAfterAction.street === 'flop'
        ? ('turn' as const)
        : stateAfterAction.street === 'turn'
          ? ('river' as const)
          : undefined
  if (nextStreet === undefined) throw new RangeError('下一下注街道无效。')
  const resetSeats = stateAfterAction.seats.map((seat) => ({
    ...seat,
    streetContribution: 0,
  }))
  const firstActor = findPostflopFirstActionableSeatNumber({
    buttonSeatNumber: stateAfterAction.buttonSeatNumber,
    participantSeatNumbers: stateAfterAction.participantSeatNumbers,
    seats: resetSeats,
  })
  if (firstActor === null) throw new RangeError('新街必须存在可行动玩家。')
  return deepFreeze({
    kind: 'nextStreet',
    state: {
      ...stateAfterAction,
      street: nextStreet,
      currentActorSeatNumber: firstActor,
      seats: resetSeats,
      bettingRound: {
        currentBet: 0,
        minimumFullRaiseIncrement: 20,
        seatStates: stateAfterAction.participantSeatNumbers.map(
          (seatNumber) => ({
            seatNumber,
            betLevelAfterLastAction: null,
          }),
        ),
      },
    },
  })
}

export function createInitialBettingProjection(input: {
  readonly buttonSeatNumber: number
  readonly participantSeatNumbers: readonly number[]
  readonly smallBlindSeatNumber: number
  readonly bigBlindSeatNumber: number
  readonly startingStacks: readonly {
    readonly seatNumber: number
    readonly stack: number
  }[]
  readonly nonParticipantSeats?: readonly BettingProjectionSeat[]
}): BettingProjectionState {
  const participantSeatNumbers = [...input.participantSeatNumbers]
  const participantSet = new Set(participantSeatNumbers)
  const expectedBlinds = getBlindSeatNumbers(
    input.buttonSeatNumber,
    participantSeatNumbers,
  )
  if (
    participantSeatNumbers.length < 6 ||
    participantSeatNumbers.length > 9 ||
    participantSet.size !== participantSeatNumbers.length ||
    input.startingStacks.length !== participantSeatNumbers.length ||
    expectedBlinds.smallBlindSeatNumber !== input.smallBlindSeatNumber ||
    expectedBlinds.bigBlindSeatNumber !== input.bigBlindSeatNumber
  ) {
    throw new RangeError('开手下注投影事实无效。')
  }
  const startingStackBySeat = new Map(
    input.startingStacks.map((entry) => [entry.seatNumber, entry.stack]),
  )
  if (
    startingStackBySeat.size !== participantSet.size ||
    [...participantSet].some((seatNumber) => {
      const stack = startingStackBySeat.get(seatNumber)
      return stack === undefined || !Number.isSafeInteger(stack) || stack <= 0
    })
  ) {
    throw new RangeError('开手起始筹码事实无效。')
  }
  const participantSeats = participantSeatNumbers.map((seatNumber) => {
    const startingStack = startingStackBySeat.get(seatNumber)!
    const contribution =
      seatNumber === input.smallBlindSeatNumber
        ? Math.min(startingStack, 10)
        : seatNumber === input.bigBlindSeatNumber
          ? Math.min(startingStack, 20)
          : 0
    const stack = startingStack - contribution
    return {
      seatNumber,
      status: stack === 0 ? ('allIn' as const) : ('active' as const),
      stack,
      streetContribution: contribution,
      totalContribution: contribution,
    }
  })
  const nonParticipantSeats = (input.nonParticipantSeats ?? []).map((seat) => ({
    ...seat,
  }))
  if (
    nonParticipantSeats.some(
      (seat) =>
        participantSet.has(seat.seatNumber) ||
        seat.status !== 'out' ||
        seat.streetContribution !== 0 ||
        seat.totalContribution !== 0,
    )
  ) {
    throw new RangeError('非参与座位事实无效。')
  }
  const seats = [...participantSeats, ...nonParticipantSeats].sort(
    (left, right) => left.seatNumber - right.seatNumber,
  )
  const currentActorSeatNumber = findPreflopFirstActionableSeatNumber({
    buttonSeatNumber: input.buttonSeatNumber,
    participantSeatNumbers,
    seats: participantSeats,
  })
  if (currentActorSeatNumber === null) {
    throw new RangeError('开手必须存在首个可行动座位。')
  }
  const state = {
    buttonSeatNumber: input.buttonSeatNumber,
    participantSeatNumbers,
    street: 'preflop' as const,
    currentActorSeatNumber,
    pot: participantSeats.reduce(
      (total, seat) => total + seat.totalContribution,
      0,
    ),
    seats,
    bettingRound: {
      currentBet: 20,
      minimumFullRaiseIncrement: 20,
      seatStates: participantSeatNumbers.map((seatNumber) => ({
        seatNumber,
        betLevelAfterLastAction: null,
      })),
    },
  }
  assertProjectionState(state)
  return deepFreeze(state)
}
