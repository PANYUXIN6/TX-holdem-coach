import {
  LegalActionsSchema,
  type LegalAction,
  type LegalActions,
  type SuggestedTarget,
} from '@tx-holdem-coach/contracts'
import { PokerCommandSchema, type PokerCommand } from './commands.js'
import type { PokerState } from './state.js'

const ACTION_STREETS = new Set(['preflop', 'flop', 'turn', 'river'])

interface BettingContext {
  readonly hand: NonNullable<PokerState['hand']>
  readonly bettingRound: NonNullable<
    NonNullable<PokerState['hand']>['bettingRound']
  >
  readonly actor: PokerState['seats'][number]
  readonly betLevelAfterLastAction: number | null
}

type BettingRound = NonNullable<NonNullable<PokerState['hand']>['bettingRound']>

export interface BettingTransitionResult {
  readonly actorSeatNumber: number
  readonly action: PokerCommand['action']
  readonly contributionDelta: number
  readonly seats: PokerState['seats']
  readonly pot: number
  readonly bettingRound: BettingRound
}

function getBettingContext(state: PokerState): BettingContext {
  const hand = state.hand

  if (
    state.pokerPhase !== 'inHand' ||
    hand === null ||
    !ACTION_STREETS.has(hand.street) ||
    hand.bettingRound === null ||
    hand.currentActorSeatNumber === null
  ) {
    throw new RangeError('只有稳定下注街道才能生成或执行动作。')
  }

  const actor = state.seats.find(
    (seat) => seat.seatNumber === hand.currentActorSeatNumber,
  )
  const actorRoundState = hand.bettingRound.seatStates.find(
    (seatState) => seatState.seatNumber === hand.currentActorSeatNumber,
  )

  if (
    actor === undefined ||
    actorRoundState === undefined ||
    actor.status !== 'active' ||
    actor.stack <= 0
  ) {
    throw new RangeError('当前行动者必须是仍有筹码的参与座位。')
  }

  if (actor.streetContribution > hand.bettingRound.currentBet) {
    throw new RangeError('行动者本街投入不得高于当前下注。')
  }

  const totalContributions = state.seats.reduce(
    (total, seat) => total + seat.totalContribution,
    0,
  )
  if (hand.pot !== totalContributions) {
    throw new RangeError('下注街道底池必须等于全部座位的本手总投入。')
  }

  return {
    hand,
    bettingRound: hand.bettingRound,
    actor,
    betLevelAfterLastAction: actorRoundState.betLevelAfterLastAction,
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
  const suggestedTargets: SuggestedTarget[] = []

  for (const candidate of candidates) {
    const targetStreetCommitment = clamp(
      candidate.targetStreetCommitment,
      minTarget,
      maxTarget,
    )

    if (seenTargets.has(targetStreetCommitment)) {
      continue
    }

    seenTargets.add(targetStreetCommitment)
    suggestedTargets.push({
      kind: candidate.kind,
      targetStreetCommitment,
    })
  }

  return suggestedTargets
}

export function getLegalActions(state: PokerState): LegalActions {
  const { hand, bettingRound, actor, betLevelAfterLastAction } =
    getBettingContext(state)
  const callAmount = bettingRound.currentBet - actor.streetContribution
  const allInTarget = actor.streetContribution + actor.stack
  const ordinaryMaxTarget = allInTarget - 1
  const minTarget =
    bettingRound.currentBet === 0
      ? 20
      : bettingRound.currentBet + bettingRound.minimumFullRaiseIncrement
  const raiseReopened =
    betLevelAfterLastAction === null ||
    bettingRound.currentBet - betLevelAfterLastAction >=
      bettingRound.minimumFullRaiseIncrement
  const actions: unknown[] = [{ type: 'fold' }]

  if (callAmount === 0) {
    actions.push({ type: 'check' })
  } else if (callAmount < actor.stack) {
    actions.push({ type: 'call', amount: callAmount })
  }

  const canMakeOrdinaryAggressiveAction =
    minTarget <= ordinaryMaxTarget &&
    (bettingRound.currentBet === 0 || raiseReopened)

  if (canMakeOrdinaryAggressiveAction) {
    actions.push({
      type: bettingRound.currentBet === 0 ? 'bet' : 'raise',
      minTarget,
      maxTarget: ordinaryMaxTarget,
      suggestedTargets: createSuggestedTargets(
        bettingRound.currentBet,
        callAmount,
        hand.pot,
        minTarget,
        ordinaryMaxTarget,
      ),
    })
  }

  if (actor.stack <= callAmount || raiseReopened) {
    actions.push({ type: 'allIn', target: allInTarget })
  }

  return LegalActionsSchema.parse(actions)
}

function assertActionIsLegal(
  action: PokerCommand['action'],
  legalActions: LegalActions,
): void {
  if (action.type === 'bet' || action.type === 'raise') {
    const legalAction = legalActions.find(
      (
        candidate,
      ): candidate is Extract<LegalAction, { type: typeof action.type }> =>
        candidate.type === action.type,
    )

    if (
      legalAction === undefined ||
      action.targetStreetCommitment < legalAction.minTarget ||
      action.targetStreetCommitment > legalAction.maxTarget
    ) {
      throw new RangeError('下注或加注目标超出合法普通区间。')
    }

    return
  }

  if (!legalActions.some((legalAction) => legalAction.type === action.type)) {
    throw new RangeError('当前动作不合法。')
  }
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const nestedValue of Object.values(value)) {
      deepFreeze(nestedValue)
    }

    Object.freeze(value)
  }

  return value
}

