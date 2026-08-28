import { isDeepStrictEqual } from 'node:util'
import type { LedgerCommand } from '../../persistence/command-ledger-repository.js'
import type { CompletedHandResult } from '../../poker/hand-result.js'
import type { PrivateEvent } from '../authoritative-state/private-event.js'
import type { PrivateTableState } from '../authoritative-state/private-table-state.js'
import { getPrivateEventHandId } from '../authoritative-state/private-event.js'
import { parseEndSessionRelationPlan } from './end-session-handler.js'
import { parsePlayerActionRelationPlan } from './player-action-handler.js'
import { parseRebuyRelationPlan } from './rebuy-handler.js'
import { parseRetryAgentRelationPlan } from '../../agents/player/retry-agent-handler.js'
import { parseStartNextHandRelationPlan } from './start-next-hand-handler.js'

function isEventSequenceAllowedForCommand(
  commandType: LedgerCommand['type'],
  events: readonly PrivateEvent[],
): boolean {
  if (events.length === 0) return false
  switch (commandType) {
    case 'playerAction':
    case 'aiAction':
      return (
        (events.length === 1 && events[0]?.type === 'actionCommitted') ||
        (events.length === 2 &&
          events[0]?.type === 'actionCommitted' &&
          events[1]?.type === 'handCompleted') ||
        (events.length === 3 &&
          events[0]?.type === 'actionCommitted' &&
          events[1]?.type === 'uncalledBetReturned' &&
          events[2]?.type === 'handCompleted')
      )
    case 'startNextHand':
      return (
        events.length <= 9 &&
        events.at(-1)?.type === 'handStarted' &&
        events.slice(0, -1).every((event) => event.type === 'aiAutoRebuy')
      )
    case 'rebuy':
      return events.length === 1 && events[0]?.type === 'userRebuy'
    case 'endSession':
      return (
        (events.length === 1 &&
          events[0]?.type === 'sessionEnded' &&
          events[0].reason === 'userRequested') ||
        (events.length === 2 &&
          events[0]?.type === 'handAborted' &&
          events[1]?.type === 'sessionEnded' &&
          events[1].reason === 'handAborted')
      )
    case 'retryAgent':
      return events.length === 1 && events[0]?.type === 'agentStarted'
  }
}

export interface CommandMutationConsistencyInput {
  readonly command: LedgerCommand
  readonly sessionBefore: {
    readonly lifecycleStatus: 'active'
    readonly currentHandId: string | null
    readonly agentRunState: 'idle' | 'thinking' | 'paused'
    readonly activePlayerRunId: string | null
    readonly activeDecisionRequestId: string | null
  }
  readonly stateEffectKind: 'stateChanged' | 'stateUnchanged'
  readonly stateBefore: PrivateTableState
  readonly stateAfter: PrivateTableState
  readonly lifecycleAfter: 'active' | 'ended'
  readonly currentHandIdAfter: string | null
  readonly playerCoordinationAfter: {
    readonly agentRunState: 'idle' | 'thinking' | 'paused'
    readonly activePlayerRunId: string | null
    readonly activeDecisionRequestId: string | null
  }
  readonly events: readonly PrivateEvent[]
  readonly relationPlan: unknown
}

function equalValue(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right)
}

function stateContentEquals(
  left: PrivateTableState,
  right: PrivateTableState,
): boolean {
  return (
    equalValue(left.poker, right.poker) &&
    left.completedHandCount === right.completedHandCount &&
    equalValue(left.seatAccounting, right.seatAccounting) &&
    equalValue(left.lastCompletedHandSummary, right.lastCompletedHandSummary)
  )
}

function haveSameSeatNumberSet(
  reference: readonly { readonly seatNumber: number }[],
  ...others: readonly (readonly { readonly seatNumber: number }[])[]
): boolean {
  const referenceSeatNumbers = new Set(reference.map((seat) => seat.seatNumber))
  return others.every(
    (seats) =>
      seats.length === reference.length &&
      new Set(seats.map((seat) => seat.seatNumber)).size ===
        referenceSeatNumbers.size &&
      seats.every((seat) => referenceSeatNumbers.has(seat.seatNumber)),
  )
}

