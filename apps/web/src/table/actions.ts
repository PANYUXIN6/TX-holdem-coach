import type { PublicSessionSnapshot } from '@tx-holdem-coach/contracts'
export type TableAction =
  | {
      type: 'fold' | 'check' | 'call' | 'allIn' | 'startNextHand' | 'endSession'
    }
  | { type: 'rebuy'; amount: number }
export const positiveAmount = (input: string, min: number, max: number) => {
  const amount = Number(input)
  return /^[1-9]\d*$/.test(input) &&
    Number.isSafeInteger(amount) &&
    amount >= min &&
    amount <= max
    ? amount
    : null
}
export const betweenHands = (s: PublicSessionSnapshot) =>
  s.lifecycleStatus === 'active' &&
  s.pokerPhase === 'betweenHands' &&
  s.hand === null &&
  s.agentRunState === 'idle'
export const heroActions = (s: PublicSessionSnapshot) =>
  s.lifecycleStatus === 'active' &&
  s.pokerPhase === 'inHand' &&
  s.agentRunState === 'idle' &&
  s.hand?.currentActorSeatNumber === 0
    ? s.hand.legalActions
    : []
export const rebuyLimit = (stack: number) => Math.max(0, 2000 - stack)
