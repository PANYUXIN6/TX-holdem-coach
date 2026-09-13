import {
  PublicSessionSnapshotSchema,
  type PublicSessionSnapshot,
  type PublicTableDisplay,
} from '@tx-holdem-coach/contracts'
import { ids, publicSnapshot } from './fixtures.js'
const positions: Record<
  number,
  NonNullable<PublicTableDisplay['hand']>['seats'][number]['position'][]
> = {
  6: ['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO'],
  7: ['BTN', 'SB', 'BB', 'UTG', 'LJ', 'HJ', 'CO'],
  8: ['BTN', 'SB', 'BB', 'UTG', 'MP', 'LJ', 'HJ', 'CO'],
  9: ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'MP', 'LJ', 'HJ', 'CO'],
}
export function tableSnapshot(
  count = 9,
  sparse = false,
): PublicSessionSnapshot {
  const numbers = sparse
    ? [0, 1, 3, 4, 6, 8]
    : Array.from({ length: count }, (_, i) => i)
  return PublicSessionSnapshotSchema.parse({
    ...publicSnapshot,
    stateVersion: 1,
    eventSeq: 1,
    seats: numbers.map((seatNumber, index) => ({
      ...publicSnapshot.seats[index % 6],
      seatNumber,
      isUser: index === 0,
      displayName:
        index === 0
          ? '你'
          : [
              '林间听雨',
              '陈默',
              '苏青',
              '远山',
              '阿哲',
              '北辰',
              '陆舟',
              '拾光',
            ][index - 1],
      stack: index === 1 ? 1990 : index === 2 ? 1980 : 2000,
    })),
    hand: {
      ...publicSnapshot.hand,
      currentActorSeatNumber: numbers[3],
      legalActions: [],
      pot: 30,
    },
    tableDisplay: {
      completedHandCount: 0,
      blinds: { smallBlind: 10, bigBlind: 20 },
      hand: {
        handId: ids.hand,
        buttonSeatNumber: 0,
        seats: numbers.map((seatNumber, index) => ({
          seatNumber,
          position: positions[numbers.length]![index],
          streetContribution: index === 1 ? 10 : index === 2 ? 20 : 0,
        })),
        potBreakdown: {
          pots: [{ potIndex: 0, kind: 'main', amount: 20 }],
          unmatchedContribution: { seatNumber: numbers[2], amount: 10 },
        },
      },
    },
  })
}
export function completeTable(
  snapshot: PublicSessionSnapshot,
): PublicSessionSnapshot {
  const seats = snapshot.seats
  const board = [
    { rank: '2', suit: 'clubs' },
    { rank: '4', suit: 'diamonds' },
    { rank: '6', suit: 'hearts' },
    { rank: '8', suit: 'spades' },
    { rank: 'T', suit: 'clubs' },
  ]
  const amounts = [
    seats.length * 100,
    (seats.length - 1) * 100,
    (seats.length - 2) * 100,
  ]
  const winner = seats.at(-1)!.seatNumber
  return PublicSessionSnapshotSchema.parse({
    ...snapshot,
    seats: seats.map((seat, i) => ({
      ...seat,
      stack:
        2000 -
        Math.min(i + 1, 3) * 100 +
        (seat.seatNumber === winner ? amounts.reduce((a, b) => a + b, 0) : 0),
    })),
    hand: null,
    pokerPhase: 'betweenHands',
    agentRunState: 'idle',
    activeDecision: null,
    tableDisplay: {
      completedHandCount: 1,
      blinds: { smallBlind: 10, bigBlind: 20 },
      hand: null,
    },
    lastCompletedHandSummary: {
      handId: snapshot.hand!.handId,
      terminationReason: 'showdown',
      participantSeatNumbers: seats.map((s) => s.seatNumber),
      buttonSeatNumber: 0,
      smallBlindSeatNumber: seats[1]!.seatNumber,
      bigBlindSeatNumber: seats[2]!.seatNumber,
      positions: snapshot.tableDisplay!.hand!.seats.map(
        ({ seatNumber, position }) => ({ seatNumber, position }),
      ),
      board,
      seatResults: seats.map((s, i) => ({
        seatNumber: s.seatNumber,
        startingStack: 2000,
        endingStack:
          2000 -
          Math.min(i + 1, 3) * 100 +
          (s.seatNumber === winner ? amounts.reduce((a, b) => a + b, 0) : 0),
        totalContribution: Math.min(i + 1, 3) * 100,
        netChange:
          -Math.min(i + 1, 3) * 100 +
          (s.seatNumber === winner ? amounts.reduce((a, b) => a + b, 0) : 0),
      })),
      uncalledBetReturns: [],
      pots: amounts.map((amount, potIndex) => ({
        potIndex,
        kind: potIndex === 0 ? 'main' : 'side',
        amount,
        winningSeatNumbers: [winner],
        awards: [{ seatNumber: winner, amount }],
      })),
      revealedHands: seats.map((s, i) => ({
        seatNumber: s.seatNumber,
        holeCards: [
          {
            rank:
              i === seats.length - 1
                ? '2'
                : ['A', 'K', 'Q', 'J', '9', '7', '5', '3'][i],
            suit: 'hearts',
          },
          {
            rank:
              i === seats.length - 1
                ? '2'
                : ['A', 'K', 'Q', 'J', '9', '7', '5', '3'][i],
            suit: 'diamonds',
          },
        ],
        handEvaluation: {
          category: i === seats.length - 1 ? 'threeOfAKind' : 'onePair',
          bestFive: [
            ...(i === seats.length - 1
              ? [board[0], board[3], board[4]]
              : board.slice(2)),
            {
              rank:
                i === seats.length - 1
                  ? '2'
                  : ['A', 'K', 'Q', 'J', '9', '7', '5', '3'][i],
              suit: 'hearts',
            },
            {
              rank:
                i === seats.length - 1
                  ? '2'
                  : ['A', 'K', 'Q', 'J', '9', '7', '5', '3'][i],
              suit: 'diamonds',
            },
          ],
        },
      })),
    },
  })
}

/** 固定九席、多池、奇数筹码平分与未跟注返还的公开结算样本。 */
export function splitTable(): PublicSessionSnapshot {
  const snapshot = completeTable(tableSnapshot(9))
  const summary = snapshot.lastCompletedHandSummary!
  summary.pots[0] = {
    potIndex: 0,
    kind: 'main',
    amount: 899,
    winningSeatNumbers: [0, 8],
    awards: [
      { seatNumber: 8, amount: 450 },
      { seatNumber: 0, amount: 449 },
    ],
  }
  summary.uncalledBetReturns = [{ seatNumber: 1, amount: 1 }]
  for (const result of summary.seatResults) {
    const difference =
      result.seatNumber === 0
        ? 449
        : result.seatNumber === 1
          ? 1
          : result.seatNumber === 8
            ? -450
            : 0
    result.endingStack += difference
    result.netChange += difference
  }
  snapshot.seats = snapshot.seats.map((seat) => ({
    ...seat,
    stack: summary.seatResults.find(
      (result) => result.seatNumber === seat.seatNumber,
    )!.endingStack,
  }))
  summary.revealedHands = summary.revealedHands.map((hand) =>
    hand.seatNumber === 1
      ? { ...hand, holeCards: null, handEvaluation: null }
      : hand,
  )
  return PublicSessionSnapshotSchema.parse(snapshot)
}