function rebuyMirrors(input: CommandMutationConsistencyInput): boolean {
  const event = input.events[0]
  const relationPlan = parseRebuyRelationPlan(input.relationPlan)
  if (
    input.stateEffectKind !== 'stateChanged' ||
    input.lifecycleAfter !== 'active' ||
    input.currentHandIdAfter !== null ||
    input.stateBefore.poker.pokerPhase !== 'betweenHands' ||
    input.stateAfter.poker.pokerPhase !== 'betweenHands' ||
    event?.type !== 'userRebuy' ||
    input.command.type !== 'rebuy' ||
    relationPlan === null ||
    input.sessionBefore.lifecycleStatus !== 'active' ||
    input.sessionBefore.currentHandId !== null ||
    input.sessionBefore.agentRunState !== 'idle' ||
    input.sessionBefore.activePlayerRunId !== null ||
    input.sessionBefore.activeDecisionRequestId !== null ||
    input.playerCoordinationAfter.agentRunState !== 'idle' ||
    input.playerCoordinationAfter.activePlayerRunId !== null ||
    input.playerCoordinationAfter.activeDecisionRequestId !== null ||
    event.amount !== input.command.payload.amount ||
    input.stateBefore.completedHandCount !==
      input.stateAfter.completedHandCount ||
    !equalValue(
      input.stateBefore.lastCompletedHandSummary,
      input.stateAfter.lastCompletedHandSummary,
    ) ||
    input.stateBefore.poker.buttonSeatNumber !==
      input.stateAfter.poker.buttonSeatNumber ||
    !equalValue(input.stateBefore.poker.blinds, input.stateAfter.poker.blinds)
  ) {
    return false
  }
  const beforeAccountingBySeat = new Map(
    input.stateBefore.seatAccounting.map((seat) => [
      seat.seatNumber,
      seat.cumulativeBuyIn,
    ]),
  )
  const afterAccountingBySeat = new Map(
    input.stateAfter.seatAccounting.map((seat) => [
      seat.seatNumber,
      seat.cumulativeBuyIn,
    ]),
  )
  if (
    !haveSameSeatNumberSet(
      input.stateBefore.poker.seats,
      input.stateAfter.poker.seats,
      input.stateBefore.seatAccounting,
      input.stateAfter.seatAccounting,
    ) ||
    beforeAccountingBySeat.get(0) !== event.cumulativeBuyInBefore ||
    afterAccountingBySeat.get(0) !== event.cumulativeBuyInAfter
  ) {
    return false
  }
  const afterSeatByNumber = new Map(
    input.stateAfter.poker.seats.map((seat) => [seat.seatNumber, seat]),
  )
  return input.stateBefore.poker.seats.every((beforeSeat) => {
    const afterSeat = afterSeatByNumber.get(beforeSeat.seatNumber)
    if (afterSeat === undefined) return false
    if (beforeSeat.seatNumber === 0) {
      return (
        (beforeSeat.stack === 0
          ? event.amount === 2_000
          : beforeSeat.stack < 2_000 &&
            event.amount <= 2_000 - beforeSeat.stack) &&
        beforeSeat.stack === event.stackBefore &&
        afterSeat.stack === event.stackAfter &&
        afterSeat.status === 'active' &&
        equalValue(
          { ...beforeSeat, stack: event.stackAfter, status: 'active' },
          afterSeat,
        )
      )
    }
    return (
      equalValue(beforeSeat, afterSeat) &&
      beforeAccountingBySeat.get(beforeSeat.seatNumber) ===
        afterAccountingBySeat.get(beforeSeat.seatNumber)
    )
  })
}

