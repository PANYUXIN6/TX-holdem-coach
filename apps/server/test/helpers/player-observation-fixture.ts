import { STANDARD_DECK } from '../../src/poker/cards.js'
import { getLegalActions } from '../../src/poker/betting.js'
import { applyPokerAction } from '../../src/poker/poker-engine.js'
import type { PokerCommand } from '../../src/poker/commands.js'
import { assignLogicalPositions } from '../../src/poker/positioning.js'
import { createPokerTableState } from '../../src/poker/state.js'
import { createPlayerDecisionIdentity } from '../../src/sessions/authoritative-state/decision-identity.js'
import { createPrivateEvent } from '../../src/sessions/authoritative-state/private-event.js'
import type { BuildPlayerObservationInput } from '../../src/sessions/authoritative-state/player-observation-builder.js'
import { createPrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'

const SESSION_ID = '20000000-0000-4000-8000-000000000001'
const HAND_ID = '30000000-0000-4000-8000-000000000001'
const DECISION_REQUEST_ID = '40000000-0000-4000-8000-000000000001'

function participantIdForSeat(seatNumber: number): string {
  return `50000000-0000-4000-8000-${String(seatNumber + 1).padStart(12, '0')}`
}

export interface PlayerObservationFixture {
  readonly input: BuildPlayerObservationInput
  readonly expectedHeroCards: readonly [
    (typeof STANDARD_DECK)[number],
    (typeof STANDARD_DECK)[number],
  ]
}

export function createPlayerObservationFixture(
  input: {
    readonly playerCount?: 6 | 7 | 8 | 9
    readonly actorSeat?: number
    readonly withPublicAction?: boolean
    readonly publicAction?: PokerCommand['action']
  } = {},
): PlayerObservationFixture {
  const playerCount = input.playerCount ?? 6
  const hasPublicAction =
    input.withPublicAction || input.publicAction !== undefined
  const targetActorSeat = input.actorSeat ?? 3
  const initialActorSeat = 3
  if (targetActorSeat <= 0 || targetActorSeat >= playerCount) {
    throw new RangeError('测试行动座位无效。')
  }
  const participantSeatNumbers = Array.from(
    { length: playerCount },
    (_, seatNumber) => seatNumber,
  )
  const seats = participantSeatNumbers.map((seatNumber) => ({
    seatNumber,
    playerId: participantIdForSeat(seatNumber),
    isUser: seatNumber === 0,
    stack: seatNumber === 1 ? 1_990 : seatNumber === 2 ? 1_980 : 2_000,
    status: 'active' as const,
    streetContribution: seatNumber === 1 ? 10 : seatNumber === 2 ? 20 : 0,
    totalContribution: seatNumber === 1 ? 10 : seatNumber === 2 ? 20 : 0,
  }))
  const holeCards = [
    ...participantSeatNumbers.slice(1),
    participantSeatNumbers[0]!,
  ].map((seatNumber) => ({
    seatNumber,
    cards: [STANDARD_DECK[seatNumber * 2]!, STANDARD_DECK[seatNumber * 2 + 1]!],
  }))
  const initialPoker = createPokerTableState({
    pokerPhase: 'inHand',
    seats,
    buttonSeatNumber: 0,
    blinds: { smallBlind: 10, bigBlind: 20 },
    hand: {
      handId: HAND_ID,
      street: 'preflop',
      remainingDeck: [],
      burnedCards: [],
      board: [],
      holeCards,
      currentActorSeatNumber: initialActorSeat,
      pot: 30,
      bettingRound: {
        currentBet: 20,
        minimumFullRaiseIncrement: 20,
        seatStates: [
          ...participantSeatNumbers.slice(1),
          participantSeatNumbers[0]!,
        ].map((seatNumber) => ({
          seatNumber,
          betLevelAfterLastAction: null,
        })),
      },
    },
  })
  const handStarted = createPrivateEvent({
    type: 'handStarted',
    startedHand: {
      handId: HAND_ID,
      handNumber: 1,
      participantSeatNumbers,
      buttonSeatNumber: 0,
      smallBlindSeatNumber: 1,
      bigBlindSeatNumber: 2,
      positions: assignLogicalPositions(0, participantSeatNumbers),
      startingStacks: participantSeatNumbers.map((seatNumber) => ({
        seatNumber,
        stack: 2_000,
      })),
    },
  })
  const eventRows: BuildPlayerObservationInput['events'][number][] = [
    {
      handId: HAND_ID,
      eventSeq: 1,
      stateVersionBefore: 0,
      stateVersionAfter: 1,
      event: handStarted,
    },
  ]
  let poker = initialPoker
  let stateVersion = 1
  let asOfEventSeq = 1
  const commitAction = (action: PokerCommand['action']) => {
    const currentActorSeatNumber = poker.hand?.currentActorSeatNumber
    if (
      currentActorSeatNumber === null ||
      currentActorSeatNumber === undefined
    ) {
      throw new Error('测试当前行动者缺失。')
    }
    const result = applyPokerAction(poker, {
      actorSeatNumber: currentActorSeatNumber,
      action,
    })
    const actionEvent = result.eventDrafts.find(
      (event) => event.type === 'actionCommitted',
    )
    if (actionEvent === undefined || result.state.hand === null) {
      throw new Error('测试行动事件构造失败。')
    }
    const stateVersionBefore = stateVersion
    poker = result.state
    stateVersion += 1
    asOfEventSeq += 1
    eventRows.push({
      handId: HAND_ID,
      eventSeq: asOfEventSeq,
      stateVersionBefore,
      stateVersionAfter: stateVersion,
      event: createPrivateEvent(actionEvent),
    })
  }
  if (hasPublicAction) {
    commitAction(input.publicAction ?? { type: 'fold' })
  } else {
    while (poker.hand?.currentActorSeatNumber !== targetActorSeat) {
      const legalActions = getLegalActions(poker)
      const action = legalActions.some((candidate) => candidate.type === 'call')
        ? ({ type: 'call' } as const)
        : ({ type: 'check' } as const)
      commitAction(action)
    }
  }
  const actorSeat = poker.hand?.currentActorSeatNumber
  if (actorSeat === null || actorSeat === undefined || actorSeat === 0) {
    throw new Error('测试当前行动者无效。')
  }
  const state = createPrivateTableState({
    stateVersion,
    poker,
    completedHandCount: 0,
    seatAccounting: participantSeatNumbers.map((seatNumber) => ({
      seatNumber,
      cumulativeBuyIn: 2_000,
    })),
    lastCompletedHandSummary: null,
  })
  const identity = createPlayerDecisionIdentity({
    sessionId: SESSION_ID,
    handId: HAND_ID,
    stateVersion,
    actorParticipantId: participantIdForSeat(actorSeat),
    actorSeat,
    decisionRequestId: DECISION_REQUEST_ID,
  })
  const expectedHeroCards = holeCards.find(
    (entry) => entry.seatNumber === actorSeat,
  )?.cards
  if (expectedHeroCards === undefined) {
    throw new Error('测试 Hero 底牌缺失。')
  }
  return {
    input: {
      state,
      events: eventRows,
      identity,
      actor: {
        participantId: identity.actorParticipantId,
        seatNumber: actorSeat,
        participantType: 'agent',
      },
      asOfEventSeq,
    },
    expectedHeroCards: [expectedHeroCards[0]!, expectedHeroCards[1]!],
  }
}