export function applyBettingAction(
  state: PokerState,
  command: PokerCommand,
): BettingTransitionResult {
  const parsedCommand = PokerCommandSchema.parse(command)
  const { hand, bettingRound, actor } = getBettingContext(state)

  if (parsedCommand.actorSeatNumber !== hand.currentActorSeatNumber) {
    throw new RangeError('命令行动者必须等于当前行动者。')
  }

  const legalActions = getLegalActions(state)
  assertActionIsLegal(parsedCommand.action, legalActions)

  const previousCurrentBet = bettingRound.currentBet
  const previousMinimumFullRaiseIncrement =
    bettingRound.minimumFullRaiseIncrement
  let contributionDelta = 0

  switch (parsedCommand.action.type) {
    case 'call':
      contributionDelta = previousCurrentBet - actor.streetContribution
      break
    case 'bet':
    case 'raise':
      contributionDelta =
        parsedCommand.action.targetStreetCommitment - actor.streetContribution
      break
    case 'allIn':
      contributionDelta = actor.stack
      break
    case 'check':
    case 'fold':
      break
  }

  const allInTarget = actor.streetContribution + actor.stack
  let currentBet = previousCurrentBet

  if (
    parsedCommand.action.type === 'bet' ||
    parsedCommand.action.type === 'raise'
  ) {
    currentBet = parsedCommand.action.targetStreetCommitment
  } else if (
    parsedCommand.action.type === 'allIn' &&
    allInTarget > currentBet
  ) {
    currentBet = allInTarget
  }

  const betLevelIncrease = currentBet - previousCurrentBet
  const minimumFullRaiseIncrement =
    betLevelIncrease >= previousMinimumFullRaiseIncrement
      ? betLevelIncrease
      : previousMinimumFullRaiseIncrement
  const remainingStack = actor.stack - contributionDelta
  const actorAfter = {
    ...actor,
    stack: remainingStack,
    status:
      parsedCommand.action.type === 'fold'
        ? ('folded' as const)
        : parsedCommand.action.type === 'allIn'
          ? ('allIn' as const)
          : ('active' as const),
    streetContribution: actor.streetContribution + contributionDelta,
    totalContribution: actor.totalContribution + contributionDelta,
  }
  const seats = state.seats.map((seat) =>
    seat.seatNumber === actor.seatNumber ? actorAfter : seat,
  )
  const seatStates = bettingRound.seatStates.map((seatState) =>
    seatState.seatNumber === actor.seatNumber
      ? {
          ...seatState,
          betLevelAfterLastAction: currentBet,
        }
      : seatState,
  )

  return deepFreeze({
    actorSeatNumber: actor.seatNumber,
    action: parsedCommand.action,
    contributionDelta,
    seats,
    pot: hand.pot + contributionDelta,
    bettingRound: {
      currentBet,
      minimumFullRaiseIncrement,
      seatStates,
    },
  })
}