function startNextHandMirrors(input: CommandMutationConsistencyInput): boolean {
  const plan = parseStartNextHandRelationPlan(input.relationPlan)
  const handStarted = input.events.at(-1)
  const beforeHand = input.stateBefore.poker.hand
  const afterHand = input.stateAfter.poker.hand
  if (
    input.command.type !== 'startNextHand' ||
    plan === null ||
    input.stateEffectKind !== 'stateChanged' ||
    input.lifecycleAfter !== 'active' ||
    input.stateBefore.poker.pokerPhase !== 'betweenHands' ||
    beforeHand !== null ||
    input.stateAfter.poker.pokerPhase !== 'inHand' ||
    afterHand === null ||
    input.stateBefore.completedHandCount < 1 ||
    input.stateBefore.completedHandCount !==
      input.stateAfter.completedHandCount ||
    !equalValue(
      input.stateBefore.lastCompletedHandSummary,
      input.stateAfter.lastCompletedHandSummary,
    ) ||
    input.sessionBefore.currentHandId !== null ||
    input.sessionBefore.agentRunState !== 'idle' ||
    input.sessionBefore.activePlayerRunId !== null ||
    input.sessionBefore.activeDecisionRequestId !== null ||
    input.playerCoordinationAfter.agentRunState !== 'idle' ||
    input.playerCoordinationAfter.activePlayerRunId !== null ||
    input.playerCoordinationAfter.activeDecisionRequestId !== null ||
    handStarted?.type !== 'handStarted' ||
    plan.sessionId.toLowerCase() !== input.command.sessionId.toLowerCase() ||
    plan.handId.toLowerCase() !==
      handStarted.startedHand.handId.toLowerCase() ||
    plan.handId.toLowerCase() !== afterHand.handId.toLowerCase() ||
    input.currentHandIdAfter?.toLowerCase() !== plan.handId.toLowerCase() ||
    !equalValue(plan.checkpoint.stateBeforeStartCommand, input.stateBefore) ||
    !equalValue(plan.checkpoint.startedHand, handStarted.startedHand) ||
    handStarted.startedHand.handNumber !==
      input.stateBefore.completedHandCount + 1 ||
    handStarted.startedHand.buttonSeatNumber !==
      input.stateAfter.poker.buttonSeatNumber ||
    !haveSameSeatNumberSet(
      input.stateBefore.poker.seats,
      input.stateAfter.poker.seats,
      input.stateBefore.seatAccounting,
      input.stateAfter.seatAccounting,
      handStarted.startedHand.startingStacks,
    )
  ) {
    return false
  }

  const afterSeatByNumber = new Map(
    input.stateAfter.poker.seats.map((seat) => [seat.seatNumber, seat]),
  )
  const beforeAccountingBySeat = new Map(
    input.stateBefore.seatAccounting.map((seat) => [
      seat.seatNumber,
      seat.cumulativeBuyIn,
    ]),
  )
  const afterAccountingBySeat = new Map(
    input.stateAfter.seatAccounting.map((seat) => [
      seat.seatNumber,
      seat.cumulativeBuyIn,
    ]),
  )
  const startingStackBySeat = new Map(
    handStarted.startedHand.startingStacks.map((seat) => [
      seat.seatNumber,
      seat.stack,
    ]),
  )
  const expectedAutoRebuySeats = input.stateBefore.poker.seats
    .filter((seat) => !seat.isUser && seat.stack === 0)
    .map((seat) => seat.seatNumber)
    .sort((left, right) => left - right)
  const autoRebuyEvents = input.events.slice(0, -1)
  if (
    autoRebuyEvents.length !== expectedAutoRebuySeats.length ||
    autoRebuyEvents.some(
      (event, index) =>
        event.type !== 'aiAutoRebuy' ||
        event.seatNumber !== expectedAutoRebuySeats[index],
    )
  ) {
    return false
  }

  return input.stateBefore.poker.seats.every((beforeSeat) => {
    const afterSeat = afterSeatByNumber.get(beforeSeat.seatNumber)
    const beforeAccounting = beforeAccountingBySeat.get(beforeSeat.seatNumber)
    const afterAccounting = afterAccountingBySeat.get(beforeSeat.seatNumber)
    const startingStack = startingStackBySeat.get(beforeSeat.seatNumber)
    if (
      afterSeat === undefined ||
      beforeAccounting === undefined ||
      afterAccounting === undefined ||
      startingStack === undefined ||
      afterSeat.playerId !== beforeSeat.playerId ||
      afterSeat.isUser !== beforeSeat.isUser ||
      afterSeat.stack + afterSeat.totalContribution !== startingStack
    ) {
      return false
    }
    const autoRebuyEvent = autoRebuyEvents.find(
      (event) =>
        event.type === 'aiAutoRebuy' &&
        event.seatNumber === beforeSeat.seatNumber,
    )
    if (autoRebuyEvent?.type === 'aiAutoRebuy') {
      return (
        beforeSeat.stack === 0 &&
        !beforeSeat.isUser &&
        startingStack === 2_000 &&
        autoRebuyEvent.amount === 2_000 &&
        autoRebuyEvent.stackBefore === 0 &&
        autoRebuyEvent.stackAfter === 2_000 &&
        autoRebuyEvent.cumulativeBuyInBefore === beforeAccounting &&
        autoRebuyEvent.cumulativeBuyInAfter === afterAccounting
      )
    }
    return (
      beforeSeat.stack > 0 &&
      startingStack === beforeSeat.stack &&
      afterAccounting === beforeAccounting
    )
  })
}

