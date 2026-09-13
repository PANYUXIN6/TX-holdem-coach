import type { PublicSessionSnapshot } from '@tx-holdem-coach/contracts'
const anchors: Record<number, readonly string[]> = {
  6: ['lower-left', 'upper-left', 'top-left', 'top-right', 'lower-right'],
  7: [
    'lower-left',
    'upper-left',
    'top-left',
    'top-right',
    'upper-right',
    'lower-right',
  ],
  8: [
    'lower-left',
    'middle-left',
    'upper-left',
    'top-left',
    'top-right',
    'upper-right',
    'lower-right',
  ],
  9: [
    'lower-left',
    'middle-left',
    'upper-left',
    'top-left',
    'top-right',
    'upper-right',
    'middle-right',
    'lower-right',
  ],
}
export function seatAnchors(seats: PublicSessionSnapshot['seats']) {
  const ordered = [...seats].sort((a, b) => a.seatNumber - b.seatNumber)
  return new Map(
    ordered.map((seat, index) => [
      seat.seatNumber,
      seat.isUser ? 'hero' : anchors[seats.length]![index - 1]!,
    ]),
  )
}
export const streetLabel = {
  postingBlinds: '下盲注',
  showdown: '摊牌',
  complete: '本手结束',
  preflop: '翻前',
  flop: '翻牌',
  turn: '转牌',
  river: '河牌',
}
export function tableStatus(snapshot: PublicSessionSnapshot) {
  if (snapshot.lifecycleStatus === 'ended') return '场次已结束'
  if (!snapshot.hand)
    return snapshot.lastCompletedHandSummary ? '本手已结束' : '尚无已完成手牌'
  if (snapshot.agentRunState === 'paused') return 'AI 已暂停'
  const actor = snapshot.seats.find(
    (seat) => seat.seatNumber === snapshot.hand?.currentActorSeatNumber,
  )
  if (snapshot.agentRunState === 'thinking')
    return `${actor?.displayName ?? 'AI'} 思考中`
  return actor?.isUser ? '轮到你' : `等待${actor?.displayName ?? '对手'}行动`
}
