import { expect, test } from 'vitest'
import { seatAnchors, tableStatus } from '../src/table/presentation.js'
import { PublicSessionSnapshotSchema } from '@tx-holdem-coach/contracts'
import { publicSnapshot as rawSnapshot } from './fixtures.js'
const publicSnapshot = PublicSessionSnapshotSchema.parse(rawSnapshot)
test('六至九人锚点按真实座位稳定映射，稀疏座位不压缩身份', () => {
  const expected = [
    [
      'hero',
      'lower-left',
      'upper-left',
      'top-left',
      'top-right',
      'lower-right',
    ],
    [
      'hero',
      'lower-left',
      'upper-left',
      'top-left',
      'top-right',
      'upper-right',
      'lower-right',
    ],
    [
      'hero',
      'lower-left',
      'middle-left',
      'upper-left',
      'top-left',
      'top-right',
      'upper-right',
      'lower-right',
    ],
    [
      'hero',
      'lower-left',
      'middle-left',
      'upper-left',
      'top-left',
      'top-right',
      'upper-right',
      'middle-right',
      'lower-right',
    ],
  ]
  for (let count = 6; count <= 9; count++) {
    const seats = Array.from({ length: count }, (_, seatNumber) => ({
      ...publicSnapshot.seats[seatNumber % 6]!,
      seatNumber,
      isUser: seatNumber === 0,
    }))
    expect([...seatAnchors(seats).values()]).toEqual(expected[count - 6])
    expect(
      seatAnchors(seats.map((seat) => ({ ...seat, stack: 0, status: 'out' }))),
    ).toEqual(seatAnchors(seats))
  }
  const sparse = publicSnapshot.seats.map((seat, index) => ({
    ...seat,
    seatNumber: [0, 1, 3, 4, 6, 8][index]!,
  }))
  expect([...seatAnchors(sparse)]).toEqual([
    [0, 'hero'],
    [1, 'lower-left'],
    [3, 'upper-left'],
    [4, 'top-left'],
    [6, 'top-right'],
    [8, 'lower-right'],
  ])
})
test('空摘要结束不伪造完成手，AI idle 不显示思考', () => {
  expect(
    tableStatus({ ...publicSnapshot, lifecycleStatus: 'ended', hand: null }),
  ).toBe('场次已结束')
  expect(
    tableStatus({
      ...publicSnapshot,
      hand: null,
      lastCompletedHandSummary: null,
    }),
  ).toBe('尚无已完成手牌')
  expect(
    tableStatus({
      ...publicSnapshot,
      agentRunState: 'idle',
      hand: { ...publicSnapshot.hand!, currentActorSeatNumber: 1 },
    }),
  ).toContain('等待')
})