function endSessionMirrors(input: CommandMutationConsistencyInput): boolean {
  const relationPlan = parseEndSessionRelationPlan(input.relationPlan)
  if (input.lifecycleAfter !== 'ended' || input.currentHandIdAfter !== null) {
    return false
  }
  if (input.events.length === 1) {
    const event = input.events[0]
    return (
      event?.type === 'sessionEnded' &&
      event.reason === 'userRequested' &&
      relationPlan?.kind === 'normalEnd' &&
      input.stateEffectKind === 'stateUnchanged' &&
      input.stateBefore.poker.pokerPhase === 'betweenHands' &&
      input.sessionBefore.currentHandId === null &&
      input.sessionBefore.agentRunState === 'idle' &&
      input.sessionBefore.activePlayerRunId === null &&
      input.sessionBefore.activeDecisionRequestId === null &&
      stateContentEquals(input.stateBefore, input.stateAfter)
    )
  }
  const aborted = input.events[0]
  const ended = input.events[1]
  const beforeHand = input.stateBefore.poker.hand
  if (
    relationPlan?.kind !== 'abortHand' ||
    aborted?.type !== 'handAborted' ||
    ended?.type !== 'sessionEnded' ||
    ended.reason !== 'handAborted' ||
    input.stateEffectKind !== 'stateChanged' ||
    input.stateBefore.poker.pokerPhase !== 'inHand' ||
    beforeHand === null ||
    input.stateAfter.poker.pokerPhase !== 'betweenHands' ||
    input.stateAfter.poker.hand !== null ||
    input.sessionBefore.agentRunState !== 'paused' ||
    input.sessionBefore.activePlayerRunId !== null ||
    input.sessionBefore.activeDecisionRequestId !== null ||
    input.sessionBefore.currentHandId?.toLowerCase() !==
      beforeHand.handId.toLowerCase() ||
    relationPlan.sessionId.toLowerCase() !==
      input.command.sessionId.toLowerCase() ||
    relationPlan.handId.toLowerCase() !== beforeHand.handId.toLowerCase() ||
    aborted.handId.toLowerCase() !== beforeHand.handId.toLowerCase() ||
    relationPlan.checkpoint.startedHand.handId.toLowerCase() !==
      beforeHand.handId.toLowerCase() ||
    !stateContentEquals(
      relationPlan.checkpoint.stateBeforeStartCommand,
      input.stateAfter,
    ) ||
    input.stateBefore.completedHandCount !==
      input.stateAfter.completedHandCount ||
    !equalValue(
      input.stateBefore.lastCompletedHandSummary,
      input.stateAfter.lastCompletedHandSummary,
    )
  ) {
    return false
  }
  const beforeAbort = {
    buttonSeatNumber: input.stateBefore.poker.buttonSeatNumber,
    completedHandCount: input.stateBefore.completedHandCount,
    pot: beforeHand.pot,
    seats: [...input.stateBefore.poker.seats]
      .sort((left, right) => left.seatNumber - right.seatNumber)
      .map((seat) => ({
        seatNumber: seat.seatNumber,
        stack: seat.stack,
        cumulativeBuyIn: input.stateBefore.seatAccounting.find(
          (accounting) => accounting.seatNumber === seat.seatNumber,
        )?.cumulativeBuyIn,
      })),
  }
  const restored = {
    buttonSeatNumber: input.stateAfter.poker.buttonSeatNumber,
    completedHandCount: input.stateAfter.completedHandCount,
    seats: [...input.stateAfter.poker.seats]
      .sort((left, right) => left.seatNumber - right.seatNumber)
      .map((seat) => ({
        seatNumber: seat.seatNumber,
        stack: seat.stack,
        cumulativeBuyIn: input.stateAfter.seatAccounting.find(
          (accounting) => accounting.seatNumber === seat.seatNumber,
        )?.cumulativeBuyIn,
      })),
  }
  return (
    equalValue(aborted.beforeAbort, beforeAbort) &&
    equalValue(aborted.restored, restored)
  )
}

