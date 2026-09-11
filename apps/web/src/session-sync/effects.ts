import type { PublicSessionSnapshot } from '@tx-holdem-coach/contracts'

export type TableEffect =
  | { type: 'deal'; positions: string[] }
  | { type: 'chips'; seats: number[]; pot: boolean }
  | { type: 'turn'; seatNumber: number }
  | { type: 'settlement'; handId: string }
export type EffectBatch = {
  sessionId: string
  handId: string | null
  stateVersion: number
  effects: TableEffect[]
}
/** 只描述公开展示差异，不保留牌值、金额或推演中间行动。 */
export function describeEffects(
  previous: PublicSessionSnapshot,
  next: PublicSessionSnapshot,
): EffectBatch {
  const effects: TableEffect[] = []
  const newHand = next.hand && previous.hand?.handId !== next.hand.handId
  const positions: string[] = []
  if (newHand) {
    next.seats
      .filter((seat) => seat.status !== 'out')
      .forEach((seat) => {
        positions.push(`seat:${seat.seatNumber}`)
      })
  }
  for (
    let index = newHand ? 0 : (previous.hand?.board.length ?? 0);
    index < (next.hand?.board.length ?? 0);
    index++
  )
    positions.push(`board:${index}`)
  if (positions.length) effects.push({ type: 'deal', positions })
  const seats = next.seats
    .filter(
      (seat) =>
        previous.seats.find((old) => old.seatNumber === seat.seatNumber)
          ?.stack !== seat.stack,
    )
    .map((seat) => seat.seatNumber)
  const pot = previous.hand?.pot !== next.hand?.pot
  if (seats.length || pot) effects.push({ type: 'chips', seats, pot })
  const actor = next.hand?.currentActorSeatNumber
  if (
    actor != null &&
    (newHand || actor !== previous.hand?.currentActorSeatNumber)
  )
    effects.push({ type: 'turn', seatNumber: actor })
  if (
    next.lastCompletedHandSummary &&
    next.lastCompletedHandSummary.handId !==
      previous.lastCompletedHandSummary?.handId
  )
    effects.push({
      type: 'settlement',
      handId: next.lastCompletedHandSummary.handId,
    })
  return {
    sessionId: next.sessionId,
    handId: next.hand?.handId ?? null,
    stateVersion: next.stateVersion,
    effects,
  }
}