function actionSnapshotMirrors(
  snapshot: Extract<PrivateEvent, { type: 'actionCommitted' }>['before'],
  state: PrivateTableState['poker'],
): boolean {
  const hand = state.hand
  return (
    hand !== null &&
    snapshot.street === hand.street &&
    equalValue(snapshot.board, hand.board) &&
    snapshot.currentActorSeatNumber === hand.currentActorSeatNumber &&
    snapshot.pot === hand.pot &&
    equalValue(
      snapshot.seats,
      state.seats.map((seat) => ({
        seatNumber: seat.seatNumber,
        status: seat.status,
        stack: seat.stack,
        streetContribution: seat.streetContribution,
        totalContribution: seat.totalContribution,
      })),
    )
  )
}

function rosterAndTableMirrors(
  before: PrivateTableState,
  after: PrivateTableState,
): boolean {
  return (
    before.poker.buttonSeatNumber === after.poker.buttonSeatNumber &&
    equalValue(before.poker.blinds, after.poker.blinds) &&
    haveSameSeatNumberSet(
      before.poker.seats,
      after.poker.seats,
      before.seatAccounting,
      after.seatAccounting,
    ) &&
    before.poker.seats.every((beforeSeat) => {
      const afterSeat = after.poker.seats.find(
        (seat) => seat.seatNumber === beforeSeat.seatNumber,
      )
      return (
        afterSeat !== undefined &&
        afterSeat.playerId === beforeSeat.playerId &&
        afterSeat.isUser === beforeSeat.isUser
      )
    }) &&
    equalValue(before.seatAccounting, after.seatAccounting)
  )
}

function terminalActionSnapshotMirrors(
  event: Extract<PrivateEvent, { type: 'actionCommitted' }>,
  result: CompletedHandResult,
): boolean {
  const beforeBySeat = new Map(
    event.before.seats.map((seat) => [seat.seatNumber, seat]),
  )
  const resultBySeat = new Map(
    result.seats.map((seat) => [seat.seatNumber, seat]),
  )
  const expectedActorStatus =
    event.command.action.type === 'fold'
      ? 'folded'
      : event.command.action.type === 'allIn'
        ? 'allIn'
        : 'active'
  return (
    event.after.street === result.terminationReason &&
    event.after.currentActorSeatNumber === null &&
    equalValue(event.after.board, result.board) &&
    event.after.pot ===
      result.seats.reduce((total, seat) => total + seat.totalContribution, 0) &&
    event.after.seats.length === result.seats.length &&
    event.after.seats.every((afterSeat) => {
      const beforeSeat = beforeBySeat.get(afterSeat.seatNumber)
      const resultSeat = resultBySeat.get(afterSeat.seatNumber)
      if (beforeSeat === undefined || resultSeat === undefined) return false
      const contributionDelta =
        resultSeat.totalContribution - beforeSeat.totalContribution
      return (
        contributionDelta >= 0 &&
        afterSeat.totalContribution === resultSeat.totalContribution &&
        afterSeat.streetContribution ===
          beforeSeat.streetContribution + contributionDelta &&
        afterSeat.stack === beforeSeat.stack - contributionDelta &&
        afterSeat.status ===
          (afterSeat.seatNumber === event.actorSeatNumber
            ? expectedActorStatus
            : beforeSeat.status)
      )
    })
  )
}

function pokerActionMirrors(input: CommandMutationConsistencyInput): boolean {
  const beforeHand = input.stateBefore.poker.hand
  const actionEvent = input.events[0]
  const relationPlan = parsePlayerActionRelationPlan(input.relationPlan)
  const actorSeatNumber =
    input.command.type === 'playerAction'
      ? 0
      : input.command.type === 'aiAction'
        ? input.command.payload.actorSeatNumber
        : null
  const action =
    input.command.type === 'playerAction' || input.command.type === 'aiAction'
      ? input.command.payload.action
      : null
  const validCoordinationBefore =
    input.command.type === 'playerAction'
      ? input.sessionBefore.agentRunState === 'idle' &&
        input.sessionBefore.activePlayerRunId === null &&
        input.sessionBefore.activeDecisionRequestId === null
      : input.command.type === 'aiAction'
        ? input.sessionBefore.agentRunState === 'thinking' &&
          input.sessionBefore.activePlayerRunId !== null &&
          input.sessionBefore.activeDecisionRequestId !== null
        : false
  if (
    (input.command.type !== 'playerAction' &&
      input.command.type !== 'aiAction') ||
    input.stateEffectKind !== 'stateChanged' ||
    input.lifecycleAfter !== 'active' ||
    input.stateBefore.poker.pokerPhase !== 'inHand' ||
    beforeHand === null ||
    actionEvent?.type !== 'actionCommitted' ||
    relationPlan === null ||
    actorSeatNumber === null ||
    action === null ||
    beforeHand.currentActorSeatNumber !== actorSeatNumber ||
    actionEvent.actorSeatNumber !== beforeHand.currentActorSeatNumber ||
    actionEvent.handId.toLowerCase() !== beforeHand.handId.toLowerCase() ||
    !equalValue(actionEvent.command, { actorSeatNumber, action }) ||
    !validCoordinationBefore ||
    input.playerCoordinationAfter.agentRunState !== 'idle' ||
    input.playerCoordinationAfter.activePlayerRunId !== null ||
    input.playerCoordinationAfter.activeDecisionRequestId !== null ||
    !actionSnapshotMirrors(actionEvent.before, input.stateBefore.poker) ||
    !rosterAndTableMirrors(input.stateBefore, input.stateAfter) ||
    input.events.some(
      (event) =>
        getPrivateEventHandId(event)?.toLowerCase() !==
        beforeHand.handId.toLowerCase(),
    )
  ) {
    return false
  }

  if (input.events.length === 1) {
    const afterHand = input.stateAfter.poker.hand
    return (
      relationPlan.kind === 'continueHand' &&
      relationPlan.handId.toLowerCase() === beforeHand.handId.toLowerCase() &&
      input.stateAfter.poker.pokerPhase === 'inHand' &&
      afterHand !== null &&
      afterHand.handId.toLowerCase() === beforeHand.handId.toLowerCase() &&
      input.currentHandIdAfter?.toLowerCase() ===
        beforeHand.handId.toLowerCase() &&
      input.stateAfter.completedHandCount ===
        input.stateBefore.completedHandCount &&
      equalValue(
        input.stateAfter.lastCompletedHandSummary,
        input.stateBefore.lastCompletedHandSummary,
      ) &&
      actionSnapshotMirrors(actionEvent.after, input.stateAfter.poker)
    )
  }

  const completionEvent = input.events.at(-1)
  const possibleReturnEvent = input.events[1]
  const returnEvent =
    possibleReturnEvent?.type === 'uncalledBetReturned'
      ? possibleReturnEvent
      : null
  if (
    relationPlan.kind !== 'completeHand' ||
    completionEvent?.type !== 'handCompleted' ||
    (input.events.length === 3 && returnEvent === null) ||
    input.stateAfter.poker.pokerPhase !== 'betweenHands' ||
    input.stateAfter.poker.hand !== null ||
    input.currentHandIdAfter !== null ||
    relationPlan.sessionId.toLowerCase() !==
      input.command.sessionId.toLowerCase() ||
    relationPlan.handId.toLowerCase() !== beforeHand.handId.toLowerCase() ||
    relationPlan.result.handId.toLowerCase() !==
      beforeHand.handId.toLowerCase() ||
    input.stateAfter.completedHandCount !==
      input.stateBefore.completedHandCount + 1 ||
    !Number.isSafeInteger(input.stateAfter.completedHandCount) ||
    !terminalActionSnapshotMirrors(actionEvent, relationPlan.result) ||
    actionEvent.progression.terminationReason !==
      relationPlan.result.terminationReason ||
    completionEvent.terminationReason !==
      relationPlan.result.terminationReason ||
    !equalValue(completionEvent.summary, relationPlan.result.summary) ||
    !equalValue(
      input.stateAfter.lastCompletedHandSummary,
      relationPlan.result.summary,
    ) ||
    !equalValue(
      returnEvent?.returns ?? [],
      relationPlan.result.uncalledBetReturns,
    )
  ) {
    return false
  }

  return relationPlan.result.seats.every((resultSeat) => {
    const finalSeat = input.stateAfter.poker.seats.find(
      (seat) => seat.seatNumber === resultSeat.seatNumber,
    )
    return (
      finalSeat !== undefined &&
      finalSeat.playerId === resultSeat.playerId &&
      finalSeat.isUser === resultSeat.isUser &&
      finalSeat.stack === resultSeat.endingStack &&
      finalSeat.streetContribution === 0 &&
      finalSeat.totalContribution === 0
    )
  })
}

function retryAgentMirrors(input: CommandMutationConsistencyInput): boolean {
  const event = input.events[0]
  const plan = parseRetryAgentRelationPlan(input.relationPlan)
  const hand = input.stateBefore.poker.hand
  const actorSeatNumber = hand?.currentActorSeatNumber
  const actor =
    typeof actorSeatNumber === 'number'
      ? input.stateBefore.poker.seats.find(
          (seat) => seat.seatNumber === actorSeatNumber && !seat.isUser,
        )
      : undefined
  return (
    input.command.type === 'retryAgent' &&
    plan !== null &&
    input.stateEffectKind === 'stateUnchanged' &&
    stateContentEquals(input.stateBefore, input.stateAfter) &&
    input.lifecycleAfter === 'active' &&
    input.stateBefore.poker.pokerPhase === 'inHand' &&
    hand !== null &&
    typeof actorSeatNumber === 'number' &&
    actorSeatNumber >= 1 &&
    actorSeatNumber <= 8 &&
    actor !== undefined &&
    input.sessionBefore.agentRunState === 'paused' &&
    input.sessionBefore.activePlayerRunId === null &&
    input.sessionBefore.activeDecisionRequestId === null &&
    input.currentHandIdAfter?.toLowerCase() === hand.handId.toLowerCase() &&
    input.playerCoordinationAfter.agentRunState === 'thinking' &&
    input.playerCoordinationAfter.activePlayerRunId?.toLowerCase() ===
      plan.agentRunId.toLowerCase() &&
    input.playerCoordinationAfter.activeDecisionRequestId?.toLowerCase() ===
      plan.decisionRequestId.toLowerCase() &&
    event?.type === 'agentStarted' &&
    event.handId.toLowerCase() === hand.handId.toLowerCase() &&
    event.agentRunId.toLowerCase() === plan.agentRunId.toLowerCase() &&
    event.decisionRequestId.toLowerCase() ===
      plan.decisionRequestId.toLowerCase() &&
    event.actorSeatNumber === actorSeatNumber &&
    event.trigger === 'manualRetry' &&
    event.supersedesRunId?.toLowerCase() ===
      plan.predecessorRunId.toLowerCase() &&
    plan.sessionId.toLowerCase() === input.command.sessionId.toLowerCase() &&
    plan.handId.toLowerCase() === hand.handId.toLowerCase() &&
    plan.actorParticipantId.toLowerCase() === actor.playerId.toLowerCase() &&
    plan.sourceStateVersion === input.stateBefore.stateVersion
  )
}

export function isCommandMutationConsistent(
  input: CommandMutationConsistencyInput,
): boolean {
  const stateVersionDelta = input.stateEffectKind === 'stateChanged' ? 1 : 0
  if (
    input.sessionBefore.lifecycleStatus !== 'active' ||
    input.stateAfter.stateVersion !==
      input.stateBefore.stateVersion + stateVersionDelta ||
    !Number.isSafeInteger(input.stateAfter.stateVersion)
  ) {
    return false
  }
  if (!isEventSequenceAllowedForCommand(input.command.type, input.events)) {
    return false
  }
  switch (input.command.type) {
    case 'startNextHand':
      return startNextHandMirrors(input)
    case 'rebuy':
      return rebuyMirrors(input)
    case 'endSession':
      return endSessionMirrors(input)
    case 'retryAgent':
      return retryAgentMirrors(input)
    case 'playerAction':
    case 'aiAction':
      return pokerActionMirrors(input)
  }
}
